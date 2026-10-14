import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAuthCoreError } from './errors.js';
import type { CredentialProfile, RedactedStatus } from './types.js';

export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const REQUIRED_PLAN_SCOPES = Object.freeze([
  'resource.invoke', 'chatgpt.tokens.use.direct', 'offline_access',
]);
export const REQUESTED_SCOPES = Object.freeze([
  'openid', 'profile', 'email', ...REQUIRED_PLAN_SCOPES,
]);

export function generatePkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceS256(verifier), method: 'S256' };
}
export function pkceS256(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthCoreError('INVALID_CONFIG');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
export function generateState(): string { return randomBytes(32).toString('base64url'); }
export function generateNonce(): string { return randomBytes(32).toString('base64url'); }
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Supported official UUID alternative to optional RFC9278 public-key thumbprints. */
export function generateHostId(): string { return `urn:uuid:${randomUUID()}`; }
export function validateHostId(hostId: string): string {
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(hostId)) {
    throw new OAuthCoreError('INVALID_CONFIG');
  }
  return hostId;
}

/** Fail closed on noncanonical IPv4 aliases, URL credentials, percent escapes and dot paths. */
export function validateCallbackUri(uri: string): string {
  let url: URL;
  try { url = new URL(uri); } catch { throw new OAuthCoreError('INVALID_CONFIG'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      Number(url.port) < 1 || Number(url.port) > 65535 || url.username || url.password ||
      url.search || url.hash || !/^\/[A-Za-z0-9_/-]+$/.test(url.pathname) ||
      url.pathname.includes('//') || url.href !== uri) {
    throw new OAuthCoreError('INVALID_CONFIG');
  }
  return uri;
}

/** The callback's only variable part is its query string; duplicates fail closed. */
export function parseCallback(callback: string, exactUri: string): URLSearchParams {
  validateCallbackUri(exactUri);
  let url: URL;
  try { url = new URL(callback); } catch { throw new OAuthCoreError('INVALID_CALLBACK'); }
  const queryIndex = callback.indexOf('?');
  const rawBase = queryIndex < 0 ? callback : callback.slice(0, queryIndex);
  if (rawBase !== exactUri || `${url.origin}${url.pathname}` !== exactUri ||
      url.username || url.password || url.hash) throw new OAuthCoreError('INVALID_CALLBACK');
  const keys = new Set<string>();
  for (const [key] of url.searchParams) {
    if (keys.has(key)) throw new OAuthCoreError('INVALID_CALLBACK');
    keys.add(key);
  }
  return url.searchParams;
}

export function parseGrantedScopes(scope: string): string[] {
  if (typeof scope !== 'string' || scope.length > 8192 ||
      !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(scope)) {
    throw new OAuthCoreError('TOKEN_RESPONSE_INVALID');
  }
  return [...new Set(scope.split(' '))].sort();
}
export function requirePlanScopes(scopes: readonly string[]): void {
  if (REQUIRED_PLAN_SCOPES.some(scope => !scopes.includes(scope))) {
    throw new OAuthCoreError('INSUFFICIENT_SCOPE');
  }
}
export function profileIdFor(issuer: string, clientId: string, subject: string): string {
  return createHash('sha256').update(JSON.stringify([issuer, clientId, subject])).digest('hex');
}
export function redactStatus(profile: CredentialProfile, now = Date.now()): RedactedStatus {
  return {
    profile_id: profile.profile_id,
    state: profile.needs_login ? 'needs_login' : profile.expires_at <= now ? 'expired' : 'ready',
    scopes: [...profile.scopes], expires_at: profile.expires_at, saved_at: profile.saved_at,
  };
}
export function isIssuedClientId(clientId: unknown): clientId is string {
  return typeof clientId === 'string' && clientId !== DYNAMIC_CLIENT_ID &&
    /^[A-Za-z0-9_-]{1,256}$/.test(clientId);
}

/** On-disk schema validation does not re-verify JWTs; only trusted core commits new credentials. */
export function validateProfile(value: unknown): asserts value is CredentialProfile {
  if (typeof value !== 'object' || value === null) throw new OAuthCoreError('STORE_UNSAFE');
  const p = value as Partial<CredentialProfile>;
  const strings = [p.issuer, p.subject, p.client_id, p.ext_agent_host_id, p.id_token, p.access_token, p.refresh_token];
  if (p.version !== 1 || strings.some(v => typeof v !== 'string' || !v || v.length > 65536) ||
      p.token_type !== 'Bearer' || !isIssuedClientId(p.client_id) ||
      typeof p.subject !== 'string' || typeof p.issuer !== 'string' ||
      p.profile_id !== profileIdFor(p.issuer, p.client_id, p.subject) ||
      !Array.isArray(p.scopes) || p.scopes.some(s => typeof s !== 'string') ||
      typeof p.expires_at !== 'number' || !Number.isSafeInteger(p.expires_at) || p.expires_at < 0 ||
      typeof p.saved_at !== 'number' || !Number.isSafeInteger(p.saved_at) || p.saved_at < 0 ||
      typeof p.needs_login !== 'boolean' || (p.email !== undefined && typeof p.email !== 'string')) {
    throw new OAuthCoreError('STORE_UNSAFE');
  }
  validateHostId(p.ext_agent_host_id as string);
  requirePlanScopes(p.scopes);
}
