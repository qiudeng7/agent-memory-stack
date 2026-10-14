import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from '../src/common.js';
import { createLlmApp, llmOptionsFromEnv, type AdapterResponsesPayload, type LlmAppOptions, type ResponsesTransport } from '../src/app.js';
const apiKey = 'offline-fixture-data-key-not-a-real-key';
const adminKey = 'offline-fixture-admin-key-not-a-real-key';
function completed(text = 'synthetic complete answer') {
  return { type: 'response.completed', response: { id: 'resp_fixture', model: 'fixture-model', created_at: 1, status: 'completed', output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, output_tokens_details: { reasoning_tokens: 0 } } } };
}
function transport(events: unknown[]) {
  const calls: AdapterResponsesPayload[] = []; const signals: AbortSignal[] = [];
  const backend: ResponsesTransport = { async execute(payload, signal) {
    calls.push(payload); signals.push(signal);
    return (async function* () { for (const event of events) yield new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`); })();
  } };
  return { backend, calls, signals };
}
const body = { model: 'memory-default', messages: [{ role: 'user', content: 'synthetic fixture question' }], max_tokens: 100 };
const auth = { authorization: `Bearer ${apiKey}` };
const options = (backend?: ResponsesTransport): LlmAppOptions => ({ apiKey, adminKey, ...(backend ? { transport: backend, routes: [{ alias: 'memory-default', modelSlug: 'fixture-model', accountModelVerified: true as const }] } : {}) });

test('Nest startup is offline by default and no provider does not fake readiness', async () => {
  const app = await createLlmApp(options());
  try {
    const api = app.getHttpAdapter().getInstance();
    assert.equal((await api.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await api.inject({ method: 'GET', url: '/ready' })).statusCode, 503);
    const response = await api.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: body });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'provider_not_connected');
  } finally { await app.close(); }
});
test('inference and admin credentials are separate', async () => {
  const app = await createLlmApp(options());
  try {
    const api = app.getHttpAdapter().getInstance();
    assert.equal((await api.inject({ method: 'GET', url: '/v1/models' })).statusCode, 401);
    assert.equal((await api.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${adminKey}` } })).statusCode, 401);
    assert.equal((await api.inject({ method: 'GET', url: '/admin/status', headers: auth })).statusCode, 401);
    const response = await api.inject({ method: 'GET', url: '/admin/status', headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().provider, 'disabled');
    assert.ok(!response.body.includes(apiKey) && !response.body.includes(adminKey));
  } finally { await app.close(); }
});
test('only a final completed stream is returned through the real Nest controller', async () => {
  const fixture = transport([completed()]); const app = await createLlmApp(options(fixture.backend));
  try {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: body });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().choices[0].message.content, 'synthetic complete answer');
    assert.equal(response.headers['x-ams-ignored-parameters'], 'max_tokens');
    assert.equal(response.headers['x-ams-completion-policy'], 'completed-only');
    assert.equal(fixture.calls[0]!.model, 'fixture-model');
    assert.equal(fixture.calls[0]!.store, false);
    assert.equal(fixture.calls[0]!.stream, true);
    assert.equal('max_tokens' in fixture.calls[0]!, false);
    assert.equal(fixture.signals[0]!.aborted, true);
  } finally { await app.close(); }
});
test('delta then failed returns safe error, not content; transport is aborted', async () => {
  const fixture = transport([{ type: 'response.output_text.delta', response_id: 'resp_fixture', delta: 'DO_NOT_EXPOSE_PARTIAL' }, { type: 'response.failed', response: { id: 'resp_fixture', status: 'failed', error: { message: 'DO_NOT_EXPOSE_PROVIDER_ERROR' } } }]);
  const app = await createLlmApp(options(fixture.backend));
  try {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: body });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'UPSTREAM_FAILED');
    assert.ok(!response.body.includes('DO_NOT_EXPOSE_'));
    assert.equal(fixture.signals[0]!.aborted, true);
  } finally { await app.close(); }
});
test('unknown alias and unsupported parameters are rejected without upstream calls', async () => {
  const fixture = transport([completed()]); const app = await createLlmApp(options(fixture.backend));
  try {
    const api = app.getHttpAdapter().getInstance();
    assert.equal((await api.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: { ...body, model: 'not-granted' } })).statusCode, 404);
    const response = await api.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: { ...body, temperature: 'DO_NOT_EXPOSE_PARAM' } });
    assert.equal(response.statusCode, 400);
    assert.ok(!response.body.includes('DO_NOT_EXPOSE_PARAM'));
    assert.equal(fixture.calls.length, 0);
  } finally { await app.close(); }
});
test('wrong upstream model fails rather than using unverified model', async () => {
  const event = completed(); event.response.model = 'not-verified';
  const fixture = transport([event]); const app = await createLlmApp(options(fixture.backend));
  try {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: body });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'upstream_model_mismatch');
  } finally { await app.close(); }
});
test('OAuth HTTP endpoints explicitly return not implemented rather than fake login', async () => {
  const app = await createLlmApp(options());
  try {
    const api = app.getHttpAdapter().getInstance();
    assert.equal((await api.inject({ method: 'POST', url: '/admin/oauth/start', headers: { authorization: `Bearer ${adminKey}` } })).statusCode, 501);
    const result = await api.inject({ method: 'GET', url: '/auth/callback?code=SYNTHETIC_CODE&state=SYNTHETIC_STATE' });
    assert.equal(result.statusCode, 501);
    assert.ok(!result.body.includes('SYNTHETIC_'));
  } finally { await app.close(); }
});
test('missing service credentials never allow inference access', async () => {
  const app = await createLlmApp();
  try {
    assert.equal((await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/models' })).statusCode, 503);
  } finally { await app.close(); }
});
test('OpenViking defaults map reasoning none and explicitly report ignored temperature zero', async () => {
  const fixture = transport([completed()]); const app = await createLlmApp(options(fixture.backend));
  try {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: { ...body, temperature: 0, reasoning_effort: 'none' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fixture.calls[0]!.reasoning, { effort: 'none' });
    assert.equal('temperature' in fixture.calls[0]!, false);
    assert.equal(response.headers['x-ams-ignored-parameters'], 'max_tokens,temperature');
  } finally { await app.close(); }
});
test('malformed JSON and oversized requests do not leak body or contact upstream', async () => {
  const fixture = transport([completed()]); const app = await createLlmApp(options(fixture.backend));
  try {
    const api = app.getHttpAdapter().getInstance();
    const malformed = await api.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...auth, 'content-type': 'application/json' }, payload: '{\"model\":BROKEN_PRIVATE_FIXTURE}' });
    assert.equal(malformed.statusCode, 400);
    assert.ok(!malformed.body.includes('BROKEN'));
    const oversized = await api.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...auth, 'content-type': 'application/json' }, payload: 'PRIVATE_BIG_' + 'a'.repeat(1024 * 1024) });
    assert.equal(oversized.statusCode, 413);
    assert.ok(!oversized.body.includes('PRIVATE_BIG_'));
    assert.equal(fixture.calls.length, 0);
  } finally { await app.close(); }
});
// Independently computed with Python hmac/hashlib; literal UTF-8 master, not hex bytes.
test('master derives stable distinct protocol vectors, preserves case and leaves env unchanged', () => {
  const vectors = [
    ['a'.repeat(64), '03ee04f57bcc77ca79ba258872dfebf8ef67e47b461314c3e23eb3082bb85c81', 'a609c1f3e1159ca31b8b9804dbf937abadda2d3b8221e3f38180d3c1953a2a83'],
    ['A'.repeat(64), 'd7b0df351c8337bfc820d9339e8cc493588c4adccfa463e712c2b3b2e80d211f', '1824706992259cf03e95ebf75f1797428095053528586d393daf54d231a560c6'],
    ['aA01'.repeat(16), '70c9645da743bde80eabb807fecf71e024995b47bebf120e423c9c9ef40a875e', '43adeec84a0b9f02f6a49d94d35d8513ef324c5df5cc9885a4b52fb5ea71bf01'],
  ];
  for (const [master, data, admin] of vectors) {
    const env = Object.freeze({ AMS_MASTER_KEY: master, LLM_PROVIDER: 'disabled', EMBEDDING_API_KEY: '' });
    const before = { ...env };
    const actual = llmOptionsFromEnv(env);
    assert.deepEqual(actual, { apiKey: data, adminKey: admin });
    assert.notEqual(actual.apiKey, actual.adminKey);
    assert.deepEqual(llmOptionsFromEnv(env), actual);
    assert.deepEqual(env, before);
  }
});
test('invalid master is rejected safely including empty, templates and trailing newline', () => {
  for (const master of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'REPLACE_' + 'a'.repeat(56), '${AMS_MASTER_KEY}', ' a'.repeat(32), 'a'.repeat(64) + '\n', 'ａ'.repeat(64)]) {
    const env = Object.freeze({ AMS_MASTER_KEY: master });
    assert.throws(() => llmOptionsFromEnv(env), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.code, 'configuration_error');
      assert.match(error.message, /Invalid AMS_MASTER_KEY/);
      if (master) assert.ok(!String(error).includes(master));
      return true;
    });
    assert.deepEqual(env, { AMS_MASTER_KEY: master });
  }
});
test('master rejects every explicit local credential and file even when empty without reading files', () => {
  for (const name of ['LLM_API_KEY', 'LLM_ADMIN_API_KEY']) {
    for (const suffix of ['', '_FILE']) {
      for (const value of ['', 'synthetic-private-value-not-a-real-path']) {
        const env = Object.freeze({ AMS_MASTER_KEY: 'a'.repeat(64), [name + suffix]: value });
        const before = { ...env };
        assert.throws(() => llmOptionsFromEnv(env), (error: unknown) => {
          assert.ok(error instanceof GatewayError);
          assert.equal(error.code, 'configuration_error');
          assert.match(error.message, /cannot be combined/);
          assert.ok(!String(error).includes(env.AMS_MASTER_KEY));
          if (value) assert.ok(!String(error).includes(value));
          return true;
        });
        assert.deepEqual(env, before);
      }
    }
  }
});
test('missing master retains explicit keys and synthetic secret-file development configuration', () => {
  assert.deepEqual(llmOptionsFromEnv({}), {});
  const env = Object.freeze({ LLM_API_KEY: apiKey, LLM_ADMIN_API_KEY: adminKey });
  assert.deepEqual(llmOptionsFromEnv(env), { apiKey, adminKey });
  assert.deepEqual(env, { LLM_API_KEY: apiKey, LLM_ADMIN_API_KEY: adminKey });
  const dir = mkdtempSync(join(tmpdir(), 'ams-config-fixture-'));
  try {
    const path = join(dir, 'key');
    writeFileSync(path, apiKey + '\n', { mode: 0o600 });
    assert.deepEqual(llmOptionsFromEnv({ LLM_API_KEY_FILE: path, LLM_ADMIN_API_KEY: adminKey }), { apiKey, adminKey });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('master remains service auth only, with live provider and OAuth disabled', async () => {
  const env = { AMS_MASTER_KEY: 'a'.repeat(64) };
  assert.throws(() => llmOptionsFromEnv({ ...env, LLM_PROVIDER: 'siwc' }));
  const configured = llmOptionsFromEnv(env);
  const app = await createLlmApp(configured);
  try {
    const api = app.getHttpAdapter().getInstance();
    const headers = { authorization: `Bearer ${configured.adminKey}` };
    assert.equal((await api.inject({ method: 'GET', url: '/ready' })).statusCode, 503);
    assert.equal((await api.inject({ method: 'GET', url: '/admin/status', headers })).json().provider, 'disabled');
    assert.equal((await api.inject({ method: 'POST', url: '/admin/oauth/start', headers })).statusCode, 501);
    assert.equal((await api.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${env.AMS_MASTER_KEY}` } })).statusCode, 401);
  } finally { await app.close(); }
});

test('configuration rejects shared data/admin secret and live provider flag in P0', async () => {
  await assert.rejects(createLlmApp({ apiKey, adminKey: apiKey }));
  assert.throws(() => llmOptionsFromEnv({ LLM_PROVIDER: 'siwc' }));
});
