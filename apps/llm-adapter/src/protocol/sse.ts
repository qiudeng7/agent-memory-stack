import { ResponsesAggregator, type AggregateOptions, type ChatCompletion } from './response.js';
import { ToolRegistry } from './request.js';
import { fail, integer, object, parseJson, ProtocolError } from './validation.js';

export interface SseOptions extends AggregateOptions { maxEventBytes?: number; maxLineBytes?: number }
/** Finite UTF-8 SSE decoder: no network, SDK, or partial OV output. */
class FiniteSseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly encoder = new TextEncoder();
  private line = '';
  private lineBytes = 0;
  private data: string[] = [];
  private eventName = '';
  private frameBytes = 0;
  private skipLf = false;
  private first = true;
  private completed = false;
  private done = false;
  private totalBytes = 0;
  constructor(private readonly aggregate: ResponsesAggregator, private readonly maxTotalBytes: number,
    private readonly maxEventBytes: number, private readonly maxLineBytes: number) {}
  feed(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) fail('INVALID_SSE', 'SSE source must yield Uint8Array', 502);
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maxTotalBytes) fail('SIZE_LIMIT', 'SSE stream exceeds byte limit', 502);
    let decoded: string;
    try { decoded = this.decoder.decode(chunk, { stream: true }); }
    catch { fail('INVALID_UTF8', 'Invalid SSE UTF-8', 502); }
    this.consume(decoded);
  }
  private consume(decoded: string): void {
    for (const char of decoded) {
      if (this.first) { this.first = false; if (char === '\uFEFF') continue; }
      if (this.skipLf) { this.skipLf = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') {
        this.processLine(this.line);
        this.line = '';
        this.lineBytes = 0;
        if (char === '\r') this.skipLf = true;
        continue;
      }
      this.lineBytes += this.encoder.encode(char).byteLength;
      if (this.lineBytes > this.maxLineBytes) fail('LINE_LIMIT', 'SSE line exceeds byte limit', 502);
      this.line += char;
    }
  }
  private processLine(line: string): void {
    this.frameBytes += this.encoder.encode(line).byteLength + 1;
    if (this.frameBytes > this.maxEventBytes) fail('EVENT_SIZE_LIMIT', 'SSE frame exceeds byte limit', 502);
    if (line === '') {
      if (this.data.length) this.dispatch();
      else if (this.eventName) fail('INVALID_SSE', 'Named SSE event has no data', 502);
      this.data = [];
      this.eventName = '';
      this.frameBytes = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') {
      if (this.eventName !== '') fail('INVALID_SSE', 'Duplicate SSE event name', 502);
      this.eventName = value;
    } else if (field === 'id' || field === 'retry') {
      // SSE reconnection metadata does not change response identity. No automatic retries.
    } else fail('INVALID_SSE', 'Unknown SSE field', 502);
  }
  private dispatch(): void {
    const data = this.data.join('\n');
    if (data === '[DONE]') {
      if (!this.completed || this.done) fail('INVALID_TERMINAL', 'Unexpected or duplicate SSE DONE marker', 502);
      this.done = true;
      return;
    }
    if (this.done) fail('DUPLICATE_TERMINAL', 'SSE data received after DONE', 502);
    const event = object(parseJson(data, 'SSE event'), 'SSE event');
    if (this.eventName && this.eventName !== event.type) fail('IDENTITY_MISMATCH', 'SSE event name and JSON type disagree', 502);
    this.aggregate.push(event);
    if (event.type === 'response.completed') this.completed = true;
  }
  finish(): void {
    let tail: string;
    try { tail = this.decoder.decode(); }
    catch { fail('INVALID_UTF8', 'Truncated SSE UTF-8', 502); }
    this.consume(tail);
    // SSE frames require a blank-line boundary. Never manufacture a terminal at EOF.
    if (this.line.length || this.data.length || this.eventName) fail('TRUNCATED_SSE', 'EOF inside SSE frame', 502);
  }
}

/**
 * Buffer until successful completed + clean EOF. Deadline/cancel also interrupts an
 * idle iterator. Parent must abort its HTTP transport on rejection; iterator.return
 * is best-effort and intentionally not awaited (a stalled iterator may never return).
 */
export async function aggregateResponsesSse(source: AsyncIterable<Uint8Array>, registry: ToolRegistry, options: SseOptions = {}): Promise<ChatCompletion> {
  const duration = integer(options.maxDurationMs ?? 120_000, 'maxDurationMs', 1);
  if (duration > 2_147_483_647) fail('INVALID_LIMIT', 'Duration exceeds timer range');
  const aggregate = new ResponsesAggregator(registry, options);
  aggregate.checkLimits();
  const parser = new FiniteSseParser(aggregate, integer(options.maxTotalBytes ?? 2_097_152, 'maxTotalBytes', 1),
    integer(options.maxEventBytes ?? 524_288, 'maxEventBytes', 1), integer(options.maxLineBytes ?? 524_288, 'maxLineBytes', 1));
  const iterator = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let ended = false;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProtocolError('TIME_LIMIT', 'Responses stream exceeded time limit', 504)), duration);
    abortHandler = () => reject(new ProtocolError('CANCELLED', 'Request cancelled', 499));
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), stopped]);
      aggregate.checkLimits();
      if (next.done) { ended = true; break; }
      parser.feed(next.value);
    }
    parser.finish();
    return aggregate.finish();
  } catch (error) {
    if (error instanceof ProtocolError) throw error.status === 400 ? new ProtocolError(error.code, error.message, 502) : error;
    throw new ProtocolError('TRANSPORT_ERROR', 'Responses stream interrupted', 502);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
    if (!ended && iterator.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); }
      catch { /* Source cleanup cannot turn a failed inference into success. */ }
    }
  }
}
