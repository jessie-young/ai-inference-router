import { describe, expect, it, afterEach } from 'vitest';
import { StubUpstream, completionResponse } from './helpers/stub-upstream.js';
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

const REQUEST = {
  model: 'router/gemma4',
  messages: [{ role: 'user', content: 'Say hello.' }],
};

describe('POST /v1/chat/completions — happy path', () => {
  it('forwards to the upstream and returns an OpenAI-shaped response', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hello!');
    expect(body.usage.total_tokens).toBe(21);
  });

  it('rewrites the model field to the upstream identifier when forwarding', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    const forwarded = stub.requests[0]?.body as Record<string, unknown>;
    expect(forwarded['model']).toBe('google/gemma-4-26b-a4b-it');
  });

  it('returns the requested alias in the response, not the upstream id', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.json().model).toBe('router/gemma4');
  });

  it('routes different aliases to their own upstream models', async () => {
    stub = await StubUpstream.start((req, respond) => {
      const model = (req.body as Record<string, unknown>)['model'] as string;
      respond.json(200, completionResponse(model));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...REQUEST, model: 'router/nemotron3' },
    });

    expect((stub.requests[0]?.body as Record<string, unknown>)['model']).toBe(
      'nvidia/nemotron-3-nano-30b-a3b',
    );
  });

  it('passes unknown parameters through untouched', async () => {
    // A router that strips parameters it does not recognize silently breaks
    // provider features. Everything except `model` must survive the hop.
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        ...REQUEST,
        temperature: 0.2,
        max_tokens: 256,
        top_p: 0.9,
        response_format: { type: 'json_object' },
        some_future_provider_param: { nested: true },
      },
    });

    const forwarded = stub.requests[0]?.body as Record<string, unknown>;
    expect(forwarded['temperature']).toBe(0.2);
    expect(forwarded['max_tokens']).toBe(256);
    expect(forwarded['response_format']).toEqual({ type: 'json_object' });
    expect(forwarded['some_future_provider_param']).toEqual({ nested: true });
  });

  it('authenticates to the upstream with the configured key', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(stub.requests[0]?.headers['authorization']).toBe('Bearer sk-upstream-secret');
  });

  it('never forwards the client credential to the upstream', async () => {
    // The client authenticates to the router; the router authenticates to the
    // provider. Leaking the client's token to a third party would be a bug.
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: REQUEST,
      headers: { authorization: 'Bearer sk-client-token' },
    });

    expect(stub.requests[0]?.headers['authorization']).toBe('Bearer sk-upstream-secret');
    expect(JSON.stringify(stub.requests[0]?.headers)).not.toContain('sk-client-token');
  });

  it('applies configured per-upstream headers', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({
      baseUrl: stub.baseUrl,
      headers: { 'X-Title': 'AI Inference Router' },
    });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(stub.requests[0]?.headers['x-title']).toBe('AI Inference Router');
  });

  it('posts to the upstream /chat/completions path', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(stub.requests[0]?.url).toBe('/v1/chat/completions');
    expect(stub.requests[0]?.method).toBe('POST');
  });

  it('tolerates a trailing slash on the configured base_url', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl + '/' });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(stub.requests[0]?.url).toBe('/v1/chat/completions');
  });
});

describe('POST /v1/chat/completions — error handling', () => {
  it('returns 404 with an OpenAI error body for an unconfigured model', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...REQUEST, model: 'gpt-4-turbo' },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.param).toBe('model');
    expect(body.error.message).toContain('router/gemma4');
    expect(stub.requests).toHaveLength(0);
  });

  it('passes an upstream error status and body through to the caller', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(400, {
        error: { message: 'context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' },
      });
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('context_length_exceeded');
  });

  it('returns 502 when the upstream is unreachable', async () => {
    // Start then immediately stop a stub, so its port is closed.
    const dead = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const baseUrl = dead.baseUrl;
    await dead.stop();

    const test = buildTestApp({ baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.type).toBe('upstream_error');
    expect(body.error.code).toBe('upstream_unreachable');
  });

  it('returns 504 when the upstream does not respond in time', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.hang());
    const test = buildTestApp({ baseUrl: stub.baseUrl, timeoutMs: 300 });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('upstream_timeout');
  });

  it('returns 502 when the upstream returns a non-JSON body', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.text(200, '<html>502 Bad Gateway</html>', 'text/html');
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('invalid_upstream_response');
  });

  it('rejects a request with no model field', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('rejects a request with an empty messages array', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'router/gemma4', messages: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('messages');
  });

  it('rejects malformed JSON with an OpenAI error body', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: '{"model": "router/gemma4",,}',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('returns an OpenAI-shaped 404 for unknown endpoints', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'GET', url: '/v1/embeddings' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('invalid_request_error');
  });
});

describe('retries', () => {
  it('retries a transient upstream failure and succeeds', async () => {
    let calls = 0;
    stub = await StubUpstream.start((_req, respond) => {
      calls++;
      if (calls === 1) {
        respond.json(503, { error: { message: 'service unavailable' } });
      } else {
        respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
      }
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl, maxRetries: 2 });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it('does not retry a client error', async () => {
    let calls = 0;
    stub = await StubUpstream.start((_req, respond) => {
      calls++;
      respond.json(400, { error: { message: 'bad request' } });
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl, maxRetries: 2 });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(400);
    expect(calls).toBe(1);
  });

  it('gives up after the configured number of retries', async () => {
    let calls = 0;
    stub = await StubUpstream.start((_req, respond) => {
      calls++;
      respond.json(503, { error: { message: 'service unavailable' } });
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl, maxRetries: 2 });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(calls).toBe(3); // initial attempt + 2 retries
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /v1/models and /health', () => {
  it('lists configured aliases in OpenAI format', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'GET', url: '/v1/models' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data.map((m: { id: string }) => m.id)).toEqual([
      'router/gemma4',
      'router/nemotron3',
    ]);
    expect(body.data[0].object).toBe('model');
  });

  it('reports health without requiring auth', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl, routerApiKey: 'secret' });
    app = test.app;

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('router authentication', () => {
  it('allows requests when no router key is configured', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a request with a missing or wrong key when one is configured', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl, routerApiKey: 'sk-router-secret' });
    app = test.app;

    const missing = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.type).toBe('authentication_error');

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: REQUEST,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(stub.requests).toHaveLength(0);
  });

  it('accepts the correct router key', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl, routerApiKey: 'sk-router-secret' });
    app = test.app;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: REQUEST,
      headers: { authorization: 'Bearer sk-router-secret' },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('observability', () => {
  it('logs one access line with routing, status, and latency', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    const access = test.logs.filter((l) => l['message'] === 'chat_completion');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: 'info',
      model: 'router/gemma4',
      upstream: 'stub',
      upstreamModel: 'google/gemma-4-26b-a4b-it',
      status: 200,
      attempts: 1,
      totalTokens: 21,
    });
    expect(typeof access[0]?.['latencyMs']).toBe('number');
    expect(access[0]?.['timestamp']).toBeTruthy();
  });

  it('logs failures at warn or error level with the routing context', async () => {
    stub = await StubUpstream.start((_req, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...REQUEST, model: 'nope' },
    });

    const access = test.logs.find((l) => l['message'] === 'chat_completion');
    expect(access?.['level']).toBe('warn');
    expect(access?.['status']).toBe(404);
    expect(access?.['errorCode']).toBe('model_not_found');
  });

  it('never writes an API key into the logs', async () => {
    stub = await StubUpstream.start((_req, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: REQUEST,
      headers: { authorization: 'Bearer sk-client-token' },
    });

    const dump = JSON.stringify(test.logs);
    expect(dump).not.toContain('sk-upstream-secret');
    expect(dump).not.toContain('sk-client-token');
  });
});
