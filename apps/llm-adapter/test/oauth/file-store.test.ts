import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileCredentialStore, profileIdFor } from '../../src/oauth/index.js';
import { authorize, expectError, withHarness, withTemp } from './helpers.js';

test('dedicated store directory 0700 and credentials/host 0600; stable host survives restart', async () => {
  await withTemp(async root => {
    const path = join(root, 'credentials');
    let store = await FileCredentialStore.open(path);
    const hostId = await store.getOrCreateHostId();
    assert.ok(await store.getOrCreateHostId() === hostId);
    assert.equal((await lstat(path)).mode & 0o7777, 0o700);
    assert.equal((await lstat(join(path, 'host-id.json'))).mode & 0o7777, 0o600);
    await expectError(() => FileCredentialStore.open(path), 'OWNER_CONFLICT');
    await store.close();
    store = await FileCredentialStore.open(path);
    try { assert.ok(await store.getOrCreateHostId() === hostId); }
    finally { await store.close(); }
  });
  await withHarness(async h => {
    const id = await authorize(h);
    assert.equal((await lstat(join(h.store.directory, `${id}.json`))).mode & 0o7777, 0o600);
    assert.deepEqual((await readdir(h.store.directory)).sort(), [`${id}.json`, 'host-id.json'].sort());
  });
});

test('closing store is idempotent and cannot release a later owner or accept new writes', async () => {
  await withTemp(async root => {
    const path = join(root, 'credentials');
    const old = await FileCredentialStore.open(path);
    const closing = old.close();
    assert.ok(old.close() === closing);
    await expectError(() => old.getOrCreateHostId(), 'CLOSED');
    await closing;
    const current = await FileCredentialStore.open(path);
    try {
      await old.close();
      await expectError(() => FileCredentialStore.open(path), 'OWNER_CONFLICT');
      await current.getOrCreateHostId();
    } finally { await current.close(); }
  });
});

test('registrations use distinct profile files, even with same email and subject', async () => {
  await withHarness(async h => {
    const id = await authorize(h);
    const profile = await h.store.load(id);
    assert.ok(profile);
    const second = { ...profile, client_id: 'oaiapp_other' };
    second.profile_id = profileIdFor(second.issuer, second.client_id, second.subject);
    await h.store.save(second);
    assert.equal((await h.store.listProfileIds()).length, 2);
    assert.ok((await h.store.load(id))?.client_id === 'oaiapp_synthetic');
    assert.ok((await h.store.load(second.profile_id))?.client_id === 'oaiapp_other');
  });
});

test('atomic serial writes expose only complete coherent credential sets to concurrent readers', async () => {
  await withHarness(async h => {
    const id = await authorize(h);
    const initial = await h.store.load(id);
    assert.ok(initial);
    const initialPair = `${initial.access_token}:${initial.refresh_token}`;
    const allowed = new Set([initialPair]);
    const writes = Array.from({ length: 30 }, (_, i) => {
      const pair = [`synthetic-access-${i}`, `synthetic-refresh-${i}`];
      allowed.add(`${pair[0]}:${pair[1]}`);
      return h.store.save({ ...initial, access_token: pair[0] as string, refresh_token: pair[1] as string, expires_at: initial.expires_at + i });
    });
    const readers = Array.from({ length: 10 }, async () => {
      for (let i = 0; i < 20; i++) {
        const current = await h.store.load(id);
        assert.ok(current && allowed.has(`${current.access_token}:${current.refresh_token}`));
      }
    });
    await Promise.all([...writes, ...readers]);
    assert.ok((await h.store.load(id))?.refresh_token === 'synthetic-refresh-29');
    assert.equal((await lstat(join(h.store.directory, `${id}.json`))).mode & 0o7777, 0o600);
    assert.ok((await readdir(h.store.directory)).every(name => !name.startsWith('.atomic-')));
  });
});

test('aborted atomic update preserves previous file and removes only its own verified temp', async () => {
  await withHarness(async h => {
    const id = await authorize(h);
    const profile = await h.store.load(id);
    assert.ok(profile);
    const before = await readFile(join(h.store.directory, `${id}.json`));
    const controller = new AbortController();
    controller.abort();
    await expectError(() => h.store.save({ ...profile, access_token: 'synthetic-not-committed' }, controller.signal), 'CANCELLED');
    assert.ok((await readFile(join(h.store.directory, `${id}.json`))).equals(before));
    assert.ok((await readdir(h.store.directory)).every(name => !name.startsWith('.atomic-')));
  });
});

test('unsafe existing directory/file permissions are rejected without modifying credentials', async () => {
  await withTemp(async root => {
    const path = join(root, 'unsafe');
    await mkdir(path, { mode: 0o755 });
    await chmod(path, 0o755);
    await expectError(() => FileCredentialStore.open(path), 'STORE_UNSAFE');
  });
  await withHarness(async h => {
    const id = await authorize(h);
    const profile = await h.store.load(id);
    assert.ok(profile);
    const path = join(h.store.directory, `${id}.json`);
    const before = await readFile(path);
    await chmod(path, 0o644);
    await expectError(() => h.store.load(id), 'STORE_UNSAFE');
    await expectError(() => h.store.save(profile), 'STORE_UNSAFE');
    assert.ok((await readFile(path)).equals(before));
  });
});

test('symlink directories and profile files cannot escape the dedicated store', async () => {
  await withTemp(async root => {
    const real = join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    const alias = join(root, 'alias');
    await symlink(real, alias);
    await expectError(() => FileCredentialStore.open(alias), 'STORE_UNSAFE');
    const store = await FileCredentialStore.open(real);
    try {
      const id = 'a'.repeat(64);
      const synthetic = join(root, 'synthetic.json');
      await writeFile(synthetic, '{}', { mode: 0o600 });
      await symlink(synthetic, join(real, `${id}.json`));
      await expectError(() => store.load(id), 'STORE_UNSAFE');
      await expectError(() => store.load('../synthetic'), 'STORE_UNSAFE');
      assert.equal(await readFile(synthetic, 'utf8'), '{}');
    } finally { await store.close(); }
  });
});

test('malformed profile or profile-ID mismatch rejects protected local files', async () => {
  await withTemp(async root => {
    const store = await FileCredentialStore.open(join(root, 'credentials'));
    try {
      const id = 'b'.repeat(64);
      await writeFile(join(store.directory, `${id}.json`), '{"access_token":"synthetic"}', { mode: 0o600 });
      await expectError(() => store.load(id), 'STORE_UNSAFE');
    } finally { await store.close(); }
  });
});
