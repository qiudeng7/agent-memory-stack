import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateHostId, generateNonce, generatePkce, generateState, OAuthCoreError,
  parseCallback, parseGrantedScopes, pkceS256, profileIdFor, requirePlanScopes,
  validateCallbackUri, validateHostId,
} from '../../src/oauth/index.js';
import { CALLBACK } from './helpers.js';

test('PKCE S256 matches RFC7636 vector with base64url and no padding', () => {
  assert.equal(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = generatePkce();
  const b = generatePkce();
  assert.ok(a.verifier !== b.verifier);
  assert.equal(a.method, 'S256');
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(a.verifier));
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(a.challenge));
  assert.ok(a.challenge === pkceS256(a.verifier));
  assert.throws(() => pkceS256('too-short'), OAuthCoreError);
  assert.ok(generateState() !== generateState());
  assert.ok(generateNonce() !== generateNonce());
});

test('host IDs are opaque canonical supported UUIDv4 URIs', () => {
  const id = generateHostId();
  assert.ok(validateHostId(id) === id);
  assert.ok(generateHostId() !== id);
  for (const bad of ['user@example.invalid', 'urn:uuid:bad', id.toUpperCase(), 'did:web:example.invalid']) {
    assert.throws(() => validateHostId(bad), OAuthCoreError);
  }
});

test('fixed loopback rejects aliases, wrong scheme/path/port, userinfo and encoded normalization', () => {
  assert.equal(validateCallbackUri(CALLBACK), CALLBACK);
  for (const bad of [
    'http://localhost:1455/auth/callback', 'http://0.0.0.0:1455/auth/callback',
    'http://[::1]:1455/auth/callback', 'https://127.0.0.1:1455/auth/callback',
    'http://127.0.0.1/auth/callback', 'http://127.1:1455/auth/callback',
    'http://2130706433:1455/auth/callback', 'http://127.0.0.1:01455/auth/callback',
    'http://user@127.0.0.1:1455/auth/callback', 'http://127.0.0.1:1455/auth/../callback',
    'http://127.0.0.1:1455/auth/%63allback', `${CALLBACK}?redirect=https://evil.invalid`, `${CALLBACK}#fragment`,
  ]) assert.throws(() => validateCallbackUri(bad), OAuthCoreError);
  for (const bad of [
    'http://127.0.0.1:1456/auth/callback?state=synthetic',
    'http://127.0.0.1:1455/callback?state=synthetic',
    'http://evil.invalid:1455/auth/callback?state=synthetic',
    `${CALLBACK}?state=a&state=b`, `${CALLBACK}?state=a#fragment`,
  ]) assert.throws(() => parseCallback(bad, CALLBACK), OAuthCoreError);
});

test('granted scope parsing and required plan permissions never infer consent from request', () => {
  const scopes = parseGrantedScopes('offline_access resource.invoke chatgpt.tokens.use.direct resource.invoke');
  assert.equal(scopes.length, 3);
  requirePlanScopes(scopes);
  assert.throws(() => requirePlanScopes(['openid', 'profile', 'email']), OAuthCoreError);
  for (const bad of ['', 'offline_access\tresource.invoke', 'offline_access  resource.invoke']) {
    assert.throws(() => parseGrantedScopes(bad), OAuthCoreError);
  }
  assert.notEqual(profileIdFor('issuer', 'client-a', 'subject'), profileIdFor('issuer', 'client-b', 'subject'));
  assert.notEqual(profileIdFor('issuer', 'client', 'subject-a'), profileIdFor('issuer', 'client', 'subject-b'));
});
