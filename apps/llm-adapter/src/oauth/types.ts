export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  /** Actual token-endpoint granted scopes, not requested or callback scopes. */
  scope: string;
}

export interface CodeExchangeRequest {
  grant_type: 'authorization_code';
  client_id: string;
  code: string;
  code_verifier: string;
  redirect_uri: string;
  resource: string;
  signal: AbortSignal;
}
export interface RefreshRequest {
  grant_type: 'refresh_token';
  client_id: string;
  refresh_token: string;
  resource: string;
  /** No scope: preserve the original grant. */
  signal: AbortSignal;
}

/** No network implementation or token endpoint default is provided by this package. */
export interface TokenTransport {
  exchangeCode(request: CodeExchangeRequest): Promise<TokenResponse>;
  refresh(request: RefreshRequest): Promise<TokenResponse>;
}

export interface IdTokenVerificationContext {
  issuer: string;
  audience: string;
  /** Required on code exchange; absent for a newly returned refresh ID token. */
  nonce?: string;
  now_ms: number;
  signal: AbortSignal;
}
export interface VerifiedIdToken {
  issuer: string;
  audience: string | readonly string[];
  /** For multiple audiences, the verifier must validate azp as well. */
  authorized_party?: string;
  subject: string;
  expires_at: number;
  nonce?: string;
  email?: string;
  /** Attestation from the trusted cryptographic verifier, NOT a JWT decoder. */
  verification: {
    signature: true;
    trusted_jwks: true;
    allowed_algorithm: true;
    standard_claims: true;
  };
}

/**
 * Trusted adapter boundary: cryptographically verify against issuer-pinned JWKS,
 * reject none/algorithm confusion/untrusted jku/x5u, check time claims including
 * nbf/iat and azp, then return validated claims with the explicit attestations.
 * Merely decoding JWT payloads does NOT implement this interface safely.
 * The core independently enforces issuer/aud/expiry/nonce and selected identity.
 */
export interface IdTokenVerifier {
  verify(idToken: string, context: IdTokenVerificationContext): Promise<VerifiedIdToken>;
}

export interface CredentialProfile {
  version: 1;
  profile_id: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  email?: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  scopes: string[];
  /** Epoch milliseconds. Updated atomically with the rotating refresh token. */
  expires_at: number;
  saved_at: number;
  needs_login: boolean;
}

/** Allowlist-only diagnostics: never includes tokens, identity hints or auth URLs. */
export interface RedactedStatus {
  profile_id: string;
  state: 'ready' | 'expired' | 'needs_login';
  scopes: string[];
  expires_at: number;
  saved_at: number;
}

export interface CredentialStore {
  load(profileId: string): Promise<CredentialProfile | undefined>;
  /** Abort is checked immediately before atomic commit; commit cannot be undone. */
  save(profile: CredentialProfile, signal?: AbortSignal): Promise<void>;
}

export interface OAuthCoreConfig {
  issuer: string;
  /** Officially discovered/configured HTTPS authorization endpoint, issuer-pinned. */
  authorization_endpoint: string;
  resource: string;
  /** Exact HTTP 127.0.0.1 callback, fixed port/path. No localhost, aliases or redirects. */
  callback_uri: string;
  ext_agent_host_id: string;
  agent_name: string;
  pending_ttl_ms?: number;
  max_pending?: number;
  now?: () => number;
}

export interface AuthorizationAttempt {
  /** May contain id_token_hint. Do not log this value or expose it in status. */
  authorization_url: string;
  state: string;
  expires_at: number;
}
