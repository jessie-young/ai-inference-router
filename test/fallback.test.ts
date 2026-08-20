import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { createLogger } from '../src/observability/logger.js';
import { shouldFailover, isModelRejection } from '../src/upstream/fallback.js';
import type { ResolvedConfig } from '../src/config/schema.js';

/**
 * Fallback chains.
 *
 * These use two separate stub servers so a hop is unambiguous: if the second
 * server received the request, the chain genuinely advanced. Distinguishing
 * hops by URL path on one server would leave room for a routing bug to look
 * like a fallback.
 */

interface Stub {
  server: Server;
  url: string;
  requests: Array<Record<string, unknown>>;
  setResponse(fn: StubResponder): void;
}

type StubResponder = (
  body: Record<string, unknown>,
  res: import('node:http').ServerResponse,
) => void;

async function startStub(initial: StubResponder): Promise<Stub> {
  let responder = initial;
  const requests: Array<Record<string, unknown>> = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        /* leave empty */
      }
      requests.push(body);
      responder(body, res);
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setResponse(fn) {
      responder = fn;
    },
  };
}

const jsonResponse =
  (status: number, payload: unknown): StubResponder =>
  (_body, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

const completion = (model: string, content = 'Hello!') => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1700000000,
  model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

let primary: Stub | undefined;
let secondary: Stub | undefined;
let app: FastifyInstance | undefined;

/** Close a stub, tolerating one that a test already closed. */
async function closeStub(stub: Stub | undefined): Promise<void> {
  if (!stub) return;
  if (!stub.server.listening) return;
  stub.server.closeAllConnections?.();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
}

afterEach(async () => {
  await app?.close();
  await closeStub(primary);
  await closeStub(secondary);
  app = undefined;
  primary = undefined;
  secondary = undefined;
});

interface ChainAppOptions {
  primaryUrl: string;
  secondaryUrl: string;
  primaryModel?: string;
  secondaryModel?: string;
  maxRetries?: number;
}

function buildChainApp(options: ChainAppOptions) {
  const mk = (name: string, url: string) => ({
    name,
    base_url: url,
    api_key_env: 'K',
    apiKey: `sk-${name}`,
    timeout_ms: 3_000,
    max_retries: options.maxRetries ?? 0,
    headers: {},
  });

  const config: ResolvedConfig = {
    upstreams: new Map([
      ['primary', mk('primary', options.primaryUrl)],
      ['secondary', mk('secondary', options.secondaryUrl)],
    ]),
    models: new Map([
      [
        'router/chained',
        {
          targets: [
            { upstream: 'primary', model: options.primaryModel ?? 'vendor/model:free' },
            { upstream: 'secondary', model: options.secondaryModel ?? 'vendor/model' },
          ],
        },
      ],
      ['router/single', { targets: [{ upstream: 'primary', model: 'vendor/only' }] }],
    ]),
  };

  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    write: (l) => logs.push(JSON.parse(l) as Record<string, unknown>),
  });

  return { app: buildApp({ config, logger }), logs };
}

const REQUEST = { model: 'router/chained', messages: [{ role: 'user', content: 'hi' }] };

describe('shouldFailover', () => {
  it('fails over for target-specific failures', () => {
    // Quota, auth, capacity, availability: the next provider may well work.
    for (const status of [401, 402, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect(shouldFailover(status)).toBe(true);
    }
  });

  it('does not fail over for a genuinely malformed request', () => {
    // A 400 means the request itself is wrong. The next provider will reject
    // it identically, so failing over only multiplies cost and latency.
    expect(shouldFailover(400)).toBe(false);
    expect(shouldFailover(400, { error: { message: 'messages must be non-empty' } })).toBe(false);
    expect(shouldFailover(422)).toBe(false);
  });

  it('does fail over on a 400 that rejects the model id', () => {
    expect(
      shouldFailover(400, { error: { message: 'vendor/x:free is not a valid model ID' } }),
    ).toBe(true);
  });

  it('does not fail over on success', () => {
    expect(shouldFailover(200)).toBe(false);
  });
});

describe('isModelRejection', () => {
  it('recognises a provider rejecting the model id', () => {
    // OpenRouter's actual wording for an id it does not have.
    expect(
      isModelRejection({ error: { message: 'google/gemma-4-xyz is not a valid model ID' } }),
    ).toBe(true);
    expect(isModelRejection({ error: { message: 'Unknown model: foo/bar' } })).toBe(true);
    expect(isModelRejection({ error: { message: 'The model `x` does not exist' } })).toBe(true);
  });

  it('does not match ordinary 400s that merely mention a model', () => {
    expect(
      isModelRejection({ error: { message: 'This model requires a system prompt' } }),
    ).toBe(false);
    expect(
      isModelRejection({ error: { message: 'context length exceeded for this model' } }),
    ).toBe(false);
    expect(isModelRejection({ error: { message: 'messages must be non-empty' } })).toBe(false);
    expect(isModelRejection(null)).toBe(false);
    expect(isModelRejection({})).toBe(false);
  });
});

describe('fallback chains', () => {
  it('uses the primary when it succeeds, never touching the fallback', async () => {
    primary = await startStub(jsonResponse(200, completion('vendor/model:free')));
    secondary = await startStub(jsonResponse(200, completion('vendor/model')));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(0);
  });

  it('falls back to the next target when the primary is out of credit (402)', async () => {
    // The motivating case: a :free tier exhausts its quota and the paid model
    // should transparently take over.
    primary = await startStub(
      jsonResponse(402, { error: { message: 'Insufficient credits', type: 'billing_error' } }),
    );
    secondary = await startStub(jsonResponse(200, completion('vendor/model', 'from fallback')));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('from fallback');
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(1);
  });

  it('sends each target its own model identifier', async () => {
    primary = await startStub(jsonResponse(429, { error: { message: 'rate limited' } }));
    secondary = await startStub(jsonResponse(200, completion('vendor/model')));
    const test = buildChainApp({
      primaryUrl: primary.url,
      secondaryUrl: secondary.url,
      primaryModel: 'google/gemma-4-26b-a4b-it:free',
      secondaryModel: 'google/gemma-4-26b-a4b-it',
    });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(primary.requests[0]?.['model']).toBe('google/gemma-4-26b-a4b-it:free');
    expect(secondary.requests[0]?.['model']).toBe('google/gemma-4-26b-a4b-it');
  });

  it('falls back when the primary is unreachable', async () => {
    const dead = await startStub(jsonResponse(200, {}));
    const deadUrl = dead.url;
    await new Promise<void>((r) => dead.server.close(() => r()));

    secondary = await startStub(jsonResponse(200, completion('vendor/model', 'recovered')));
    const test = buildChainApp({ primaryUrl: deadUrl, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('recovered');
  });

  it('falls back when the primary times out', async () => {
    primary = await startStub((_b, res) => {
      // Never respond, but keep a handle so teardown can destroy the socket.
      res.socket?.unref();
    });
    secondary = await startStub(jsonResponse(200, completion('vendor/model', 'after timeout')));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('after timeout');
  }, 10_000);

  it('does NOT fall back on a 400 — the next provider would reject it too', async () => {
    primary = await startStub(
      jsonResponse(400, {
        error: { message: 'context length exceeded', code: 'context_length_exceeded' },
      }),
    );
    secondary = await startStub(jsonResponse(200, completion('vendor/model')));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('context_length_exceeded');
    expect(secondary.requests).toHaveLength(0);
  });

  it('falls back when a provider rejects the model id with a 400', async () => {
    // Each hop sends a different model id, so "not a valid model ID" is
    // target-specific even though the provider reports it as a 400.
    // OpenRouter really does answer this way, so a blanket 400-is-fatal rule
    // would silently defeat the chain.
    primary = await startStub(
      jsonResponse(400, { error: { message: 'vendor/model:free is not a valid model ID' } }),
    );
    secondary = await startStub(jsonResponse(200, completion('vendor/model', 'fell back')));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('fell back');
    expect(secondary.requests).toHaveLength(1);
  });

  it('surfaces the last failure when every target fails', async () => {
    primary = await startStub(jsonResponse(429, { error: { message: 'primary rate limited' } }));
    secondary = await startStub(
      jsonResponse(503, { error: { message: 'secondary unavailable' } }),
    );
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain('secondary unavailable');
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(1);
  });

  it('exhausts a target’s retries before advancing the chain', async () => {
    // Retry and fallback are separate layers: a blip is retried in place,
    // and only a target that stays broken causes the chain to advance.
    let primaryCalls = 0;
    primary = await startStub((_b, res) => {
      primaryCalls++;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unavailable' } }));
    });
    secondary = await startStub(jsonResponse(200, completion('vendor/model')));
    const test = buildChainApp({
      primaryUrl: primary.url,
      secondaryUrl: secondary.url,
      maxRetries: 2,
    });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(primaryCalls).toBe(3); // initial + 2 retries
    expect(secondary.requests).toHaveLength(1);
  });

  it('logs the failover with both endpoints named', async () => {
    primary = await startStub(jsonResponse(402, { error: { message: 'no credit' } }));
    secondary = await startStub(jsonResponse(200, completion('vendor/model')));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    const failover = test.logs.find((l) => l['message'] === 'upstream_failover');
    expect(failover).toBeDefined();
    expect(failover?.['level']).toBe('warn');
    expect(failover?.['from']).toMatchObject({ upstream: 'primary' });
    expect(failover?.['to']).toMatchObject({ upstream: 'secondary' });
    expect(failover?.['status']).toBe(402);

    // The access line records that a failover happened and which hop served it.
    const access = test.logs.find((l) => l['message'] === 'chat_completion');
    expect(access?.['failedOver']).toBe(true);
    expect(access?.['upstream']).toBe('secondary');
    expect(Array.isArray(access?.['chainAttempts'])).toBe(true);
  });

  it('does not add failover fields to ordinary single-target requests', async () => {
    primary = await startStub(jsonResponse(200, completion('vendor/only')));
    secondary = await startStub(jsonResponse(200, {}));
    const test = buildChainApp({ primaryUrl: primary.url, secondaryUrl: secondary.url });
    app = test.app;

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'router/single', messages: [{ role: 'user', content: 'hi' }] },
    });

    const access = test.logs.find((l) => l['message'] === 'chat_completion');
    expect(access?.['failedOver']).toBeUndefined();
    expect(access?.['chainAttempts']).toBeUndefined();
  });
});
