import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthorizationCodeExchangeError, OAuthCore, OAuthCoreError, pkceS256, TokenEndpointError } from '../../src/oauth/index.js';
import type { VerifiedIdToken } from '../../src/oauth/index.js';
import { authorize, callback, CALLBACK, deferred, expectError, withHarness } from './helpers.js';

test('fresh dynamic registration uses issued callback client, exact redirect, S256 and verified nonce', async () => {
  await withHarness(async h => {
    const attempt = await h.core.beginAuthorization();
    const params = new URL(attempt.authorization_url).searchParams;
    assert.equal(params.get('client_id'), 'dynamic_agent_client');
    assert.equal(params.get('agent_name_hint'), 'Synthetic OAuth Test');
    assert.equal(params.get('redirect_uri'), CALLBACK);
    const result = await h.core.completeAuthorization(callback(attempt.state));
    assert.equal(result.state, 'ready');
    const request = h.transport.exchanges[0];
    assert.ok(request);
    assert.equal(request.client_id, 'oaiapp_synthetic');
    assert.equal(request.redirect_uri, CALLBACK);
    assert.ok(pkceS256(request.code_verifier) === params.get('code_challenge'));
    assert.ok(h.verifier.contexts[0]?.nonce === params.get('nonce'));
    const profile = await h.store.load(result.profile_id);
    assert.ok(profile);
    assert.equal(profile.expires_at, h.now + 3_600_000);
    assert.equal(profile.subject, 'synthetic-subject');
    const allowed = ['profile_id', 'state', 'scopes', 'expires_at', 'saved_at'];
    assert.deepEqual(Object.keys(result).sort(), allowed.sort());
    const diagnostics = JSON.stringify(await h.core.status(result.profile_id));
    for (const secret of [profile.access_token, profile.refresh_token, profile.id_token, profile.email, profile.subject]) {
      if (secret) assert.ok(!diagnostics.includes(secret));
    }
  });
});

test('wrong state and wrong callback never exchange; matching state consumed once', async () => {
  await withHarness(async h => {
    const attempt = await h.core.beginAuthorization();
    await expectError(() => h.core.completeAuthorization(callback('synthetic-wrong-state')), 'INVALID_STATE');
    await expectError(() => h.core.completeAuthorization(callback(attempt.state).replace(':1455/', ':1456/')), 'INVALID_CALLBACK');
    await expectError(() => h.core.completeAuthorization(`${callback(attempt.state)}&state=duplicate`), 'INVALID_CALLBACK');
    assert.equal(h.transport.exchanges.length, 0);
    await h.core.completeAuthorization(callback(attempt.state));
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
    assert.equal(h.transport.exchanges.length, 1);
  });
});

test('expired state is consumed without exchange', async () => {
  await withHarness(async h => {
    const attempt = await h.core.beginAuthorization();
    h.now = attempt.expires_at;
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'EXPIRED_STATE');
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
    assert.equal(h.transport.exchanges.length, 0);
  });
});

test('OAuth denial validates and consumes state, never exchanges code', async () => {
  await withHarness(async h => {
    const attempt = await h.core.beginAuthorization();
    await expectError(() => h.core.completeAuthorization(callback('bad-state', { error: 'access_denied' })), 'INVALID_STATE');
    await expectError(() => h.core.completeAuthorization(callback(attempt.state, { error: 'access_denied' })), 'ACCESS_DENIED');
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
    assert.equal(h.transport.exchanges.length, 0);
    assert.equal((await h.store.listProfileIds()).length, 0);
  });
});

test('new registration requires an issued client ID, never dynamic_agent_client token exchange', async () => {
  await withHarness(async h => {
    for (const client of ['', 'dynamic_agent_client']) {
      const attempt = await h.core.beginAuthorization();
      const url = new URL(callback(attempt.state));
      if (!client) url.searchParams.delete('client_id');
      else url.searchParams.set('client_id', client);
      await expectError(() => h.core.completeAuthorization(url.href), 'INVALID_CLIENT');
    }
    assert.equal(h.transport.exchanges.length, 0);
  });
});

const badIdentities: Array<[string, (identity: VerifiedIdToken) => VerifiedIdToken]> = [
  ['nonce', i => ({ ...i, nonce: 'synthetic-wrong-nonce' })],
  ['issuer', i => ({ ...i, issuer: 'https://evil.example.invalid' })],
  ['audience', i => ({ ...i, audience: 'different-client' })],
  ['expiry', i => ({ ...i, expires_at: 1 })],
  ['multiple audiences without azp', i => ({ ...i, audience: [i.audience as string, 'other'] })],
  ['signature proof', i => ({ ...i, verification: { ...i.verification, signature: false } }) as unknown as VerifiedIdToken],
  ['JWKS proof', i => ({ ...i, verification: { ...i.verification, trusted_jwks: false } }) as unknown as VerifiedIdToken],
  ['algorithm proof', i => ({ ...i, verification: { ...i.verification, allowed_algorithm: false } }) as unknown as VerifiedIdToken],
  ['standard-claims proof', i => ({ ...i, verification: { ...i.verification, standard_claims: false } }) as unknown as VerifiedIdToken],
];
for (const [name, transform] of badIdentities) {
  test(`ID token ${name} failure cannot commit; callback cannot replay`, async () => {
    await withHarness(async h => {
      h.verifier.transform = transform;
      const attempt = await h.core.beginAuthorization();
      await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'ID_TOKEN_INVALID');
      await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
      assert.equal((await h.store.listProfileIds()).length, 0);
    });
  });
}

test('verifier exception is redacted and no decode-only fallback exists', async () => {
  await withHarness(async h => {
    h.verifier.failure = new Error('synthetic-private-adapter-detail');
    const attempt = await h.core.beginAuthorization();
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'ID_TOKEN_INVALID');
    assert.equal((await h.store.listProfileIds()).length, 0);
  });
});

test('actual token grants missing each required scope reject even if callback claims full permissions', async () => {
  await withHarness(async h => {
    for (const missing of ['resource.invoke', 'chatgpt.tokens.use.direct', 'offline_access']) {
      const fullScope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
      h.transport.response.scope = fullScope.split(' ').filter(scope => scope !== missing).join(' ');
      const attempt = await h.core.beginAuthorization();
      await expectError(() => h.core.completeAuthorization(callback(attempt.state, { scope: fullScope })), 'INSUFFICIENT_SCOPE');
    }
    assert.equal((await h.store.listProfileIds()).length, 0);
  });
});

test('missing ID token or offline refresh token cannot commit a credential set', async () => {
  await withHarness(async h => {
    delete h.transport.response.id_token;
    let attempt = await h.core.beginAuthorization();
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'TOKEN_RESPONSE_INVALID');
    h.transport.response.id_token = 'synthetic-id';
    h.transport.response.refresh_token = '';
    attempt = await h.core.beginAuthorization();
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'TOKEN_RESPONSE_INVALID');
    assert.equal((await h.store.listProfileIds()).length, 0);
  });
});

test('returning account reuses host/client/hint, rejects changed client or identity without replacing old tokens', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const old = await h.store.load(profileId);
    assert.ok(old);
    let attempt = await h.core.beginAuthorization(profileId);
    const params = new URL(attempt.authorization_url).searchParams;
    assert.equal(params.get('client_id'), old.client_id);
    assert.equal(params.get('agent_name_hint'), null);
    assert.ok(params.get('id_token_hint') === old.id_token);
    assert.ok(params.get('ext_agent_host_id') === old.ext_agent_host_id);
    await expectError(() => h.core.completeAuthorization(callback(attempt.state, { client_id: 'oaiapp_other' })), 'INVALID_CLIENT');
    attempt = await h.core.beginAuthorization(profileId);
    h.verifier.transform = identity => ({ ...identity, subject: 'synthetic-other-account' });
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'IDENTITY_MISMATCH');
    assert.deepEqual(await h.store.load(profileId), old);
    delete h.verifier.transform;
    attempt = await h.core.beginAuthorization(profileId);
    const returningCallback = new URL(callback(attempt.state));
    returningCallback.searchParams.delete('client_id');
    await h.core.completeAuthorization(returningCallback.href);
    assert.equal((await h.store.listProfileIds()).length, 1);
  });
});

test('concurrent refresh callers coalesce one rotating-token exchange and atomic token set', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const gate = deferred<void>();
    h.transport.refreshHandler = async () => {
      await gate.promise;
      return { ...h.transport.response, access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh' };
    };
    const calls = Array.from({ length: 20 }, () => h.core.refresh(profileId));
    assert.ok(calls.every(call => call === calls[0]));
    gate.resolve();
    await Promise.all(calls);
    assert.equal(h.transport.refreshRequests.length, 1);
    assert.ok(h.transport.refreshRequests[0]?.refresh_token === 'synthetic-refresh-initial');
    assert.equal('scope' in (h.transport.refreshRequests[0] ?? {}), false);
    const stored = await h.store.load(profileId);
    assert.ok(stored?.access_token === 'synthetic-new-access');
    assert.ok(stored?.refresh_token === 'synthetic-new-refresh');
  });
});

test('transient refresh keeps old bytes and permits a later explicit retry without automatic retry', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const path = join(h.store.directory, `${profileId}.json`);
    const before = await readFile(path);
    h.transport.refreshHandler = async () => { throw new TokenEndpointError('transient'); };
    const calls = Array.from({ length: 5 }, () => h.core.refresh(profileId));
    await Promise.all(calls.map(call => expectError(() => call, 'TOKEN_EXCHANGE_FAILED', true)));
    assert.equal(h.transport.refreshRequests.length, 1);
    assert.ok((await readFile(path)).equals(before));
    delete h.transport.refreshHandler;
    await h.core.refresh(profileId);
    assert.equal(h.transport.refreshRequests.length, 2);
    assert.ok((await h.store.load(profileId))?.refresh_token === 'synthetic-refresh-rotated');
  });
});

test('invalid_grant marks needs_login, preserves original credentials and never falls back or retries automatically', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const old = await h.store.load(profileId);
    assert.ok(old);
    h.transport.refreshHandler = async () => { throw new TokenEndpointError('invalid_grant'); };
    await expectError(() => h.core.refresh(profileId), 'INVALID_GRANT', false);
    const stored = await h.store.load(profileId);
    assert.deepEqual(stored, { ...old, needs_login: true });
    assert.equal((await h.core.status(profileId)).state, 'needs_login');
    await expectError(() => h.core.refresh(profileId), 'NEEDS_LOGIN');
    assert.equal(h.transport.refreshRequests.length, 1);
    assert.equal(h.transport.exchanges.length, 1);
  });
});

test('code invalid_grant consumes code/state and cannot commit; fresh attempt is explicit', async () => {
  await withHarness(async h => {
    h.transport.exchangeHandler = async () => { throw new TokenEndpointError('invalid_grant'); };
    const attempt = await h.core.beginAuthorization();
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_GRANT');
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
    assert.equal((await h.store.listProfileIds()).length, 0);
  });
});

test('failed first code exchange retains issued client for explicit fresh registration retry', async () => {
  await withHarness(async h => {
    h.transport.exchangeHandler = async () => { throw new TokenEndpointError('invalid_grant'); };
    const oldAttempt = await h.core.beginAuthorization();
    let issuedClient: string | undefined;
    await assert.rejects(async () => { await h.core.completeAuthorization(callback(oldAttempt.state)); }, error => {
      assert.ok(error instanceof AuthorizationCodeExchangeError);
      assert.equal(error.code, 'INVALID_GRANT');
      issuedClient = error.client_id;
      return true;
    });
    assert.ok(issuedClient);
    const retry = await h.core.retryRegistration(issuedClient);
    const params = new URL(retry.authorization_url).searchParams;
    assert.ok(retry.state !== oldAttempt.state);
    assert.equal(params.get('client_id'), issuedClient);
    assert.equal(params.get('agent_name_hint'), null);
    assert.equal(params.get('id_token_hint'), null);
    delete h.transport.exchangeHandler;
    const url = new URL(callback(retry.state));
    url.searchParams.delete('client_id');
    const result = await h.core.completeAuthorization(url.href);
    assert.equal(result.state, 'ready');
    await expectError(() => h.core.retryRegistration('dynamic_agent_client'), 'INVALID_CLIENT');
  });
});

test('refresh bad grants, malformed rotation or failed ID-token verification leave old bytes untouched', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const path = join(h.store.directory, `${profileId}.json`);
    const before = await readFile(path);
    h.transport.response.scope = 'openid profile offline_access';
    await expectError(() => h.core.refresh(profileId), 'INSUFFICIENT_SCOPE');
    assert.ok((await readFile(path)).equals(before));
    h.transport.response.scope = 'offline_access resource.invoke chatgpt.tokens.use.direct';
    h.transport.refreshHandler = async () => ({ ...h.transport.response, refresh_token: '' });
    await expectError(() => h.core.refresh(profileId), 'TOKEN_RESPONSE_INVALID');
    assert.ok((await readFile(path)).equals(before));
    delete h.transport.refreshHandler;
    h.verifier.transform = identity => ({ ...identity, subject: 'synthetic-other-subject' });
    await expectError(() => h.core.refresh(profileId), 'IDENTITY_MISMATCH');
    assert.ok((await readFile(path)).equals(before));
  });
});

test('refresh may omit ID token and preserves retained verified hint without decode/reverification', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const old = await h.store.load(profileId);
    delete h.transport.response.id_token;
    await h.core.refresh(profileId);
    assert.ok((await h.store.load(profileId))?.id_token === old?.id_token);
    assert.equal(h.verifier.contexts.length, 1);
  });
});

test('cancel before callback and during ignored-abort exchange prevents commit', async () => {
  await withHarness(async h => {
    let attempt = await h.core.beginAuthorization();
    assert.equal(h.core.cancelAuthorization(attempt.state), true);
    assert.equal(h.core.cancelAuthorization(attempt.state), false);
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
    const started = deferred<void>();
    const gate = deferred<void>();
    h.transport.exchangeHandler = async () => { started.resolve(); await gate.promise; return h.transport.response; };
    attempt = await h.core.beginAuthorization();
    const completion = h.core.completeAuthorization(callback(attempt.state));
    await started.promise;
    assert.equal(h.core.cancelAuthorization(attempt.state), true);
    gate.resolve();
    await expectError(() => completion, 'CANCELLED');
    assert.equal((await h.store.listProfileIds()).length, 0);
  });
});

test('invalid_grant fails closed in memory even if needs_login persistence fails; verified reauthorization recovers', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const originalSave = h.store.save.bind(h.store);
    h.store.save = (profile, signal) => {
      if (profile.needs_login) return Promise.reject(new OAuthCoreError('STORE_IO'));
      return originalSave(profile, signal);
    };
    h.transport.refreshHandler = async () => { throw new TokenEndpointError('invalid_grant'); };
    await expectError(() => h.core.refresh(profileId), 'STORE_IO');
    assert.equal((await h.core.status(profileId)).state, 'needs_login');
    await expectError(() => h.core.refresh(profileId), 'NEEDS_LOGIN');
    assert.equal(h.transport.refreshRequests.length, 1);
    h.store.save = originalSave;
    const attempt = await h.core.beginAuthorization(profileId);
    await h.core.completeAuthorization(callback(attempt.state));
    assert.equal((await h.core.status(profileId)).state, 'ready');
  });
});

test('shutdown aborts ignored-abort refresh without replacing old credentials; close is idempotent', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const old = await h.store.load(profileId);
    const started = deferred<void>();
    const gate = deferred<void>();
    h.transport.refreshHandler = async () => { started.resolve(); await gate.promise; return h.transport.response; };
    const refresh = h.core.refresh(profileId);
    await started.promise;
    const closing = h.core.close();
    assert.ok(h.core.close() === closing);
    await expectError(() => h.core.beginAuthorization(), 'CLOSED');
    gate.resolve();
    await expectError(() => refresh, 'CANCELLED');
    await closing;
    assert.deepEqual(await h.store.load(profileId), old);
  });
});

test('restart invalidates old pending state, owner is single-process and profiles remain resumable', async () => {
  await withHarness(async h => {
    const profileId = await authorize(h);
    const attempt = await h.core.beginAuthorization();
    const config = {
      issuer: 'https://auth.example.invalid', authorization_endpoint: 'https://auth.example.invalid/authorize',
      resource: 'https://api.example.invalid/v1', callback_uri: CALLBACK,
      ext_agent_host_id: await h.store.getOrCreateHostId(), agent_name: 'Synthetic OAuth Test', now: () => h.now,
    };
    await expectError(() => new OAuthCore(config, h.store, h.transport, h.verifier), 'OWNER_CONFLICT');
    const oldCore = h.core;
    await oldCore.close();
    h.core = new OAuthCore(config, h.store, h.transport, h.verifier);
    await oldCore.close();
    await expectError(() => new OAuthCore(config, h.store, h.transport, h.verifier), 'OWNER_CONFLICT');
    await expectError(() => h.core.completeAuthorization(callback(attempt.state)), 'INVALID_STATE');
    assert.equal((await h.core.status(profileId)).state, 'ready');
    h.now += 3_600_000;
    assert.equal((await h.core.status(profileId)).state, 'expired');
  });
});
