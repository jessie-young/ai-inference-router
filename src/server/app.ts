import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ResolvedConfig } from '../config/schema.js';
import { RouterError } from '../router/errors.js';
import { listModels, resolveRoute } from '../router/resolve.js';
import { forward } from '../upstream/client.js';
import { parseChatCompletionRequest } from './validate.js';
import type { Logger } from '../observability/logger.js';

export interface AppOptions {
  config: ResolvedConfig;
  logger: Logger;
  /** If set, clients must present this as a bearer token. */
  routerApiKey?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Extract a bearer token from an Authorization header. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { config, logger, routerApiKey, fetchImpl } = options;

  const app = Fastify({
    logger: false, // We emit our own structured logs.
    // LLM payloads carry long conversations and base64 images. The OpenAI
    // default is generous; matching it avoids surprising 413s on real traffic.
    bodyLimit: 32 * 1024 * 1024,
    // Streaming completions can idle between tokens; do not sever them.
    keepAliveTimeout: 5 * 60 * 1000,
    requestIdHeader: 'x-request-id',
  });

  /**
   * Optional router-level authentication.
   *
   * Without this, anyone who can reach the port can spend your provider
   * credits. It is off by default so local development is frictionless, and
   * on whenever ROUTER_API_KEY is set.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!routerApiKey) return;
    if (request.url === '/health') return;

    const presented = bearerToken(request.headers.authorization);
    if (presented !== routerApiKey) {
      const err = RouterError.unauthorized(
        'Incorrect API key provided. Set the Authorization header to `Bearer <ROUTER_API_KEY>`.',
      );
      await reply.status(err.status).send(err.toBody());
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    models: config.models.size,
    upstreams: config.upstreams.size,
  }));

  /**
   * OpenAI-compatible model listing. Clients and UIs use this to populate
   * model pickers, so a drop-in proxy needs it even though it is not strictly
   * required for completions to work.
   */
  app.get('/v1/models', async () => ({
    object: 'list',
    data: listModels(config).map(({ alias, route }) => ({
      id: alias,
      object: 'model',
      created: 0,
      owned_by: route.upstream.name,
    })),
  }));

  app.post('/v1/chat/completions', async (request, reply) => {
    await handleChatCompletion(request, reply, { config, logger, fetchImpl });
  });

  // Unknown routes get an OpenAI-shaped 404 rather than Fastify's default,
  // so SDK error handling stays consistent across every failure.
  app.setNotFoundHandler(async (request, reply) => {
    const err = new RouterError(
      404,
      `Unknown endpoint: ${request.method} ${request.url}`,
      'invalid_request_error',
      'unknown_endpoint',
    );
    await reply.status(err.status).send(err.toBody());
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof RouterError) {
      await reply.status(error.status).send(error.toBody());
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;

    // Fastify raises this for malformed JSON before our validation runs.
    if (statusCode === 400) {
      const err = RouterError.badRequest(`Invalid JSON in request body: ${message}`);
      await reply.status(err.status).send(err.toBody());
      return;
    }

    logger.error('unhandled error', {
      requestId: request.id,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    const err = new RouterError(
      500,
      'The router encountered an internal error while processing your request.',
      'internal_error',
    );
    await reply.status(err.status).send(err.toBody());
  });

  return app;
}

interface HandlerDeps {
  config: ResolvedConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

async function handleChatCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HandlerDeps,
): Promise<void> {
  const { config, logger, fetchImpl } = deps;
  const startedAt = Date.now();

  // Fields captured for the access log regardless of which path we exit by.
  let alias: string | undefined;
  let upstreamName: string | undefined;
  let upstreamModel: string | undefined;
  let attempts = 0;
  let upstreamLatencyMs: number | undefined;

  /** Emit exactly one structured access-log line per request. */
  const logAccess = (status: number, extra: Record<string, unknown> = {}): void => {
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('chat_completion', {
      requestId: request.id,
      method: request.method,
      path: request.url,
      model: alias ?? null,
      upstream: upstreamName ?? null,
      upstreamModel: upstreamModel ?? null,
      status,
      attempts,
      latencyMs: Date.now() - startedAt,
      upstreamLatencyMs: upstreamLatencyMs ?? null,
      ...extra,
    });
  };

  try {
    const body = parseChatCompletionRequest(request.body);
    alias = body.model;

    const route = resolveRoute(config, body.model);
    upstreamName = route.upstream.name;
    upstreamModel = route.upstreamModel;

    const wantsStream = body.stream === true;

    const result = await forward({
      route,
      body: body as Record<string, unknown>,
      headers: request.headers,
      stream: wantsStream,
      fetchImpl,
    });

    attempts = result.attempts;
    upstreamLatencyMs = result.latencyMs;

    if (result.stream) {
      // Pipe the SSE stream straight through. Chunks are not parsed or
      // rewritten: doing so would mean deserializing and re-serializing every
      // frame in the hot path, for the cosmetic benefit of a renamed model
      // field. Latency and robustness matter more than that here.
      reply.raw.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let bytes = 0;
      try {
        for await (const chunk of streamToAsyncIterable(result.stream)) {
          bytes += chunk.byteLength;
          const ok = reply.raw.write(chunk);
          // Respect backpressure: a slow client must not let chunks pile up
          // in memory unboundedly.
          if (!ok) {
            await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
          }
        }
        reply.raw.end();
        logAccess(result.status, { stream: true, bytes });
      } catch (err) {
        // The stream broke mid-flight. Headers are already sent, so an error
        // body is impossible; end the response and record it.
        reply.raw.end();
        logAccess(result.status, {
          stream: true,
          bytes,
          error: err instanceof Error ? err.message : String(err),
          truncated: true,
        });
      }
      return;
    }

    const responseBody = rewriteModelInResponse(result.body, alias);
    const usage = extractUsage(responseBody);

    await reply.status(result.status).send(responseBody);
    logAccess(result.status, { stream: false, ...usage });
  } catch (err) {
    const routerError =
      err instanceof RouterError
        ? err
        : new RouterError(
            500,
            'The router encountered an internal error while processing your request.',
            'internal_error',
          );

    if (!(err instanceof RouterError)) {
      logger.error('unexpected handler error', {
        requestId: request.id,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    await reply.status(routerError.status).send(routerError.toBody());
    logAccess(routerError.status, { errorCode: routerError.code, errorType: routerError.type });
  }
}

/**
 * Replace the upstream's model id with the alias the client asked for.
 *
 * Clients should see the stable, router-owned name they requested; leaking the
 * upstream id would couple them to the backend the router happens to pick and
 * defeat the point of an alias.
 */
export function rewriteModelInResponse(body: unknown, alias: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (typeof record['model'] !== 'string') return body;
  return { ...record, model: alias };
}

/** Pull token usage out of a completion response for the access log. */
function extractUsage(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') return {};
  const usage = (body as Record<string, unknown>)['usage'];
  if (usage === null || typeof usage !== 'object') return {};
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: u['prompt_tokens'] ?? null,
    completionTokens: u['completion_tokens'] ?? null,
    totalTokens: u['total_tokens'] ?? null,
  };
}

/** Bridge a web ReadableStream to an async iterable across Node versions. */
async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
