import { AuthorizationCodeExchangeError, OAuthCoreError, TokenEndpointError, throwIfAborted } from './errors.js';
import {
  constantTimeEqual, DYNAMIC_CLIENT_ID, generateNonce, generatePkce, generateState,
  isIssuedClientId, parseCallback, parseGrantedScopes, profileIdFor, redactStatus,
  REQUESTED_SCOPES, requirePlanScopes, validateCallbackUri, validateHostId, validateProfile,
} from './security.js';
import type {
  AuthorizationAttempt, CredentialProfile, CredentialStore, IdTokenVerifier,
  OAuthCoreConfig, RedactedStatus, TokenResponse, TokenTransport, VerifiedIdToken,
} from './types.js';

interface PendingAttempt {
  state: string;
  nonce: string;
  verifier: string;
  expires_at: number;
  client_id: string;
  selected?: CredentialProfile;
  controller: AbortController;
}
const storeOwners = new WeakSet<CredentialStore>();

/**
 * Offline-capable protocol core, not a live OAuth service/listener/JWKS implementation.
 * One core owns one store in a single process. Cross-process use is NOT supported.
 * State/verifier/nonce exist in RAM only; cancellation, shutdown and restart invalidate
 * them. Never auto-resume callbacks after restart or import existing Codex tokens.
 */
export class OAuthCore {
  private readonly config: OAuthCoreConfig;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAttempt>();
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly refreshes = new Map<string, Promise<RedactedStatus>>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly refreshControllers = new Set<AbortController>();
  private readonly invalidatedProfiles = new Set<string>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly store: CredentialStore;
  private readonly transport: TokenTransport;
  private readonly verifier: IdTokenVerifier;

  constructor(config: OAuthCoreConfig, store: CredentialStore, transport: TokenTransport, verifier: IdTokenVerifier) {
    this.validateConfig(config);
    if (storeOwners.has(store)) throw new OAuthCoreError('OWNER_CONFLICT');
    storeOwners.add(store);
    this.config = { ...config };
    this.now = config.now ?? Date.now;
    this.store = store;
    this.transport = transport;
    this.verifier = verifier;
  }
  private validateConfig(config: OAuthCoreConfig): void {
    validateCallbackUri(config.callback_uri);
    validateHostId(config.ext_agent_host_id);
    try {
      const issuer = new URL(config.issuer);
      const authorization = new URL(config.authorization_endpoint);
      const resource = new URL(config.resource);
      if (issuer.protocol !== 'https:' || issuer.origin !== config.issuer ||
          authorization.protocol !== 'https:' || authorization.origin !== issuer.origin ||
          authorization.username || authorization.password || authorization.search || authorization.hash ||
          resource.protocol !== 'https:' || resource.username || resource.password || resource.hash ||
          !config.agent_name.trim() || config.agent_name.length > 128 ||
          !Number.isSafeInteger(config.pending_ttl_ms ?? 300_000) || (config.pending_ttl_ms ?? 300_000) <= 0 ||
          !Number.isSafeInteger(config.max_pending ?? 8) || (config.max_pending ?? 8) <= 0) {
        throw new OAuthCoreError('INVALID_CONFIG');
      }
    } catch { throw new OAuthCoreError('INVALID_CONFIG'); }
  }
  private ensureOpen(): void { if (this.closed) throw new OAuthCoreError('CLOSED'); }
  private ownProfile(profile: CredentialProfile): void {
    validateProfile(profile);
    if (profile.issuer !== this.config.issuer || profile.ext_agent_host_id !== this.config.ext_agent_host_id) {
      throw new OAuthCoreError('IDENTITY_MISMATCH');
    }
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const result = prior.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return result;
  }
  private prune(): void {
    for (const [state, attempt] of this.pending) {
      if (attempt.expires_at <= this.now()) {
        attempt.controller.abort();
        this.pending.delete(state);
        this.attempts.delete(state);
      }
    }
  }

  /** Listener must already be bound before the caller opens authorization_url. */
  beginAuthorization(profileId?: string): Promise<AuthorizationAttempt> {
    return this.startAuthorization(profileId);
  }

  /**
   * After a first-registration code failure, reuse AuthorizationCodeExchangeError.client_id
   * with fresh state/nonce/PKCE. No unverified identity or credentials are persisted.
   * For an already selected account use beginAuthorization(profileId) instead.
   */
  retryRegistration(issuedClientId: string): Promise<AuthorizationAttempt> {
    if (!isIssuedClientId(issuedClientId)) throw new OAuthCoreError('INVALID_CLIENT');
    return this.startAuthorization(undefined, issuedClientId);
  }

  private async startAuthorization(profileId?: string, registrationClientId?: string): Promise<AuthorizationAttempt> {
    this.ensureOpen();
    this.prune();
    let selected: CredentialProfile | undefined;
    if (profileId !== undefined) {
      selected = await this.store.load(profileId);
      if (!selected) throw new OAuthCoreError('PROFILE_NOT_FOUND');
      this.ownProfile(selected);
    }
    this.ensureOpen();
    if (this.attempts.size >= (this.config.max_pending ?? 8)) throw new OAuthCoreError('INVALID_STATE');
    const pkce = generatePkce();
    const attempt: PendingAttempt = {
      state: generateState(), nonce: generateNonce(), verifier: pkce.verifier,
      expires_at: this.now() + (this.config.pending_ttl_ms ?? 300_000),
      client_id: selected?.client_id ?? registrationClientId ?? DYNAMIC_CLIENT_ID,
      controller: new AbortController(),
      ...(selected ? { selected: structuredClone(selected) } : {}),
    };
    const url = new URL(this.config.authorization_endpoint);
    const params: Record<string, string> = {
      client_id: attempt.client_id,
      ext_agent_host_id: this.config.ext_agent_host_id,
      response_type: 'code', redirect_uri: this.config.callback_uri,
      scope: REQUESTED_SCOPES.join(' '), resource: this.config.resource,
      state: attempt.state, nonce: attempt.nonce, code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    };
    if (attempt.client_id === DYNAMIC_CLIENT_ID) params.agent_name_hint = this.config.agent_name;
    else if (selected) {
      params.id_token_hint = selected.id_token;
      if (selected.email) params.login_hint = selected.email;
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    this.pending.set(attempt.state, attempt);
    this.attempts.set(attempt.state, attempt);
    return { authorization_url: url.href, state: attempt.state, expires_at: attempt.expires_at };
  }

  /** Invalid/wrong states never reach exchange. Matching state is consumed even on failure. */
  completeAuthorization(callback: string): Promise<RedactedStatus> {
    this.ensureOpen();
    const params = parseCallback(callback, this.config.callback_uri);
    const state = params.get('state');
    const attempt = state ? this.pending.get(state) : undefined;
    if (!state || !attempt || !constantTimeEqual(state, attempt.state)) throw new OAuthCoreError('INVALID_STATE');
    this.pending.delete(state);
    if (attempt.expires_at <= this.now()) {
      this.attempts.delete(state);
      attempt.controller.abort();
      throw new OAuthCoreError('EXPIRED_STATE');
    }
    const perform = async (): Promise<RedactedStatus> => {
      try {
        throwIfAborted(attempt.controller.signal);
        if (attempt.expires_at <= this.now()) throw new OAuthCoreError('EXPIRED_STATE');
        const error = params.get('error');
        if (error) throw new OAuthCoreError(error === 'access_denied' ? 'ACCESS_DENIED' : 'OAUTH_CALLBACK_ERROR');
        const code = params.get('code');
        if (!code || code.length > 8192) throw new OAuthCoreError('INVALID_CALLBACK');
        const callbackClient = params.get('client_id');
        const clientId = attempt.client_id === DYNAMIC_CLIENT_ID ? callbackClient : attempt.client_id;
        if (!isIssuedClientId(clientId) ||
            (attempt.client_id !== DYNAMIC_CLIENT_ID && callbackClient !== null && callbackClient !== attempt.client_id)) {
          throw new OAuthCoreError('INVALID_CLIENT');
        }
        let response: TokenResponse;
        try {
          response = await this.transport.exchangeCode({
            grant_type: 'authorization_code', client_id: clientId, code,
            code_verifier: attempt.verifier, redirect_uri: this.config.callback_uri,
            resource: this.config.resource, signal: attempt.controller.signal,
          });
        } catch (failure) {
          throwIfAborted(attempt.controller.signal);
          if (failure instanceof TokenEndpointError && failure.kind === 'invalid_grant') {
            throw new AuthorizationCodeExchangeError('INVALID_GRANT', clientId);
          }
          throw new AuthorizationCodeExchangeError('TOKEN_EXCHANGE_FAILED', clientId, failure instanceof TokenEndpointError && failure.kind === 'transient');
        }
        throwIfAborted(attempt.controller.signal);
        const receivedAt = this.now();
        const scopes = this.validateTokenResponse(response, true);
        const identity = await this.verifyIdentity(response.id_token as string, clientId, attempt.controller.signal, attempt.nonce);
        if (attempt.selected && identity.subject !== attempt.selected.subject) throw new OAuthCoreError('IDENTITY_MISMATCH');
        const profile: CredentialProfile = {
          version: 1, profile_id: profileIdFor(identity.issuer, clientId, identity.subject),
          issuer: identity.issuer, subject: identity.subject, client_id: clientId,
          ext_agent_host_id: this.config.ext_agent_host_id,
          ...(identity.email ? { email: identity.email } : {}),
          access_token: response.access_token, refresh_token: response.refresh_token,
          id_token: response.id_token as string, token_type: 'Bearer', scopes,
          expires_at: receivedAt + response.expires_in * 1000, saved_at: receivedAt, needs_login: false,
        };
        throwIfAborted(attempt.controller.signal);
        await this.store.save(profile, attempt.controller.signal);
        this.invalidatedProfiles.delete(profile.profile_id);
        return redactStatus(profile, this.now());
      } finally { this.attempts.delete(attempt.state); }
    };
    // Even a fresh/unselected authorization may resolve to an existing profile.
    // Serialize all credential mutations in this single-owner MVP, including refresh.
    return this.track(this.serialized('credential-mutations', perform));
  }

  private validateTokenResponse(response: TokenResponse, requireIdToken: boolean): string[] {
    if (!response || typeof response.access_token !== 'string' || !response.access_token ||
        response.access_token.length > 65536 || typeof response.refresh_token !== 'string' ||
        !response.refresh_token || response.refresh_token.length > 65536 ||
        response.token_type !== 'Bearer' || !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0 ||
        !Number.isSafeInteger(this.now() + response.expires_in * 1000) ||
        (requireIdToken && !response.id_token) ||
        (response.id_token !== undefined && (typeof response.id_token !== 'string' || !response.id_token || response.id_token.length > 65536))) {
      throw new OAuthCoreError('TOKEN_RESPONSE_INVALID');
    }
    const scopes = parseGrantedScopes(response.scope);
    requirePlanScopes(scopes);
    return scopes;
  }
  private async verifyIdentity(idToken: string, clientId: string, signal: AbortSignal, nonce?: string): Promise<VerifiedIdToken> {
    let identity: VerifiedIdToken;
    try {
      identity = await this.verifier.verify(idToken, {
        issuer: this.config.issuer, audience: clientId, now_ms: this.now(), signal,
        ...(nonce !== undefined ? { nonce } : {}),
      });
    } catch {
      throwIfAborted(signal);
      throw new OAuthCoreError('ID_TOKEN_INVALID');
    }
    throwIfAborted(signal);
    const proof = identity?.verification;
    if (!identity || proof?.signature !== true || proof.trusted_jwks !== true ||
        proof.allowed_algorithm !== true || proof.standard_claims !== true ||
        identity.issuer !== this.config.issuer || !Number.isSafeInteger(identity.expires_at) || identity.expires_at <= this.now() ||
        typeof identity.subject !== 'string' || !identity.subject || identity.subject.length > 4096 ||
        (identity.email !== undefined && (typeof identity.email !== 'string' || identity.email.length > 4096)) ||
        (nonce !== undefined && (typeof identity.nonce !== 'string' || !constantTimeEqual(identity.nonce, nonce)))) {
      throw new OAuthCoreError('ID_TOKEN_INVALID');
    }
    const audiences = typeof identity.audience === 'string' ? [identity.audience] : identity.audience;
    if (!Array.isArray(audiences) || audiences.some(audience => typeof audience !== 'string' || !audience) || !audiences.includes(clientId) ||
        (audiences.length > 1 && identity.authorized_party !== clientId) ||
        (identity.authorized_party !== undefined && identity.authorized_party !== clientId)) {
      throw new OAuthCoreError('ID_TOKEN_INVALID');
    }
    return identity;
  }

  /** Concurrent calls coalesce. Failure clears the flight so a later explicit call retries. */
  refresh(profileId: string): Promise<RedactedStatus> {
    this.ensureOpen();
    const existing = this.refreshes.get(profileId);
    if (existing) return existing;
    const controller = new AbortController();
    this.refreshControllers.add(controller);
    const signal = controller.signal;
    const operation = this.serialized('credential-mutations', async () => {
      try {
        throwIfAborted(signal);
        const old = await this.store.load(profileId);
        if (!old) throw new OAuthCoreError('PROFILE_NOT_FOUND');
        this.ownProfile(old);
        if (old.needs_login || this.invalidatedProfiles.has(profileId)) throw new OAuthCoreError('NEEDS_LOGIN');
        let response: TokenResponse;
        try {
          response = await this.transport.refresh({
            grant_type: 'refresh_token', client_id: old.client_id, refresh_token: old.refresh_token,
            resource: this.config.resource, signal,
          });
        } catch (failure) {
          throwIfAborted(signal);
          if (failure instanceof TokenEndpointError && failure.kind === 'invalid_grant') {
            // Fail closed in RAM even if persisting the needs_login marker fails.
            this.invalidatedProfiles.add(profileId);
            // Preserve old credentials for diagnostics/re-auth only; never use them again automatically.
            await this.store.save({ ...old, needs_login: true }, signal);
            throw new OAuthCoreError('INVALID_GRANT');
          }
          // Unknown adapter failures are safe to retry later; old file remains byte-for-byte unchanged.
          throw new OAuthCoreError('TOKEN_EXCHANGE_FAILED', !(failure instanceof TokenEndpointError) || failure.kind === 'transient');
        }
        throwIfAborted(signal);
        const receivedAt = this.now();
        const scopes = this.validateTokenResponse(response, false);
        let email = old.email;
        if (response.id_token !== undefined) {
          const identity = await this.verifyIdentity(response.id_token, old.client_id, signal);
          if (identity.subject !== old.subject) throw new OAuthCoreError('IDENTITY_MISMATCH');
          email = identity.email ?? old.email;
        }
        const updated: CredentialProfile = {
          ...old, ...(email ? { email } : {}), access_token: response.access_token,
          refresh_token: response.refresh_token, id_token: response.id_token ?? old.id_token,
          scopes, expires_at: receivedAt + response.expires_in * 1000, saved_at: receivedAt,
          needs_login: false,
        };
        throwIfAborted(signal);
        await this.store.save(updated, signal);
        return redactStatus(updated, this.now());
      } finally { this.refreshControllers.delete(controller); }
    });
    this.refreshes.set(profileId, operation);
    void operation.then(() => this.refreshes.delete(profileId), () => this.refreshes.delete(profileId));
    return this.track(operation);
  }

  async status(profileId: string): Promise<RedactedStatus> {
    this.ensureOpen();
    const profile = await this.store.load(profileId);
    if (!profile) throw new OAuthCoreError('PROFILE_NOT_FOUND');
    this.ownProfile(profile);
    return redactStatus(this.invalidatedProfiles.has(profileId) ? { ...profile, needs_login: true } : profile, this.now());
  }

  /** Cancels RAM state and an in-flight exchange. Atomic commit already started is irrevocable. */
  cancelAuthorization(state: string): boolean {
    const attempt = this.attempts.get(state);
    if (!attempt) return false;
    attempt.controller.abort();
    this.pending.delete(state);
    this.attempts.delete(state);
    return true;
  }

  /** Stop accepting attempts, invalidate all pending state and wait for adapters to settle. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const attempt of this.attempts.values()) attempt.controller.abort();
    for (const controller of this.refreshControllers) controller.abort();
    this.pending.clear();
    this.attempts.clear();
    this.closePromise = Promise.allSettled([...this.operations]).then(() => {
      storeOwners.delete(this.store);
    });
    return this.closePromise;
  }
}
