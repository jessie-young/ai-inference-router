import type { Route } from '../router/resolve.js';
import { RouterError } from '../router/errors.js';
import { backoffDelayMs, isRetryableError, isRetryableStatus, sleep } from './retry.js';

/**
 * Headers we must never copy from the client's request to the upstream.
 *
 * `authorization` is the important one: the client authenticates to the
 * router, and the router authenticates to the provider with its own key.
 * Forwarding the client's token would leak it to a third party. The rest are
 * hop-by-hop or connection-specific and would corrupt the proxied request.
 */
const HOP_BY_HOP = new Set([
  'authorization',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);

export interface UpstreamResult {
  status: number;
  headers: Headers;
  /** Present for non-streaming responses. */
  body?: unknown;
  /** Present for streaming responses; the raw SSE byte stream. */
  stream?: ReadableStream<Uint8Array>;
  /** How many attempts were made, including the successful one. */
  attempts: number;
  /** Wall-clock time spent talking to the upstream, in milliseconds. */
  latencyMs: number;
}

export interface ForwardOptions {
  route: Route;
  /** The client's request body, already validated. */
  body: Record<string, unknown>;
  /** The client's headers, used to pass through safe ones. */
  headers?: Record<string, string | string[] | undefined>;
  /** Whether the caller asked for a streamed response. */
  stream: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for deterministic backoff under test. */
  random?: () => number;
}

/**
 * Build the request body sent upstream.
 *
 * The client's body is passed through nearly verbatim — only `model` is
 * rewritten from the router alias to the upstream's identifier. Passing
 * unknown fields through unchanged is deliberate: providers add parameters
 * faster than a proxy can enumerate them, and a router that strips anything it
 * does not recognize silently breaks features its users are paying for.
 */
export function buildUpstreamBody(
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const upstreamBody: Record<string, unknown> = { ...body, model: upstreamModel };

  // OpenAI's spec declares `stream` as nullable with a `false` default, so we
  // accept an explicit null from clients. Not every provider is that lenient —
  // OpenRouter rejects it with a 400 — so normalize it to the documented
  // default rather than passing a value through that we know breaks backends.
  if (upstreamBody['stream'] === null) {
    delete upstreamBody['stream'];
  }

  return upstreamBody;
}

/** Copy client headers that are safe and useful to forward. */
export function buildUpstreamHeaders(
  route: Route,
  clientHeaders: Record<string, string | string[] | undefined> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.upstream.apiKey}`,
  };

  for (const [key, value] of Object.entries(clientHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'content-type') continue;
    if (value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }

  // Configured per-upstream headers win over anything the client sent, so a
  // client cannot spoof attribution or override provider-required headers.
  for (const [key, value] of Object.entries(route.upstream.headers)) {
    headers[key.toLowerCase()] = value;
  }

  return headers;
}

/**
 * Forward a chat completion request to the resolved upstream.
 *
 * Retries transient failures up to the upstream's configured limit. Streaming
 * responses are returned as an unconsumed byte stream so the server can pipe
 * them to the client without buffering the whole completion in memory.
 */
export async function forward(options: ForwardOptions): Promise<UpstreamResult> {
  const { route, body, headers: clientHeaders, stream } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const { timeout_ms: timeoutMs, max_retries: maxRetries } = route.upstream;

  const url = `${route.upstream.base_url.replace(/\/+$/, '')}/chat/completions`;
  const upstreamBody = JSON.stringify(buildUpstreamBody(body, route.upstreamModel));
  const upstreamHeaders = buildUpstreamHeaders(route, clientHeaders);

  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelayMs(attempt - 1, { random: options.random }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: upstreamHeaders,
        body: upstreamBody,
        signal: controller.signal,
      });

      // Retry transient upstream failures, but only if attempts remain.
      // The response body must be drained so the socket can be reused.
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await response.text().catch(() => undefined);
        lastError = new Error(`upstream returned ${response.status}`);
        continue;
      }

      const latencyMs = Date.now() - started;
      const attempts = attempt + 1;

      // Stream only on success. An error response is JSON even when the
      // client asked for SSE, and the caller needs it parsed to build a
      // proper OpenAI error envelope.
      if (stream && response.ok && response.body) {
        return { status: response.status, headers: response.headers, stream: response.body, attempts, latencyMs };
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        // A non-JSON body from an OpenAI-compatible endpoint means something
        // upstream is broken (a proxy error page, a truncated response).
        // Surface it as a gateway error rather than passing garbage through.
        throw new RouterError(
          502,
          `Upstream "${route.upstream.name}" returned a non-JSON response (status ${response.status}).`,
          'upstream_error',
          'invalid_upstream_response',
        );
      }

      return { status: response.status, headers: response.headers, body: parsed, attempts, latencyMs };
    } catch (err) {
      if (err instanceof RouterError) throw err;

      // Our own timeout fired.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw RouterError.upstreamTimeout(route.upstream.name, timeoutMs);
      }

      lastError = err;
      if (!isRetryableError(err) || attempt >= maxRetries) {
        const reason = err instanceof Error ? err.message : String(err);
        throw RouterError.upstreamUnreachable(route.upstream.name, reason);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw RouterError.upstreamUnreachable(route.upstream.name, reason);
}
