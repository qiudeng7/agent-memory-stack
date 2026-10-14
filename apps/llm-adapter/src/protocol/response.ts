import { ToolRegistry } from './request.js';
import { array, fail, integer, keys, object, ProtocolError, safeJson, text, validateArguments, type RecordValue } from './validation.js';

export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatCompletion {
  id: string; object: 'chat.completion'; created: number; model: string;
  choices: Array<{ index: 0; message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }; finish_reason: 'stop' | 'tool_calls' }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: RecordValue; completion_tokens_details?: RecordValue };
}
export interface ResponseLimits { maxTotalBytes?: number; maxEvents?: number; maxDurationMs?: number }
export interface AggregateOptions extends ResponseLimits { signal?: AbortSignal }
const allowedEvents = new Set([
  'response.created', 'response.in_progress', 'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
]);
interface ObservedItem { id: string; type: string; callId?: string; namespace?: string; name?: string; done?: RecordValue }

/** Terminal result is private until finish() after transport EOF, so duplicates/trailing errors fail closed. */
export class ResponsesAggregator {
  private readonly start = performance.now();
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly maxDuration: number;
  private bytes = 0;
  private events = 0;
  private responseId: string | undefined;
  private model: string | undefined;
  private completed: RecordValue | undefined;
  private failure: ProtocolError | undefined;
  private closed = false;
  private createdSeen = false;
  private readonly items = new Map<number, ObservedItem>();
  private readonly observedIndexes = new Set<number>();
  private readonly sequenceNumbers = new Set<number>();
  private lastSequence = -1;
  constructor(private readonly registry: ToolRegistry, private readonly options: AggregateOptions = {}) {
    this.maxBytes = integer(options.maxTotalBytes ?? 2_097_152, 'maxTotalBytes', 1);
    this.maxEvents = integer(options.maxEvents ?? 10_000, 'maxEvents', 1);
    this.maxDuration = integer(options.maxDurationMs ?? 120_000, 'maxDurationMs', 1);
  }
  checkLimits(): void {
    if (this.failure) throw this.failure;
    if (this.options.signal?.aborted) this.reject('CANCELLED', 'Request cancelled', 499);
    if (performance.now() - this.start >= this.maxDuration) this.reject('TIME_LIMIT', 'Responses stream exceeded time limit', 504);
  }
  private reject(code: string, message: string, status = 502): never {
    this.failure = new ProtocolError(code, message, status);
    throw this.failure;
  }
  push(raw: unknown): void {
    try {
      this.checkLimits();
      if (this.closed) this.reject('STREAM_CLOSED', 'Aggregator already finished');
      safeJson(raw);
      const event = object(raw, 'Responses event');
      if (++this.events > this.maxEvents) this.reject('EVENT_LIMIT', 'Event count limit exceeded');
      this.bytes += new TextEncoder().encode(JSON.stringify(raw)).byteLength;
      if (this.bytes > this.maxBytes) this.reject('SIZE_LIMIT', 'Responses events exceed size limit');
      if (this.completed) this.reject('DUPLICATE_TERMINAL', 'Event received after response.completed');
      const type = text(event.type, 'event.type', true);
      if (event.sequence_number !== undefined) {
        const sequence = integer(event.sequence_number, 'sequence_number');
        if (this.sequenceNumbers.has(sequence) || sequence <= this.lastSequence) this.reject('DUPLICATE_IDENTITY', 'Duplicate/out-of-order event sequence');
        this.sequenceNumbers.add(sequence);
        this.lastSequence = sequence;
      }
      if (type === 'response.created') {
        if (this.createdSeen) this.reject('DUPLICATE_IDENTITY', 'Duplicate response.created');
        this.createdSeen = true;
      }
      if (event.response_id !== undefined) this.identify(text(event.response_id, 'response_id', true));
      if (event.response !== undefined) {
        const response = object(event.response, 'response');
        this.identify(text(response.id, 'response.id', true));
        if (response.model !== undefined) {
          const model = text(response.model, 'response.model', true);
          if (this.model !== undefined && this.model !== model) this.reject('IDENTITY_MISMATCH', 'Response model changed');
          this.model = model;
        }
        if (type !== 'response.completed' && !['response.failed', 'response.incomplete'].includes(type) && response.status !== 'in_progress' && response.status !== 'queued') this.reject('UNKNOWN_TERMINAL', 'Unexpected response status');
        if (type !== 'response.completed' && response.output !== undefined) {
          for (const rawItem of array(response.output, 'response.output')) {
            const item = object(rawItem, 'response output item');
            if (item.type !== 'message' && item.type !== 'function_call') this.reject(item.type === 'reasoning' ? 'UNSUPPORTED_REASONING' : 'UNKNOWN_OUTPUT', 'Unsupported nonterminal output item');
          }
        }
      }
      if (type === 'response.failed') this.reject('UPSTREAM_FAILED', 'Upstream response failed');
      if (type === 'response.incomplete') this.reject('UPSTREAM_INCOMPLETE', 'Upstream response incomplete');
      if (type === 'error' || type === 'response.error') this.reject('UPSTREAM_ERROR', 'Upstream stream error');
      if (type === 'response.completed') {
        const response = object(event.response, 'completed response');
        if (response.status !== 'completed' || response.error != null || response.incomplete_details != null) this.reject('INVALID_TERMINAL', 'Completed event is not successful');
        // Validate final output now, but never expose it until finish().
        this.parseCompleted(response);
        this.completed = structuredClone(response);
        return;
      }
      if (!allowedEvents.has(type)) this.reject(type.includes('reasoning') ? 'UNSUPPORTED_REASONING' : 'UNKNOWN_EVENT', 'Unsupported Responses event; session bridge may be required');
      if (event.output_index !== undefined) {
        const index = integer(event.output_index, 'output_index');
        this.observedIndexes.add(index);
        if (event.item_id !== undefined) {
          const id = text(event.item_id, 'item_id', true);
          const known = this.items.get(index);
          const inferredType = type.includes('function_call') ? 'function_call' : 'message';
          if (known && (known.id !== id || known.type !== inferredType)) this.reject('IDENTITY_MISMATCH', 'Output item ID/type changed');
          for (const [otherIndex, other] of this.items) if (otherIndex !== index && other.id === id) this.reject('DUPLICATE_IDENTITY', 'Output item ID reused');
          if (!known) this.items.set(index, { id, type: inferredType });
        }
        if (event.item !== undefined) this.observeItem(index, object(event.item, 'event.item'), type.endsWith('.done'));
      } else if (event.item !== undefined) this.reject('INVALID_EVENT', 'Output item event lacks index');
      if (event.part !== undefined) {
        const part = object(event.part, 'content part');
        if (part.type !== 'output_text') this.reject('UNKNOWN_OUTPUT', 'Unsupported output content part');
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.failure = error.status === 400 ? new ProtocolError(error.code, error.message, 502) : error;
        throw this.failure;
      }
      this.reject('INVALID_EVENT', 'Invalid event data');
    }
  }
  private identify(id: string): void {
    if (this.responseId !== undefined && this.responseId !== id) this.reject('IDENTITY_MISMATCH', 'Response ID changed');
    this.responseId = id;
  }
  private observeItem(index: number, item: RecordValue, done: boolean): void {
    const id = text(item.id, 'output item.id', true);
    const type = text(item.type, 'output item.type', true);
    if (!['message', 'function_call'].includes(type)) this.reject(type === 'reasoning' ? 'UNSUPPORTED_REASONING' : 'UNKNOWN_OUTPUT', 'Unsupported output item; full reasoning session bridge is not implemented');
    const known = this.items.get(index);
    if (known && (known.id !== id || known.type !== type)) this.reject('IDENTITY_MISMATCH', 'Output item identity changed');
    for (const [otherIndex, other] of this.items) if (otherIndex !== index && other.id === id) this.reject('DUPLICATE_IDENTITY', 'Output item ID reused');
    const observed: ObservedItem = { id, type };
    if (type === 'function_call') {
      observed.callId = text(item.call_id, 'call_id', true);
      const binding = this.registry.fromResponse(item.namespace, item.name);
      observed.namespace = binding.namespace;
      observed.name = binding.name;
      if (known?.callId !== undefined && (known.callId !== observed.callId || known.namespace !== observed.namespace || known.name !== observed.name)) this.reject('IDENTITY_MISMATCH', 'Function call identity changed');
    }
    if (done) {
      if (known?.done) this.reject('DUPLICATE_IDENTITY', 'Duplicate output_item.done');
      observed.done = structuredClone(item);
    } else if (known?.done) this.reject('INVALID_EVENT', 'Item added after done');
    this.items.set(index, observed);
  }
  private parseCompleted(response: RecordValue): ChatCompletion {
    const id = text(response.id, 'response.id', true);
    const model = text(response.model, 'response.model', true);
    const created = integer(response.created_at, 'response.created_at');
    const output = array(response.output, 'response.output');
    const ids = new Set<string>();
    const callIds = new Set<string>();
    const calls: ChatToolCall[] = [];
    const content: string[] = [];
    for (const index of this.observedIndexes) if (index >= output.length) this.reject('IDENTITY_MISMATCH', 'Observed output missing from terminal');
    output.forEach((raw, index) => {
      const item = object(raw, 'output item');
      const itemId = text(item.id, 'output item.id', true);
      if (ids.has(itemId)) this.reject('DUPLICATE_IDENTITY', 'Duplicate terminal output ID');
      ids.add(itemId);
      const observed = this.items.get(index);
      if (observed && (observed.id !== itemId || observed.type !== item.type)) this.reject('IDENTITY_MISMATCH', 'Terminal output identity mismatch');
      if (item.status !== 'completed') this.reject('INVALID_TERMINAL', 'Output item is not completed');
      if (item.type === 'message') {
        keys(item, ['type', 'id', 'status', 'role', 'content'], 'output message');
        if (item.role !== 'assistant') this.reject('UNKNOWN_OUTPUT', 'Non-assistant response output');
        for (const rawPart of array(item.content, 'output content')) {
          const part = object(rawPart, 'output content part');
          keys(part, ['type', 'text', 'annotations', 'logprobs'], 'output content part');
          if (part.type !== 'output_text') this.reject('UNKNOWN_OUTPUT', 'Unsupported content output type');
          if (part.annotations !== undefined && array(part.annotations, 'annotations').length) this.reject('UNKNOWN_OUTPUT', 'Annotations need a lossless bridge');
          if (part.logprobs !== undefined && array(part.logprobs, 'logprobs').length) this.reject('UNKNOWN_OUTPUT', 'Logprobs are not supported');
          content.push(text(part.text, 'output_text'));
        }
      } else if (item.type === 'function_call') {
        keys(item, ['type', 'id', 'status', 'call_id', 'namespace', 'name', 'arguments'], 'output function');
        const binding = this.registry.fromResponse(item.namespace, item.name);
        const callId = text(item.call_id, 'call_id', true);
        if (callIds.has(callId) || this.registry.isHistoricalCallId(callId)) this.reject('DUPLICATE_IDENTITY', 'Duplicate or historical terminal call_id');
        callIds.add(callId);
        if (observed?.callId !== undefined && (observed.callId !== callId || observed.namespace !== binding.namespace || observed.name !== binding.name)) this.reject('IDENTITY_MISMATCH', 'Terminal function identity mismatch');
        calls.push({ id: callId, type: 'function', function: { name: binding.originalName, arguments: validateArguments(item.arguments, binding.parameters) } });
      } else this.reject(item.type === 'reasoning' ? 'UNSUPPORTED_REASONING' : 'UNKNOWN_OUTPUT', 'Unknown output type; reasoning/session bridge not implemented');
      if (observed?.done) {
        for (const key of ['type', 'id', 'status', 'role', 'call_id', 'namespace', 'name', 'arguments', 'content']) {
          if (JSON.stringify(observed.done[key]) !== JSON.stringify(item[key])) this.reject('IDENTITY_MISMATCH', 'Done item disagrees with terminal');
        }
      }
    });
    if (output.length === 0 || (content.length === 0 && calls.length === 0)) this.reject('INVALID_TERMINAL', 'Empty final output');
    const usage = object(response.usage, 'response.usage');
    keys(usage, ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'], 'usage');
    const prompt = integer(usage.input_tokens, 'input_tokens');
    const completion = integer(usage.output_tokens, 'output_tokens');
    const total = integer(usage.total_tokens, 'total_tokens');
    if (total !== prompt + completion) this.reject('INVALID_USAGE', 'Token usage totals mismatch');
    const result: ChatCompletion = {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: content.length ? content.join('') : null }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
    };
    if (calls.length) result.choices[0]!.message.tool_calls = calls;
    if (usage.input_tokens_details != null) {
      const details = object(usage.input_tokens_details, 'input token details');
      keys(details, ['cached_tokens'], 'input token details');
      if (details.cached_tokens !== undefined && integer(details.cached_tokens, 'cached_tokens') > prompt) this.reject('INVALID_USAGE', 'Cached tokens exceed input tokens');
      result.usage.prompt_tokens_details = structuredClone(details);
    }
    if (usage.output_tokens_details != null) {
      const details = object(usage.output_tokens_details, 'output token details');
      keys(details, ['reasoning_tokens'], 'output token details');
      if (details.reasoning_tokens !== undefined && integer(details.reasoning_tokens, 'reasoning_tokens') > 0) this.reject('UNSUPPORTED_REASONING', 'Reasoning tokens require a lossless session bridge');
      result.usage.completion_tokens_details = structuredClone(details);
    }
    return result;
  }
  finish(): ChatCompletion {
    try {
      this.checkLimits();
      if (this.closed) this.reject('STREAM_CLOSED', 'Aggregator already finished');
      this.closed = true;
      if (!this.completed) this.reject('MISSING_COMPLETED', 'EOF without response.completed');
      return this.parseCompleted(this.completed);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.failure = error.status === 400 ? new ProtocolError(error.code, error.message, 502) : error;
        throw this.failure;
      }
      return this.reject('INVALID_TERMINAL', 'Invalid completed response');
    }
  }
}
