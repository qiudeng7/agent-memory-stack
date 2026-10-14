import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aggregateResponsesSse, convertChatRequest, ProtocolError, ResponsesAggregator, ToolRegistry } from '../../src/protocol/index.js';

const readTool = {
  type: 'function', function: { name: 'read', description: 'Read a memory file', parameters: {
    type: 'object', properties: { uri: { type: 'string' }, offset: { type: 'integer', minimum: 0, default: 0 } }, required: ['uri'],
  } },
};
function convert(extra: Record<string, unknown> = {}) {
  return convertChatRequest({ model: 'local-alias', messages: [{ role: 'user', content: 'hello' }], ...extra }, { modelSlug: 'verified-model-slug' });
}
function message(text = 'hello') { return { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }; }
function call(argumentsText = '{"uri":"viking://test"}', extra: Record<string, unknown> = {}) {
  return { id: 'fc_1', type: 'function_call', status: 'completed', namespace: 'openviking', name: 'read', call_id: 'call_1', arguments: argumentsText, ...extra };
}
function terminal(output: unknown[] = [message()], extra: Record<string, unknown> = {}) {
  return { type: 'response.completed', response: { id: 'resp_1', model: 'verified-model-slug', created_at: 1, status: 'completed', output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0 } }, ...extra } };
}
function frame(event: unknown, newline = '\n') { return `data: ${JSON.stringify(event)}${newline}${newline}`; }
async function* chunks(value: string, split = 13) {
  const bytes = new TextEncoder().encode(value);
  for (let i = 0; i < bytes.length; i += split) yield bytes.slice(i, i + split);
}
function errorCode(code: string, status?: number) {
  return (error: unknown) => error instanceof ProtocolError && error.code === code && (status === undefined || error.status === status);
}
const emptyRegistry = new ToolRegistry([]);

// Request conversion is a whitelist, not an arbitrary API pass-through.
test('text developer/system history, alias resolution, fixed SIWC flags and ignored OV caps', () => {
  const result = convert({ messages: [{ role: 'system', content: 'rule' }, { role: 'developer', content: 'dev' },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { role: 'assistant', content: 'prior' }],
    stream: false, n: 1, max_tokens: 200, max_completion_tokens: 300 });
  assert.deepEqual(result.payload, { model: 'verified-model-slug', store: false, stream: true,
    input: [{ role: 'developer', content: 'rule' }, { role: 'developer', content: 'dev' }, { role: 'user', content: 'ab' }, { role: 'assistant', content: 'prior' }] });
  assert.equal(result.requestedModel, 'local-alias');
  assert.deepEqual(result.ignoredParameters, ['max_tokens', 'max_completion_tokens']);
});
for (const [field, value] of Object.entries({ temperature: 0, max_output_tokens: 200, top_p: 1, metadata: {}, response_format: { type: 'json_object' }, previous_response_id: 'r', reasoning_effort: 'low', arbitrary: true })) {
  test(`reject unsupported request field ${field}`, () => assert.throws(() => convert({ [field]: value }), errorCode('UNSUPPORTED_FIELD')));
}
test('OV stream=true, n>1 and multimodal are rejected', () => {
  assert.throws(() => convert({ stream: true }), errorCode('UNSUPPORTED_STREAM'));
  assert.throws(() => convert({ n: 2 }), errorCode('UNSUPPORTED_FIELD'));
  assert.throws(() => convert({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://invalid.test' } }] }] }), ProtocolError);
});
test('namespace tools use official nested shape and strict=false preserves optional arguments', () => {
  const result = convert({ tools: [readTool], tool_choice: 'auto' });
  assert.deepEqual(result.payload.tools, [{ type: 'namespace', name: 'openviking', description: 'OpenViking read-only memory tools.', tools: [
    { type: 'function', name: 'read', description: 'Read a memory file', parameters: readTool.function.parameters, strict: false },
  ] }]);
  assert.equal(result.payload.tool_choice, 'auto');
  assert.equal(result.toolRegistry.fromResponse('openviking', 'read').originalName, 'read');
  assert.throws(() => result.toolRegistry.fromResponse('other', 'read'), errorCode('UNKNOWN_TOOL'));
  assert.throws(() => result.toolRegistry.fromResponse(undefined, 'openviking.read'), ProtocolError);
});
test('all read/search/ls function names accepted; duplicate names and unsafe tools rejected', () => {
  const tool = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
  assert.equal(convert({ tools: ['read', 'search', 'ls'].map(tool) }).payload.tools?.[0]?.tools.length, 3);
  assert.throws(() => convert({ tools: [readTool, readTool] }), errorCode('TOOL_COLLISION'));
  assert.throws(() => convert({ tools: [tool('shell')] }), errorCode('UNSUPPORTED_TOOL'));
  assert.throws(() => convert({ tools: [{ type: 'web_search' }] }), ProtocolError);
  assert.throws(() => convert({ tools: [{ ...readTool, function: { ...readTool.function, strict: true } }] }), errorCode('UNSUPPORTED_SCHEMA'));
  assert.throws(() => convert({ tool_choice: 'required' }), errorCode('UNSUPPORTED_TOOL_CHOICE'));
});
test('complete tool turn preserves original call_id and separate namespace in full history', async () => {
  const first = convert({ tools: [readTool] });
  const completion = await aggregateResponsesSse(chunks(frame(terminal([call()]))), first.toolRegistry);
  const assistant = completion.choices[0]!.message;
  assert.equal(completion.choices[0]!.finish_reason, 'tool_calls');
  assert.equal(assistant.content, null);
  assert.deepEqual(assistant.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"uri":"viking://test"}' } }]);
  const follow = convert({ tools: [readTool], messages: [ { role: 'user', content: 'read it' }, assistant,
    { role: 'tool', tool_call_id: 'call_1', name: 'read', content: 'tool output' }, { role: 'user', content: 'summarize' } ] });
  assert.deepEqual(follow.payload.input, [{ role: 'user', content: 'read it' },
    { type: 'function_call', call_id: 'call_1', namespace: 'openviking', name: 'read', arguments: '{"uri":"viking://test"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'tool output' }, { role: 'user', content: 'summarize' }]);
  assert.equal('previous_response_id' in follow.payload, false);
});
test('history orphans, unresolved calls, duplicate outputs, duplicate call IDs and reasoning fields fail closed', () => {
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{"uri":"test"}' } }] };
  const tool = { role: 'tool', tool_call_id: 'c', content: 'ok' };
  for (const messages of [[tool], [assistant], [assistant, tool, tool], [assistant, tool, assistant, tool]]) {
    assert.throws(() => convert({ tools: [readTool], messages }), ProtocolError);
  }
  assert.throws(() => convert({ messages: [{ role: 'assistant', content: 'ok', reasoning_content: 'hidden' }] }), errorCode('UNSUPPORTED_FIELD'));
});
test('history function arguments checked against schema and safe JSON', () => {
  for (const args of ['{', '[]', '{"uri":2}', '{}', '{"uri":"x","unknown":1}', '{"uri":"x","offset":-1}', '{"uri":"x","__proto__":{}}']) {
    assert.throws(() => convert({ tools: [readTool], messages: [{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: args } }] }, { role: 'tool', tool_call_id: 'c', content: 'ok' }] }), ProtocolError);
  }
  assert.throws(() => convertChatRequest({ model: 'alias', messages: [{ role: 'user', content: 'large' }] }, { modelSlug: 'verified', maxRequestBytes: 2 }), errorCode('REQUEST_LIMIT', 413));
});

// Final completion, not deltas, is authoritative. SSE and aggregation never emit partial.
test('normal text + usage buffers until clean terminal EOF; UTF8 bytes and CRLF split safely', async () => {
  const wire = ': keepalive\r\n\r\n' + frame({ type: 'response.output_text.delta', response_id: 'resp_1', output_index: 0, item_id: 'msg_1', delta: 'wrong partial' }, '\r\n') +
    'event: response.completed\r\n' + frame(terminal([message('你好')]), '\r\n') + 'data: [DONE]\r\n\r\n';
  const result = await aggregateResponsesSse(chunks(wire, 1), emptyRegistry);
  assert.equal(result.choices[0]!.message.content, '你好');
  assert.equal(result.choices[0]!.finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 0 } });
});
test('no tool call release on added/done before terminal', () => {
  const agg = new ResponsesAggregator(convert({ tools: [readTool] }).toolRegistry);
  assert.equal(agg.push({ type: 'response.output_item.added', output_index: 0, item: { ...call(), status: 'in_progress', arguments: '' } }), undefined);
  assert.equal(agg.push({ type: 'response.output_item.done', output_index: 0, item: call() }), undefined);
  assert.throws(() => agg.finish(), errorCode('MISSING_COMPLETED'));
});
for (const [type, code] of [['response.failed', 'UPSTREAM_FAILED'], ['response.incomplete', 'UPSTREAM_INCOMPLETE'], ['error', 'UPSTREAM_ERROR'], ['response.error', 'UPSTREAM_ERROR'], ['response.cancelled', 'UNKNOWN_EVENT']] as const) {
  test(`valid delta then ${type} must fail, never return partial`, async () => {
    const wire = frame({ type: 'response.output_text.delta', delta: 'legitimate partial' }) + frame({ type });
    await assert.rejects(aggregateResponsesSse(chunks(wire), emptyRegistry), errorCode(code));
  });
}
test('delta then EOF and DONE without completed fail', async () => {
  await assert.rejects(aggregateResponsesSse(chunks(frame({ type: 'response.output_text.delta', delta: 'partial' })), emptyRegistry), errorCode('MISSING_COMPLETED'));
  await assert.rejects(aggregateResponsesSse(chunks('data: [DONE]\n\n'), emptyRegistry), errorCode('INVALID_TERMINAL'));
});
for (const status of ['incomplete', 'failed', 'cancelled', 'unknown']) {
  test(`response.completed with status ${status} is not success`, async () => {
    await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([message()], { status }))), emptyRegistry), errorCode('INVALID_TERMINAL'));
  });
}
test('completed with error/incomplete_details rejected', async () => {
  for (const extra of [{ error: { code: 'bad' } }, { incomplete_details: { reason: 'limit' } }]) {
    await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([message()], extra))), emptyRegistry), errorCode('INVALID_TERMINAL'));
  }
});
for (const args of ['{', '[]', '{"uri":1}', '{"uri":"x","unknown":true}', '{"uri":"x","constructor":{}}']) {
  test(`damaged/unsafe terminal function JSON rejected: ${args}`, async () => {
    await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([call(args)]))), convert({ tools: [readTool] }).toolRegistry), ProtocolError);
  });
}
test('unknown function namespace, incomplete function, duplicate call/item identities rejected', async () => {
  const registry = convert({ tools: [readTool] }).toolRegistry;
  for (const output of [[call(undefined, { namespace: 'other' })], [call(undefined, { status: 'incomplete' })], [call(), call(undefined, { id: 'fc_2' })], [message(), message()]]) {
    await assert.rejects(aggregateResponsesSse(chunks(frame(terminal(output))), registry), ProtocolError);
  }
});
test('duplicate terminal or a trailing error is failure even after a valid completed', async () => {
  for (const ending of [terminal(), { type: 'error' }, { type: 'response.failed' }]) {
    await assert.rejects(aggregateResponsesSse(chunks(frame(terminal()) + frame(ending)), emptyRegistry), errorCode('DUPLICATE_TERMINAL'));
  }
});
test('response/item/call identity mutations and absent terminal items rejected', async () => {
  for (const preceding of [
    { type: 'response.created', response: { id: 'other', model: 'verified-model-slug', status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'other', delta: 'p' },
    { type: 'response.output_text.delta', output_index: 2, item_id: 'msg_3', delta: 'p' },
    { type: 'response.output_item.done', output_index: 0, item: message('different final') },
  ]) await assert.rejects(aggregateResponsesSse(chunks(frame(preceding) + frame(terminal())), emptyRegistry), errorCode('IDENTITY_MISMATCH'));
  const registry = convert({ tools: [readTool] }).toolRegistry;
  const added = { type: 'response.output_item.added', output_index: 0, item: call(undefined, { call_id: 'other', status: 'in_progress', arguments: '' }) };
  await assert.rejects(aggregateResponsesSse(chunks(frame(added) + frame(terminal([call()]))), registry), errorCode('IDENTITY_MISMATCH'));
});
test('event sequence reuse, duplicate output done and terminal response identity rejected', () => {
  const agg = new ResponsesAggregator(emptyRegistry);
  agg.push({ type: 'response.output_text.delta', sequence_number: 1, delta: 'p' });
  assert.throws(() => agg.push({ type: 'response.output_text.delta', sequence_number: 1, delta: 'p' }), errorCode('DUPLICATE_IDENTITY'));
  assert.throws(() => agg.finish(), errorCode('DUPLICATE_IDENTITY')); // failure is sticky
  const done = new ResponsesAggregator(emptyRegistry);
  done.push({ type: 'response.output_item.done', output_index: 0, item: message() });
  assert.throws(() => done.push({ type: 'response.output_item.done', output_index: 0, item: message() }), errorCode('DUPLICATE_IDENTITY'));
  const identity = new ResponsesAggregator(emptyRegistry);
  assert.throws(() => identity.push({ ...terminal(), response_id: 'other' }), errorCode('IDENTITY_MISMATCH'));
});
test('unknown outputs/refusal/reasoning/annotations must not be silently discarded', async () => {
  for (const item of [
    { id: 'rs', type: 'reasoning', status: 'completed', encrypted_content: 'synthetic', summary: [] },
    { id: 'unknown', type: 'new_tool_call', status: 'completed' },
    { ...message(), content: [{ type: 'refusal', refusal: 'no' }] },
    { ...message(), content: [{ type: 'output_text', text: 'hi', annotations: [{ type: 'url_citation' }] }] },
  ]) await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([item]))), emptyRegistry), ProtocolError);
  await assert.rejects(aggregateResponsesSse(chunks(frame({ type: 'response.reasoning_summary_text.delta', delta: 'r' })), emptyRegistry), errorCode('UNSUPPORTED_REASONING'));
  await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([message()], { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } } }))), emptyRegistry), errorCode('UNSUPPORTED_REASONING'));
});
test('invalid usage, empty final and unfinished message are not successful completion', async () => {
  for (const event of [terminal([], {}), terminal([message()], { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 4 } }),
    terminal([{ ...message(), status: 'in_progress' }]), terminal([message()], { usage: null })]) {
    await assert.rejects(aggregateResponsesSse(chunks(frame(event)), emptyRegistry), ProtocolError);
  }
});
test('SSE multiline data, CR-only frames and standard comment/id/retry metadata', async () => {
  const data = JSON.stringify(terminal());
  const split = data.indexOf(',');
  const wire = `:ping\rid: opaque\rretry: 100\revent: response.completed\rdata: ${data.slice(0, split + 1)}\rdata: ${data.slice(split + 1)}\r\r`;
  assert.equal((await aggregateResponsesSse(chunks(wire, 1), emptyRegistry)).choices[0]!.message.content, 'hello');
});
test('SSE truncated terminal, name mismatch, malformed JSON and invalid UTF8 rejected', async () => {
  for (const [wire, code] of [[frame(terminal()).slice(0, -1), 'TRUNCATED_SSE'], ['event: wrong\n' + frame(terminal()), 'IDENTITY_MISMATCH'], ['data: {\n\n', 'INVALID_JSON'], ['unknown: value\n\n', 'INVALID_SSE']] as const) {
    await assert.rejects(aggregateResponsesSse(chunks(wire), emptyRegistry), errorCode(code));
  }
  async function* badUtf8() { yield new Uint8Array([0xc3]); }
  await assert.rejects(aggregateResponsesSse(badUtf8(), emptyRegistry), errorCode('INVALID_UTF8'));
});
test('named failed frame without JSON data cannot be silently ignored after completed', async () => {
  await assert.rejects(aggregateResponsesSse(chunks(frame(terminal()) + 'event: response.failed\n\n'), emptyRegistry), errorCode('INVALID_SSE'));
});
test('reasoning hidden in nonterminal response envelope is rejected', async () => {
  const event = { type: 'response.in_progress', response: { id: 'resp_1', status: 'in_progress', output: [{ type: 'reasoning', id: 'rs_1' }] } };
  await assert.rejects(aggregateResponsesSse(chunks(frame(event) + frame(terminal())), emptyRegistry), errorCode('UNSUPPORTED_REASONING'));
});
test('SSE size/line/frame/event limits bounded and no partial released', async () => {
  await assert.rejects(aggregateResponsesSse(chunks(frame(terminal())), emptyRegistry, { maxTotalBytes: 10 }), errorCode('SIZE_LIMIT'));
  await assert.rejects(aggregateResponsesSse(chunks(frame(terminal())), emptyRegistry, { maxLineBytes: 10 }), errorCode('LINE_LIMIT'));
  await assert.rejects(aggregateResponsesSse(chunks(':12345\n:12345\n\n'), emptyRegistry, { maxEventBytes: 10 }), errorCode('EVENT_SIZE_LIMIT'));
  await assert.rejects(aggregateResponsesSse(chunks(frame({ type: 'response.output_text.delta', delta: 'p' }) + frame(terminal())), emptyRegistry, { maxEvents: 1 }), errorCode('EVENT_LIMIT'));
});
test('wall-clock timeout interrupts idle iterator; source cleanup requested', async () => {
  let returned = false;
  const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
    next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    return: async () => { returned = true; return { done: true, value: undefined }; },
  }; } };
  await assert.rejects(aggregateResponsesSse(source, emptyRegistry, { maxDurationMs: 10 }), errorCode('TIME_LIMIT', 504));
  assert.equal(returned, true);
});
test('cancel interrupts idle iterator and pre-cancel never consumes input', async () => {
  const controller = new AbortController();
  const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
    next: () => { controller.abort(); return new Promise<IteratorResult<Uint8Array>>(() => undefined); },
  }; } };
  await assert.rejects(aggregateResponsesSse(source, emptyRegistry, { signal: controller.signal }), errorCode('CANCELLED', 499));
  let consumed = false;
  async function* neverRead() { consumed = true; yield new Uint8Array(); }
  await assert.rejects(aggregateResponsesSse(neverRead(), emptyRegistry, { signal: controller.signal }), errorCode('CANCELLED', 499));
  assert.equal(consumed, false);
});
test('duplicate escaped JSON argument keys rejected before executing tools', async () => {
  const registry = convert({ tools: [readTool] }).toolRegistry;
  for (const args of ['{"uri":"one","uri":"two"}', '{"uri":"one","\\u0075ri":"two"}']) {
    await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([call(args)]))), registry), errorCode('DUPLICATE_JSON_KEY'));
  }
});
test('history call IDs cannot be replayed as new tool calls', async () => {
  const request = convert({ tools: [readTool], messages: [{ role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"uri":"test"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'synthetic' }] });
  await assert.rejects(aggregateResponsesSse(chunks(frame(terminal([call()]))), request.toolRegistry), errorCode('DUPLICATE_IDENTITY'));
});
test('duplicate response.created and repeated delta item ID at distinct indexes rejected', () => {
  const agg = new ResponsesAggregator(emptyRegistry);
  const created = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } };
  agg.push(created);
  assert.throws(() => agg.push(created), errorCode('DUPLICATE_IDENTITY'));
  const items = new ResponsesAggregator(emptyRegistry);
  items.push({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: 'p' });
  assert.throws(() => items.push({ type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', delta: 'p' }), errorCode('DUPLICATE_IDENTITY'));
});
test('source exception after completed still fails rather than commits output', async () => {
  async function* broken() { yield new TextEncoder().encode(frame(terminal())); throw new Error('synthetic transport break'); }
  await assert.rejects(aggregateResponsesSse(broken(), emptyRegistry), errorCode('TRANSPORT_ERROR', 502));
});
