import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LlmGatewayService, type ResponsesTransport } from '../src/app.js';
import { GatewayError } from '../src/common.js';
import { TokenEndpointError } from '../src/oauth/index.js';
import type { TokenResponse } from '../src/oauth/index.js';
import { authorize, callback, deferred, withHarness } from './oauth/helpers.js';

const body = { model: 'memory-default', messages: [{ role: 'user', content: 'synthetic fixture' }] };

test('header acquisition deadline returns promptly, disposes late stream, and pauses uncertain transport', async () => {
  const acquisition = deferred<AsyncIterable<Uint8Array>>();
  let calls = 0; let disposed = false; let observedSignal: AbortSignal | undefined;
  const transport: ResponsesTransport = { async execute(_payload, signal) { calls++; observedSignal = signal; return acquisition.promise; } };
  const service = new LlmGatewayService({ apiKey: 'synthetic-data-key', transport, routes: [{ alias: 'memory-default', modelSlug: 'fixture-model', accountModelVerified: true }], timeoutMs: 15 });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([
      service.complete(body),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('Regression: request remained pending')), 500); }),
    ]), (error: unknown) => error instanceof GatewayError && error.status === 504);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(service.status().transportPaused, true);
    assert.equal(service.ready(), false);
    await assert.rejects(service.complete(body), (error: unknown) => error instanceof GatewayError && error.code === 'transport_cleanup_uncertain');
    assert.equal(calls, 1);
    acquisition.resolve({ [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; }, async return() { disposed = true; return { done: true, value: undefined }; } }; } });
    await nextTurn();
    assert.equal(disposed, true);
    assert.equal(service.status().transportPaused, true, 'No automatic retry merely because an iterator returned');
  } finally { if (watchdog) clearTimeout(watchdog); }
});

test('fresh authorization for an existing client cannot race old refresh invalid_grant', async () => {
  await withHarness(async (h) => {
    const id = await authorize(h);
    const old = await h.store.load(id); assert.ok(old);
    const started = deferred<void>(); const release = deferred<TokenResponse>();
    h.transport.refreshHandler = async () => { started.resolve(); return release.promise; };
    const refresh = h.core.refresh(id).then(() => null, (error: unknown) => error);
    await started.promise;
    const attempt = await h.core.retryRegistration(old.client_id);
    h.now++;
    h.transport.response = { ...h.transport.response, access_token: 'synthetic-new-grant-access', refresh_token: 'synthetic-new-grant-refresh' };
    const reauth = h.core.completeAuthorization(callback(attempt.state));
    await nextTurn();
    assert.equal(h.transport.exchanges.length, 1, 'New code exchange waits for existing credential mutation');
    release.reject(new TokenEndpointError('invalid_grant'));
    const failure = await refresh;
    assert.ok(failure instanceof Error);
    const ready = await reauth;
    assert.equal(ready.state, 'ready');
    const saved = await h.store.load(id); assert.ok(saved);
    assert.equal(saved.access_token, 'synthetic-new-grant-access');
    assert.equal(saved.refresh_token, 'synthetic-new-grant-refresh');
    assert.equal(saved.needs_login, false);
    assert.equal((await h.core.status(id)).state, 'ready');
  });
});
