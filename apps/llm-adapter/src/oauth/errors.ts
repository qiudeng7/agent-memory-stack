export type OAuthErrorCode =
  | 'INVALID_CONFIG' | 'INVALID_CALLBACK' | 'INVALID_STATE' | 'EXPIRED_STATE'
  | 'CANCELLED' | 'ACCESS_DENIED' | 'OAUTH_CALLBACK_ERROR' | 'INVALID_CLIENT'
  | 'TOKEN_EXCHANGE_FAILED' | 'TOKEN_RESPONSE_INVALID' | 'ID_TOKEN_INVALID'
  | 'IDENTITY_MISMATCH' | 'INSUFFICIENT_SCOPE' | 'INVALID_GRANT' | 'NEEDS_LOGIN'
  | 'PROFILE_NOT_FOUND' | 'STORE_UNSAFE' | 'STORE_IO' | 'OWNER_CONFLICT' | 'CLOSED';

/** Messages are fixed and never include adapter errors, URLs, codes or credentials. */
export class OAuthCoreError extends Error {
  readonly code: OAuthErrorCode;
  readonly retryable: boolean;
  constructor(code: OAuthErrorCode, retryable = false) {
    super(code);
    this.name = 'OAuthCoreError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Code is consumed. Retain the non-secret issued ID for an explicit fresh registration retry. */
export class AuthorizationCodeExchangeError extends OAuthCoreError {
  readonly client_id: string;
  constructor(code: 'INVALID_GRANT' | 'TOKEN_EXCHANGE_FAILED', clientId: string, retryable = false) {
    super(code, retryable);
    this.name = 'AuthorizationCodeExchangeError';
    this.client_id = clientId;
  }
}

/** The transport adapter must classify protocol invalid_grant explicitly. */
export class TokenEndpointError extends Error {
  readonly kind: 'invalid_grant' | 'transient' | 'permanent';
  constructor(kind: 'invalid_grant' | 'transient' | 'permanent') {
    super(`TOKEN_ENDPOINT_${kind.toUpperCase()}`);
    this.name = 'TokenEndpointError';
    this.kind = kind;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OAuthCoreError('CANCELLED');
}
