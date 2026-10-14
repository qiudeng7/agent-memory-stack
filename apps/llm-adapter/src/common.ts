import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

export class GatewayError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function requireBearer(header: unknown, secret: string | undefined): void {
  if (!secret) throw new GatewayError('service_not_configured', 503, 'Service credential is not configured');
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new GatewayError('unauthorized', 401, 'A valid service credential is required');
  }
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new GatewayError('unauthorized', 401, 'A valid service credential is required');
  }
}

export function configuredSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  const direct = env[name];
  if (file && direct) throw new GatewayError('configuration_error', 500, 'Specify a secret file or environment value, not both');
  if (!file && !direct) return undefined;
  let value = direct;
  if (file) {
    const pathStat = lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) throw new GatewayError('configuration_error', 500, 'Secret file path must be an ordinary dedicated file');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 8192 || (process.getuid && stat.uid !== process.getuid())) {
        throw new GatewayError('configuration_error', 500, 'Secret files must be owned by the service UID with mode 0600');
      }
      value = readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
  }
  if (!value || value.length < 32 || value.startsWith('REPLACE_')) {
    throw new GatewayError('configuration_error', 500, 'Service credentials must be independent strong values');
  }
  return value;
}

export function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new GatewayError('configuration_error', 500, 'Expected a positive integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) {
    throw new GatewayError('configuration_error', 500, 'Configuration value is outside its supported range');
  }
  return n;
}

/** Strict single-flight queue: rejected overload never contacts upstream. */
export class SerialQueue {
  private running = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; remove?: () => void }> = [];
  constructor(private readonly maxPending = 16) {}

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new GatewayError('request_cancelled', 499, 'Request was cancelled');
    if (this.running) {
      if (this.waiters.length >= this.maxPending) throw new GatewayError('queue_full', 429, 'Service queue is full');
      await new Promise<void>((resolve, reject) => {
        const waiter: (typeof this.waiters)[number] = { resolve, reject };
        if (signal) {
          waiter.signal = signal;
          const onAbort = () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(new GatewayError('request_cancelled', 499, 'Request was cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          waiter.remove = () => signal.removeEventListener('abort', onAbort);
        }
        this.waiters.push(waiter);
      });
    } else this.running = true;
    try {
      if (signal?.aborted) throw new GatewayError('request_cancelled', 499, 'Request was cancelled');
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next.remove?.();
        next.resolve();
      } else this.running = false;
    }
  }
}

/** A deadline must bound awaiting response headers as well as consuming the SSE body. */
export function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      reject(new GatewayError(timedOut ? 'request_timeout' : 'request_cancelled', timedOut ? 504 : 499, 'Request expired or was cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then((value) => {
      if (settled) { if (disposeLate) void disposeLate(value).catch(() => undefined); return; }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export function requestDeadline(milliseconds: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface GatewayRequest { headers: IncomingMessage['headers']; raw: IncomingMessage }
export interface GatewayReply { raw: ServerResponse; status(code: number): GatewayReply; send(body: unknown): unknown }

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<GatewayReply>();
    if (error instanceof GatewayError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, type: 'gateway_error' } });
      return;
    }
    const status = error instanceof HttpException ? error.getStatus() : 500;
    reply.status(status).send({ error: { code: status === 400 ? 'invalid_request' : 'internal_error', message: status === 400 ? 'Invalid request' : 'Request could not be completed', type: 'gateway_error' } });
  }
}

/** Abort upstream if the caller drops the connection; listeners have request lifetime only. */
export async function withDisconnectSignal<T>(request: GatewayRequest, reply: GatewayReply, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
  request.raw.once('aborted', onAbort);
  reply.raw.once('close', onClose);
  try { return await work(controller.signal); }
  finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose); }
}
