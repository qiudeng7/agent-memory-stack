import { array, checkSchema, fail, integer, keys, object, safeJson, text, validateArguments, type RecordValue } from './validation.js';

export interface FunctionTool {
  type: 'function'; name: string; description?: string; parameters: RecordValue; strict: boolean;
}
export interface ToolBinding { readonly namespace: string; readonly name: string; readonly originalName: string; readonly parameters: RecordValue }
/** Pair-keyed namespace mapping; never flatten/sanitize names, which can collide. */
export class ToolRegistry {
  private readonly byName = new Map<string, ToolBinding>();
  private readonly byPair = new Map<string, ToolBinding>();
  private readonly historicalCallIds: ReadonlySet<string>;
  constructor(bindings: readonly ToolBinding[], historicalCallIds: readonly string[] = []) {
    this.historicalCallIds = new Set(historicalCallIds);
    for (const binding of bindings) {
      const pair = JSON.stringify([binding.namespace, binding.name]);
      if (this.byName.has(binding.originalName) || this.byPair.has(pair)) fail('TOOL_COLLISION', 'Duplicate tool mapping');
      const copy = Object.freeze({ ...binding, parameters: structuredClone(binding.parameters) });
      this.byName.set(binding.originalName, copy);
      this.byPair.set(pair, copy);
    }
  }
  isHistoricalCallId(callId: string): boolean { return this.historicalCallIds.has(callId); }
  fromChat(name: string): ToolBinding {
    const binding = this.byName.get(name);
    if (!binding) fail('UNKNOWN_TOOL', 'Tool is not in the request registry');
    return { ...binding, parameters: structuredClone(binding.parameters) };
  }
  fromResponse(namespace: unknown, name: unknown): ToolBinding {
    const binding = this.byPair.get(JSON.stringify([text(namespace, 'function namespace', true), text(name, 'function name', true)]));
    if (!binding) fail('UNKNOWN_TOOL', 'Unknown namespace/tool pair', 502);
    return { ...binding, parameters: structuredClone(binding.parameters) };
  }
}
export interface PublicResponsesPayload {
  model: string; store: false; stream: true; input: RecordValue[];
  tools?: Array<{ type: 'namespace'; name: string; description: string; tools: FunctionTool[] }>;
  tool_choice?: 'auto' | 'none';
}
export interface ConvertOptions { modelSlug: string; maxRequestBytes?: number }
export interface ConvertedRequest { payload: PublicResponsesPayload; toolRegistry: ToolRegistry; ignoredParameters: string[]; requestedModel: string }

/**
 * Offline ChatCompletions -> SIWC public Responses. Parent resolves model aliases
 * against the selected account catalog and supplies the verified modelSlug.
 * Official shape: https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces
 * Function call namespace is a separate field, verified in Responses create reference.
 */
export function convertChatRequest(raw: unknown, options: ConvertOptions): ConvertedRequest {
  safeJson(raw);
  const request = object(raw, 'request');
  keys(request, ['model', 'messages', 'tools', 'tool_choice', 'stream', 'max_tokens', 'max_completion_tokens', 'n'], 'request');
  const maxBytes = integer(options.maxRequestBytes ?? 1_048_576, 'maxRequestBytes', 1);
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > maxBytes) fail('REQUEST_LIMIT', 'Request exceeds byte limit', 413);
  const requestedModel = text(request.model, 'model', true);
  const model = text(options.modelSlug, 'verified modelSlug', true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) fail('INVALID_MODEL', 'Invalid verified model slug');
  if (request.stream !== undefined && request.stream !== false) fail('UNSUPPORTED_STREAM', 'OV streaming is not supported; responses are buffered');
  if (request.n !== undefined && request.n !== 1) fail('UNSUPPORTED_FIELD', 'Only n=1 is supported');
  const ignoredParameters: string[] = [];
  // Explicit OV compatibility whitelist. These are not SIWC output caps and never forwarded.
  for (const parameter of ['max_tokens', 'max_completion_tokens'] as const) {
    if (request[parameter] !== undefined) { integer(request[parameter], parameter, 1); ignoredParameters.push(parameter); }
  }
  const namespace = 'openviking';
  const tools: FunctionTool[] = [];
  const bindings: ToolBinding[] = [];
  if (request.tools !== undefined) for (const entry of array(request.tools, 'tools')) {
    const wrapper = object(entry, 'tool');
    keys(wrapper, ['type', 'function'], 'tool');
    if (wrapper.type !== 'function') fail('UNSUPPORTED_TOOL', 'Only read/search/ls functions are supported');
    const fn = object(wrapper.function, 'tool.function');
    keys(fn, ['name', 'description', 'parameters', 'strict'], 'tool.function');
    const name = text(fn.name, 'tool name', true);
    if (!['read', 'search', 'ls'].includes(name)) fail('UNSUPPORTED_TOOL', 'Only read/search/ls functions are supported');
    const parameters = checkSchema(fn.parameters);
    if (parameters.type !== 'object') fail('INVALID_SCHEMA', 'Function parameters must be an object');
    if (fn.strict !== undefined && fn.strict !== false) fail('UNSUPPORTED_SCHEMA', 'Strict function schemas require a future explicit normalization policy');
    const tool: FunctionTool = { type: 'function', name, parameters: structuredClone(parameters), strict: false };
    if (fn.description !== undefined) tool.description = text(fn.description, 'function description');
    tools.push(tool);
    bindings.push({ namespace, name, originalName: name, parameters });
  }
  const toolRegistry = new ToolRegistry(bindings);
  const input: RecordValue[] = [];
  const callIds = new Set<string>();
  const pending = new Map<string, ToolBinding>();
  const messages = array(request.messages, 'messages');
  if (messages.length === 0) fail('INVALID_HISTORY', 'Messages must not be empty');
  for (const entry of messages) {
    const message = object(entry, 'message');
    const role = text(message.role, 'message.role');
    if (role === 'tool') {
      keys(message, ['role', 'content', 'tool_call_id', 'name'], 'tool message');
      const callId = text(message.tool_call_id, 'tool_call_id', true);
      const binding = pending.get(callId);
      if (!binding) fail('INVALID_HISTORY', 'Orphan or duplicate tool output');
      if (message.name !== undefined && message.name !== binding.originalName) fail('INVALID_HISTORY', 'Tool output name mismatch');
      input.push({ type: 'function_call_output', call_id: callId, output: text(message.content, 'tool output') });
      pending.delete(callId);
      continue;
    }
    if (!['user', 'system', 'developer', 'assistant'].includes(role)) fail('UNSUPPORTED_ROLE', 'Unsupported message role');
    if (pending.size > 0) fail('INVALID_HISTORY', 'Tool outputs must resolve all previous calls before next message');
    keys(message, role === 'assistant' ? ['role', 'content', 'tool_calls'] : ['role', 'content'], 'message');
    if (message.content !== null && message.content !== undefined) {
      let content: string;
      if (typeof message.content === 'string') content = message.content;
      else {
        // Standard ChatCompletions text parts only; images/files/audio are fail-closed.
        content = array(message.content, 'content').map(part => {
          const item = object(part, 'text part');
          keys(item, ['type', 'text'], 'text part');
          if (item.type !== 'text') fail('UNSUPPORTED_INPUT', 'Only text content is supported');
          return text(item.text, 'text part.text');
        }).join('');
      }
      // Easy input messages, not explicit system type:message (SIWC rejects those).
      input.push({ role: role === 'system' ? 'developer' : role, content });
    } else if (role !== 'assistant' || message.tool_calls === undefined) fail('INVALID_HISTORY', 'Text content is required');
    if (message.tool_calls !== undefined) {
      const calls = array(message.tool_calls, 'assistant tool_calls');
      if (calls.length === 0) fail('INVALID_HISTORY', 'Empty tool_calls are not supported');
      for (const entry of calls) {
        const call = object(entry, 'tool call');
        keys(call, ['id', 'type', 'function'], 'tool call');
        if (call.type !== 'function') fail('UNSUPPORTED_TOOL', 'Only function tool calls supported');
        const callId = text(call.id, 'call id', true);
        if (callIds.has(callId)) fail('DUPLICATE_IDENTITY', 'Duplicate history call_id');
        callIds.add(callId);
        const fn = object(call.function, 'call.function');
        keys(fn, ['name', 'arguments'], 'call.function');
        const binding = toolRegistry.fromChat(text(fn.name, 'function name', true));
        const argumentsText = validateArguments(fn.arguments, binding.parameters);
        input.push({ type: 'function_call', call_id: callId, namespace: binding.namespace, name: binding.name, arguments: argumentsText });
        pending.set(callId, binding);
      }
    }
  }
  if (pending.size > 0) fail('INVALID_HISTORY', 'Unresolved tool call in history');
  const payload: PublicResponsesPayload = { model, store: false, stream: true, input };
  if (tools.length) payload.tools = [{ type: 'namespace', name: namespace, description: 'OpenViking read-only memory tools.', tools }];
  if (request.tool_choice !== undefined) {
    if (request.tool_choice !== 'auto' && request.tool_choice !== 'none') fail('UNSUPPORTED_TOOL_CHOICE', 'Only auto/none tool choice is supported');
    payload.tool_choice = request.tool_choice;
  }
  return { payload, toolRegistry: new ToolRegistry(bindings, [...callIds]), ignoredParameters, requestedModel };
}
