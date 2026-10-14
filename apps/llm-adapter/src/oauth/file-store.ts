import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OAuthCoreError, throwIfAborted } from './errors.js';
import { generateHostId, validateHostId, validateProfile } from './security.js';
import type { CredentialProfile, CredentialStore } from './types.js';

const owners = new Set<string>();
function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function safeStoreError(error: unknown): OAuthCoreError {
  return error instanceof OAuthCoreError ? error : new OAuthCoreError('STORE_IO');
}

/**
 * One owner in ONE PROCESS only. No lockfile or cross-process refresh coordination.
 * Never share this directory with another process/container replica. Own a dedicated
 * app directory on a local POSIX filesystem with trusted parent directories.
 * Windows/non-POSIX permission semantics and hostile same-UID writers are unsupported.
 * Pending auth state is deliberately never persisted here.
 */
export class FileCredentialStore implements CredentialStore {
  readonly directory: string;
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private constructor(directory: string) { this.directory = directory; }

  static async open(directory: string): Promise<FileCredentialStore> {
    if (!isAbsolute(directory) || resolve(directory) === parse(directory).root) {
      throw new OAuthCoreError('STORE_UNSAFE');
    }
    const root = resolve(directory);
    if (owners.has(root)) throw new OAuthCoreError('OWNER_CONFLICT');
    owners.add(root);
    const store = new FileCredentialStore(root);
    try {
      await store.checkParents();
      try { await mkdir(root, { mode: 0o700 }); } catch (error) {
        if (!errno(error, 'EEXIST')) throw error;
      }
      await store.checkDirectory();
      return store;
    } catch (error) {
      owners.delete(root);
      throw safeStoreError(error);
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new OAuthCoreError('CLOSED');
  }
  private async checkParents(): Promise<void> {
    let path = dirname(this.directory);
    for (;;) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OAuthCoreError('STORE_UNSAFE');
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  private async checkDirectory(): Promise<void> {
    this.ensureOpen();
    await this.checkParents();
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 ||
        (process.getuid && stat.uid !== process.getuid())) throw new OAuthCoreError('STORE_UNSAFE');
  }
  private child(filename: string): string {
    if (!/^(?:[a-f0-9]{64}\.json|host-id\.json|\.atomic-[0-9a-f-]+)$/.test(filename)) {
      throw new OAuthCoreError('STORE_UNSAFE');
    }
    const target = resolve(this.directory, filename);
    this.assertTarget(target);
    return target;
  }
  /** Every rename/unlink target is checked immediately before the operation. */
  private assertTarget(target: string): void {
    if (!isAbsolute(target) || dirname(target) !== this.directory || resolve(target) !== target) {
      throw new OAuthCoreError('STORE_UNSAFE');
    }
  }
  private async checkFile(target: string): Promise<boolean> {
    this.assertTarget(target);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          (stat.mode & 0o7777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
        throw new OAuthCoreError('STORE_UNSAFE');
      }
      return true;
    } catch (error) {
      if (errno(error, 'ENOENT')) return false;
      throw error;
    }
  }
  private async readJson(filename: string): Promise<unknown | undefined> {
    await this.checkDirectory();
    const target = this.child(filename);
    if (!await this.checkFile(target)) return undefined;
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      // An already-open inode can lose its pathname during a valid atomic replacement.
      // Still reject hard links, but allow the safe old inode with nlink=0.
      if (!stat.isFile() || stat.nlink > 1 || (stat.mode & 0o7777) !== 0o600 ||
          stat.size > 1_048_576 || (process.getuid && stat.uid !== process.getuid())) {
        throw new OAuthCoreError('STORE_UNSAFE');
      }
      return JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
    } finally { await handle.close(); }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    if (this.closing) throw new OAuthCoreError('CLOSED');
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async atomicJson(filename: string, value: unknown, signal?: AbortSignal): Promise<void> {
    await this.checkDirectory();
    throwIfAborted(signal);
    const target = this.child(filename);
    await this.checkFile(target);
    const temp = this.child(`.atomic-${randomUUID()}`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      try {
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(value), { encoding: 'utf8' });
        await handle.sync();
      } finally { await handle.close(); }
      await this.checkDirectory();
      await this.checkFile(target);
      throwIfAborted(signal);
      this.assertTarget(temp);
      this.assertTarget(target);
      // Cancellation before this commit keeps the old file; a started rename is irrevocable.
      await rename(temp, target);
      renamed = true;
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (!renamed) {
        this.assertTarget(temp);
        try { await unlink(temp); } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
      }
    }
  }

  async load(profileId: string): Promise<CredentialProfile | undefined> {
    try {
      if (this.closing) throw new OAuthCoreError('CLOSED');
      const value = await this.readJson(`${profileId}.json`);
      if (value === undefined) return undefined;
      validateProfile(value);
      if (value.profile_id !== profileId) throw new OAuthCoreError('STORE_UNSAFE');
      return value;
    } catch (error) { throw safeStoreError(error); }
  }

  save(profile: CredentialProfile, signal?: AbortSignal): Promise<void> {
    validateProfile(profile);
    // Snapshot before queuing; a caller must not mutate tokens while a write awaits.
    const snapshot: CredentialProfile = structuredClone(profile);
    return this.serialize(async () => {
      try { await this.atomicJson(`${snapshot.profile_id}.json`, snapshot, signal); }
      catch (error) { throw safeStoreError(error); }
    });
  }

  getOrCreateHostId(): Promise<string> {
    return this.serialize(async () => {
      try {
        const saved = await this.readJson('host-id.json');
        if (saved !== undefined) {
          if (typeof saved !== 'object' || saved === null || !('host_id' in saved) || typeof saved.host_id !== 'string') {
            throw new OAuthCoreError('STORE_UNSAFE');
          }
          return validateHostId(saved.host_id);
        }
        const hostId = generateHostId();
        await this.atomicJson('host-id.json', { version: 1, host_id: hostId });
        return hostId;
      } catch (error) { throw safeStoreError(error); }
    });
  }

  async listProfileIds(): Promise<string[]> {
    try {
      if (this.closing) throw new OAuthCoreError('CLOSED');
      await this.checkDirectory();
      return (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => name.slice(0, -5)).sort();
    } catch (error) { throw safeStoreError(error); }
  }

  /** Call only after stopping the core and all consumers. No credential deletion. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(() => {
      this.closed = true;
      owners.delete(this.directory);
    });
    return this.closePromise;
  }
}
