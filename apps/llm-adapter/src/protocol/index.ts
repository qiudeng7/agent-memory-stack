/**
 * Pure offline SIWC protocol core; no credentials, network, SDK or Nest dependency.
 * Parent contract: verify modelSlug per account, convertChatRequest, POST payload to
 * https://api.openai.com/v1/responses, feed body into aggregateResponsesSse, return
 * final ChatCompletion only. Always abort transport on any ProtocolError.
 * No previous_response_id/storage shortcut: caller supplies complete Chat history.
 * Reasoning/custom/unknown output is deliberately fail-closed: preserving encrypted
 * reasoning across tool turns requires an additional authenticated session bridge.
 * Limits bound bytes/events/wall-clock, NOT provider output tokens or billing.
 */
export { ProtocolError } from './validation.js';
export { convertChatRequest, ToolRegistry } from './request.js';
export type { ConvertOptions, ConvertedRequest, FunctionTool, PublicResponsesPayload, ToolBinding } from './request.js';
export { ResponsesAggregator } from './response.js';
export type { AggregateOptions, ChatCompletion, ChatToolCall, ResponseLimits } from './response.js';
export { aggregateResponsesSse } from './sse.js';
export type { SseOptions } from './sse.js';
