import { describe, expect, it, afterEach } from 'vitest';
import { StubUpstream } from './helpers/stub-upstream.js';
import { buildTestApp } from './helpers/app.js';
import type { FastifyInstance } from 'fastify';

let stub: StubUpstream | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await stub?.stop();
  app = undefined;
  stub = undefined;
});

/** SSE frames shaped like a real OpenAI streaming completion. */
const SSE_CHUNKS = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"google/gemma-4-26b-a4b-it","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"google/gemma-4-26b-a4b-it","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"google/gemma-4-26b-a4b-it","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"google/gemma-4-26b-a4b-it","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

const STREAM_REQUEST = {
  model: 'router/gemma4',
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
};

describe('streaming', () => {
  it('proxies the SSE stream through to the client', async () => {
    stub = await StubUpstream.start(async (_req, respond) => {
      await respond.sse(SSE_CHUNKS);
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(STREAM_REQUEST),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('"delta":{"content":"Hello"}');
    expect(text).toContain('"delta":{"content":" there"}');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('forwards stream: true to the upstream', async () => {
    stub = await StubUpstream.start(async (_req, respond) => {
      await respond.sse(SSE_CHUNKS);
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address() as { port: number };
    await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(STREAM_REQUEST),
    }).then((r) => r.text());

    const forwarded = stub.requests[0]?.body as Record<string, unknown>;
    expect(forwarded['stream']).toBe(true);
    expect(forwarded['model']).toBe('google/gemma-4-26b-a4b-it');
  });

  it('delivers chunks incrementally rather than buffering the whole response', async () => {
    // The point of streaming is first-token latency. If the router buffered,
    // the first chunk would not arrive until the upstream finished.
    stub = await StubUpstream.start(async (_req, respond) => {
      await respond.sse(SSE_CHUNKS, 40);
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address() as { port: number };
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(STREAM_REQUEST),
    });

    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstChunkMs = Date.now() - started;

    expect(first.done).toBe(false);
    // Total stream takes ~200ms; the first chunk must arrive well before that.
    expect(firstChunkMs).toBeLessThan(150);

    await reader.cancel();
  });

  it('returns a JSON error body when a streaming request fails upstream', async () => {
    // Even with stream: true, an upstream error arrives as JSON. The client
    // needs a parseable error, not an empty event stream.
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(429, {
        error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      });
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: STREAM_REQUEST,
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limit_exceeded');
  });

  it('returns a JSON 404 for an unknown model even when streaming is requested', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...STREAM_REQUEST, model: 'router/nope' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('model_not_found');
  });

  it('logs a streaming request with byte count', async () => {
    stub = await StubUpstream.start(async (_req, respond) => {
      await respond.sse(SSE_CHUNKS);
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address() as { port: number };
    await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(STREAM_REQUEST),
    }).then((r) => r.text());

    const access = test.logs.find((l) => l['message'] === 'chat_completion');
    expect(access).toMatchObject({ status: 200, stream: true, model: 'router/gemma4' });
    expect(access?.['bytes']).toBeGreaterThan(0);
  });
});
