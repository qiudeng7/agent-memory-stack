import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { aggregateResponsesSse, convertChatRequest, ProtocolError, type ChatCompletion, type PublicResponsesPayload } from './protocol/index.js';
import { awaitWithAbort, GatewayError, SerialQueue, configuredSecret, requestDeadline, requireBearer } from './common.js';
import { SafeExceptionFilter, withDisconnectSignal, type GatewayReply, type GatewayRequest } from './common.js';

export type AdapterResponsesPayload = PublicResponsesPayload & { reasoning?: { effort: 'none' } };
export interface ResponsesTransport {
  execute(payload: AdapterResponsesPayload, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

/** Explicit OV v0.5 compatibility, not a permissive API parameter pass-through. */
function normalizeOpenVikingDefaults(body: unknown): { body: unknown; ignored: string[]; reasoningNone: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, ignored: [], reasoningNone: false };
  const copy = { ...body as Record<string, unknown> };
  const ignored: string[] = [];
  if (copy.temperature !== undefined) {
    if (copy.temperature !== 0) throw new GatewayError('unsupported_temperature', 400, 'SIWC does not support a temperature override');
    delete copy.temperature;
    ignored.push('temperature');
  }
  let reasoningNone = false;
  if (copy.reasoning_effort !== undefined) {
    if (copy.reasoning_effort !== 'none') throw new GatewayError('unsupported_reasoning', 400, 'Reasoning history is not supported in this bootstrap revision');
    delete copy.reasoning_effort;
    reasoningNone = true;
  }
  return { body: copy, ignored, reasoningNone };
}
export interface VerifiedModelRoute { alias: string; modelSlug: string; accountModelVerified: true }
export interface LlmAppOptions {
  apiKey?: string;
  adminKey?: string;
  /** Dependency injection for offline fixtures only in P0. No live token binding exists yet. */
  transport?: ResponsesTransport;
  routes?: VerifiedModelRoute[];
  timeoutMs?: number;
}
const OPTIONS = Symbol('llm-options');
const SERVICE = Symbol('llm-service');

/** Register a parser-safe handler through Nest's adapter hook exactly once. */
class SafeFastifyAdapter extends FastifyAdapter {
  override setErrorHandler(_handler: Parameters<FastifyAdapter['setErrorHandler']>[0]) {
    return super.setErrorHandler((error, _request, reply) => {
      const candidate = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
      const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate < 600 ? candidate : 500;
      reply.status(status).send({ error: { code: status === 413 ? 'request_too_large' : 'invalid_request', message: 'Request could not be processed', type: 'gateway_error' } });
    });
  }
}

export class LlmGatewayService {
  private readonly queue = new SerialQueue(16);
  private transportPaused = false;
  private readonly counters = { requests: 0, completed: 0, failed: 0 };
  constructor(private readonly options: LlmAppOptions) {}
  ready() { return Boolean(this.options.apiKey && this.options.transport && this.options.routes?.length && !this.transportPaused); }
  status() { return { service: 'llm-gateway', provider: this.options.transport ? 'injected-transport' : 'disabled', ready: this.ready(), oauth: 'core-only-not-network-bound', transportPaused: this.transportPaused, ...this.counters }; }
  models() { return { object: 'list', data: (this.options.routes ?? []).map((route) => ({ id: route.alias, object: 'model', created: 0, owned_by: 'agent-memory-stack' })) }; }

  async complete(body: unknown, outerSignal?: AbortSignal): Promise<{ completion: ChatCompletion; ignoredParameters: string[] }> {
    this.counters.requests++;
    if (!this.options.transport) throw new GatewayError('provider_not_connected', 503, 'No authorized LLM provider is connected');
    if (this.transportPaused) throw new GatewayError('transport_cleanup_uncertain', 503, 'Transport is paused until its cleanup is verified');
    const model = body && typeof body === 'object' ? (body as Record<string, unknown>).model : undefined;
    const route = (this.options.routes ?? []).find((candidate) => candidate.alias === model && candidate.accountModelVerified);
    if (!route) throw new GatewayError('unknown_model', 404, 'No verified model route matches the request');
    const normalized = normalizeOpenVikingDefaults(body);
    let converted: ReturnType<typeof convertChatRequest>;
    try { converted = convertChatRequest(normalized.body, { modelSlug: route.modelSlug }); }
    catch (error) {
      if (error instanceof ProtocolError) throw new GatewayError(error.code, error.status, 'Request violates the supported LLM protocol');
      throw error;
    }
    const own = new AbortController();
    const signal = requestDeadline(this.options.timeoutMs ?? 120_000, outerSignal ? AbortSignal.any([own.signal, outerSignal]) : own.signal);
    let acquisitionStarted = false;
    let streamReceived = false;
    try {
      return await this.queue.run(async () => {
        if (this.transportPaused) throw new GatewayError('transport_cleanup_uncertain', 503, 'Transport is paused until its cleanup is verified');
        const payload: AdapterResponsesPayload = { ...converted.payload };
        if (normalized.reasoningNone) payload.reasoning = { effort: 'none' };
        acquisitionStarted = true;
        const stream = await awaitWithAbort(this.options.transport!.execute(payload, signal), signal, async (lateStream) => {
          // Best-effort cleanup; no automatic unpause while underlying cleanup is uncertain.
          const iterator = lateStream[Symbol.asyncIterator]();
          await iterator.return?.();
        }).catch((error: unknown) => {
          // Set the circuit while still holding the serial slot, before waking queued work.
          if (signal.aborted) this.transportPaused = true;
          throw error;
        });
        streamReceived = true;
        const completion = await aggregateResponsesSse(stream, converted.toolRegistry, { signal, maxDurationMs: this.options.timeoutMs ?? 120_000 });
        if (completion.model !== route.modelSlug) throw new GatewayError('upstream_model_mismatch', 502, 'Upstream returned an unverified model');
        this.counters.completed++;
        return { completion, ignoredParameters: [...converted.ignoredParameters, ...normalized.ignored] };
      }, signal);
    } catch (error) {
      if (signal.aborted && acquisitionStarted && !streamReceived) this.transportPaused = true;
      this.counters.failed++;
      if (error instanceof GatewayError) throw error;
      if (error instanceof ProtocolError) throw new GatewayError(error.code, error.status, 'LLM response did not complete safely');
      if (signal.aborted) throw new GatewayError('request_timeout', 504, 'LLM request expired or was cancelled');
      throw new GatewayError('upstream_unavailable', 503, 'LLM upstream is unavailable');
    } finally { own.abort(); }
  }
}

@Controller()
class LlmController {
  constructor(@Inject(OPTIONS) private readonly options: LlmAppOptions, @Inject(SERVICE) private readonly service: LlmGatewayService) {}
  @Get('health') health() { return { service: 'llm-gateway', status: 'ok' }; }
  @Get('ready') ready() {
    if (!this.service.ready()) throw new GatewayError('provider_not_connected', 503, 'No authorized LLM provider is connected');
    return { service: 'llm-gateway', status: 'ready' };
  }
  @Get('v1/models') models(@Req() request: GatewayRequest) {
    requireBearer(request.headers.authorization, this.options.apiKey);
    return this.service.models();
  }
  @Post('v1/chat/completions') @HttpCode(200) async complete(@Body() body: unknown, @Req() request: GatewayRequest, @Res({ passthrough: true }) reply: GatewayReply) {
    requireBearer(request.headers.authorization, this.options.apiKey);
    const result = await withDisconnectSignal(request, reply, (signal) => this.service.complete(body, signal));
    if (result.ignoredParameters.length) reply.raw.setHeader('X-AMS-Ignored-Parameters', result.ignoredParameters.join(','));
    reply.raw.setHeader('X-AMS-Completion-Policy', 'completed-only');
    return result.completion;
  }
  @Get('admin/status') status(@Req() request: GatewayRequest) {
    requireBearer(request.headers.authorization, this.options.adminKey);
    return this.service.status();
  }
  @Post('admin/oauth/start') start(@Req() request: GatewayRequest): never {
    requireBearer(request.headers.authorization, this.options.adminKey);
    throw new GatewayError('oauth_transport_not_implemented', 501, 'OAuth core exists, but live authorization is not connected in this revision');
  }
  @Get('auth/callback') callback(): never {
    throw new GatewayError('oauth_transport_not_implemented', 501, 'No live OAuth transaction can be completed in this revision');
  }
}

export async function createLlmApp(options: LlmAppOptions = {}): Promise<NestFastifyApplication> {
  if (options.apiKey && options.adminKey && options.apiKey === options.adminKey) throw new GatewayError('configuration_error', 500, 'Data and admin credentials must differ');
  @Module({ controllers: [LlmController], providers: [{ provide: OPTIONS, useValue: options }, { provide: SERVICE, useValue: new LlmGatewayService(options) }] })
  class AppModule {}
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new SafeFastifyAdapter({ bodyLimit: 1024 * 1024, logger: false }), { logger: false });
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export function llmOptionsFromEnv(env: NodeJS.ProcessEnv): LlmAppOptions {
  if (env.LLM_PROVIDER && env.LLM_PROVIDER !== 'disabled') throw new GatewayError('provider_not_implemented', 500, 'Live provider binding is not implemented in this bootstrap revision');
  if ('AMS_MASTER_KEY' in env) {
    const master = env.AMS_MASTER_KEY;
    if (typeof master !== 'string' || master.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(master)) {
      throw new GatewayError('configuration_error', 500, 'Invalid AMS_MASTER_KEY: expected 64 hexadecimal characters');
    }
    if (['LLM_API_KEY', 'LLM_ADMIN_API_KEY'].some((name) => name in env || `${name}_FILE` in env)) {
      throw new GatewayError('configuration_error', 500, 'AMS_MASTER_KEY cannot be combined with explicit service credentials or files');
    }
    // The master is literal UTF-8, not decoded hex or case-normalized.
    const derive = (role: string) => createHmac('sha256', Buffer.from(master, 'utf8')).update(`agent-memory-stack/v1/${role}`, 'utf8').digest('hex');
    return { apiKey: derive('llm-data'), adminKey: derive('llm-admin') };
  }
  const options: LlmAppOptions = {};
  const apiKey = configuredSecret(env, 'LLM_API_KEY');
  const adminKey = configuredSecret(env, 'LLM_ADMIN_API_KEY');
  if (apiKey) options.apiKey = apiKey;
  if (adminKey) options.adminKey = adminKey;
  return options;
}
