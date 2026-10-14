import assert from 'node:assert/strict';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  FileCredentialStore, OAuthCore, OAuthCoreError, REQUESTED_SCOPES,
} from '../../src/oauth/index.js';
import type {
  CodeExchangeRequest, IdTokenVerificationContext, IdTokenVerifier, RefreshRequest,
  TokenResponse, TokenTransport, VerifiedIdToken,
} from '../../src/oauth/index.js';

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function expectError(action: () => unknown, code: string, retryable?: boolean): Promise<void> {
  await assert.rejects(async () => { await action(); }, (error: unknown) => {
    assert.ok(error instanceof OAuthCoreError);
    assert.equal(error.code, code);
    if (retryable !== undefined) assert.equal(error.retryable, retryable);
    return true;
  });
}

/** Every recursive cleanup is confined to this verified independently-created mkdtemp. */
export async function withTemp<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'oauth-core-test-'));
  const initial = await lstat(root);
  try { return await operation(root); }
  finally {
    const absolute = resolve(root);
    assert.equal(absolute, root);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('oauth-core-test-'));
    const current = await lstat(absolute);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, initial.dev);
    assert.equal(current.ino, initial.ino);
    // Target is verified immediately before delete, never derived from unchecked env/config.
    await rm(absolute, { recursive: true, force: false });
  }
}

export class MockTransport implements TokenTransport {
  readonly exchanges: CodeExchangeRequest[] = [];
  readonly refreshRequests: RefreshRequest[] = [];
  response: TokenResponse = {
    access_token: 'synthetic-access-initial', refresh_token: 'synthetic-refresh-initial',
    id_token: 'synthetic-id-not-a-jwt', token_type: 'Bearer', expires_in: 3600,
    scope: REQUESTED_SCOPES.join(' '),
  };
  exchangeHandler?: (request: CodeExchangeRequest) => Promise<TokenResponse>;
  refreshHandler?: (request: RefreshRequest) => Promise<TokenResponse>;
  async exchangeCode(request: CodeExchangeRequest): Promise<TokenResponse> {
    this.exchanges.push(request);
    return this.exchangeHandler ? this.exchangeHandler(request) : structuredClone(this.response);
  }
  async refresh(request: RefreshRequest): Promise<TokenResponse> {
    this.refreshRequests.push(request);
    return this.refreshHandler ? this.refreshHandler(request) : {
      ...this.response, access_token: 'synthetic-access-rotated', refresh_token: 'synthetic-refresh-rotated',
    };
  }
}

/** Only an injected test double; does NOT claim to implement real JWT verification. */
export class MockVerifier implements IdTokenVerifier {
  readonly contexts: IdTokenVerificationContext[] = [];
  transform?: (identity: VerifiedIdToken) => VerifiedIdToken;
  failure?: Error;
  async verify(_token: string, context: IdTokenVerificationContext): Promise<VerifiedIdToken> {
    this.contexts.push(context);
    if (this.failure) throw this.failure;
    const identity: VerifiedIdToken = {
      issuer: context.issuer, audience: context.audience, subject: 'synthetic-subject',
      email: 'synthetic@example.invalid', expires_at: context.now_ms + 3_600_000,
      ...(context.nonce !== undefined ? { nonce: context.nonce } : {}),
      verification: { signature: true, trusted_jwks: true, allowed_algorithm: true, standard_claims: true },
    };
    return this.transform ? this.transform(identity) : identity;
  }
}

export interface Harness {
  root: string;
  store: FileCredentialStore;
  transport: MockTransport;
  verifier: MockVerifier;
  core: OAuthCore;
  now: number;
}
export const CALLBACK = 'http://127.0.0.1:1455/auth/callback';
export function callback(state: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ state, code: 'synthetic-code', client_id: 'oaiapp_synthetic', ...extra });
  return `${CALLBACK}?${params.toString()}`;
}
export async function withHarness(operation: (h: Harness) => Promise<void>): Promise<void> {
  await withTemp(async root => {
    const store = await FileCredentialStore.open(join(root, 'credentials'));
    const transport = new MockTransport();
    const verifier = new MockVerifier();
    const hostId = await store.getOrCreateHostId();
    const h = { root, store, transport, verifier, now: 1_800_000_000_000 } as Harness;
    h.core = new OAuthCore({
      issuer: 'https://auth.example.invalid', authorization_endpoint: 'https://auth.example.invalid/authorize',
      resource: 'https://api.example.invalid/v1', callback_uri: CALLBACK,
      ext_agent_host_id: hostId, agent_name: 'Synthetic OAuth Test', now: () => h.now,
    }, store, transport, verifier);
    try { await operation(h); }
    finally { await h.core.close(); await store.close(); }
  });
}
export async function authorize(h: Harness): Promise<string> {
  const attempt = await h.core.beginAuthorization();
  const status = await h.core.completeAuthorization(callback(attempt.state));
  return status.profile_id;
}
