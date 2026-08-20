import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StubUpstream, completionResponse } from './helpers/stub-upstream.js';
import { buildTestApp } from './helpers/app.js';
import { UsageTracker, extractUsage } from '../src/observability/usage.js';

describe('extractUsage', () => {
  it('reads the standard OpenAI usage block', () => {
    expect(
      extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('derives the total when a provider omits it', () => {
    expect(extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });

  it('returns undefined when nothing usable is reported', () => {
    // "Not reported" must stay distinguishable from "zero tokens", so callers
    // do not record a request whose real cost is unknown.
    expect(extractUsage({})).toBeUndefined();
    expect(extractUsage({ usage: null })).toBeUndefined();
    expect(extractUsage({ usage: {} })).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
    expect(extractUsage('nonsense')).toBeUndefined();
  });

  it('ignores non-numeric token fields', () => {
    expect(extractUsage({ usage: { prompt_tokens: 'lots' } })).toBeUndefined();
  });
});

describe('UsageTracker', () => {
  it('starts empty', () => {
    const snap = new UsageTracker().snapshot();
    expect(snap.totals).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(snap.byModel).toEqual({});
  });

  it('accumulates across requests for one alias', () => {
    const t = new UsageTracker();
    t.record('router/gemma4', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    t.record('router/gemma4', { promptTokens: 20, completionTokens: 10, totalTokens: 30 });

    expect(t.snapshot().byModel['router/gemma4']).toEqual({
      requests: 2,
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
    });
  });

  it('keeps per-model counts separate and totals them', () => {
    const t = new UsageTracker();
    t.record('router/gemma4', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    t.record('router/nemotron3', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });

    const snap = t.snapshot();
    expect(snap.byModel['router/gemma4']?.totalTokens).toBe(15);
    expect(snap.byModel['router/nemotron3']?.totalTokens).toBe(150);
    expect(snap.totals).toEqual({
      requests: 2,
      promptTokens: 110,
      completionTokens: 55,
      totalTokens: 165,
    });
  });

  it('orders models by spend so the expensive ones surface first', () => {
    const t = new UsageTracker();
    t.record('cheap', { promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    t.record('expensive', { promptTokens: 500, completionTokens: 500, totalTokens: 1000 });
    t.record('middling', { promptTokens: 50, completionTokens: 50, totalTokens: 100 });

    expect(Object.keys(t.snapshot().byModel)).toEqual(['expensive', 'middling', 'cheap']);
  });

  it('returns a copy that cannot mutate internal state', () => {
    const t = new UsageTracker();
    t.record('m', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const snap = t.snapshot();
    snap.totals.totalTokens = 99999;
    snap.byModel['m']!.totalTokens = 99999;

    expect(t.snapshot().totals.totalTokens).toBe(15);
    expect(t.snapshot().byModel['m']?.totalTokens).toBe(15);
  });

  it('stamps the window it has been counting since', () => {
    const t = new UsageTracker(() => new Date('2026-08-20T12:00:00.000Z'));
    expect(t.snapshot().since).toBe('2026-08-20T12:00:00.000Z');
  });
});

describe('GET /v1/usage', () => {
  let stub: StubUpstream | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await stub?.stop();
    app = undefined;
    stub = undefined;
  });

  const REQUEST = { model: 'router/gemma4', messages: [{ role: 'user', content: 'hi' }] };

  it('reports zeroes before any traffic', async () => {
    stub = await StubUpstream.start((_r, respond) => respond.json(200, {}));
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    const res = await app.inject({ method: 'GET', url: '/v1/usage' });

    expect(res.statusCode).toBe(200);
    expect(res.json().totals.totalTokens).toBe(0);
    expect(res.json().since).toBeTruthy();
  });

  it('accumulates usage from real completions, keyed by alias', async () => {
    stub = await StubUpstream.start((_r, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });
    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...REQUEST, model: 'router/nemotron3' },
    });

    const snap = (await app.inject({ method: 'GET', url: '/v1/usage' })).json();

    // completionResponse reports 9 / 12 / 21 per call.
    expect(snap.byModel['router/gemma4']).toEqual({
      requests: 2,
      promptTokens: 18,
      completionTokens: 24,
      totalTokens: 42,
    });
    expect(snap.byModel['router/nemotron3'].requests).toBe(1);
    expect(snap.totals.totalTokens).toBe(63);
  });

  it('counts against the requested alias, not the upstream model id', async () => {
    stub = await StubUpstream.start((_r, respond) => {
      respond.json(200, completionResponse('google/gemma-4-26b-a4b-it'));
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });
    const snap = (await app.inject({ method: 'GET', url: '/v1/usage' })).json();

    expect(Object.keys(snap.byModel)).toEqual(['router/gemma4']);
    expect(snap.byModel['google/gemma-4-26b-a4b-it']).toBeUndefined();
  });

  it('does not count failed requests', async () => {
    stub = await StubUpstream.start((_r, respond) =>
      respond.json(500, { error: { message: 'boom' } }),
    );
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...REQUEST, model: 'router/unknown' },
    });

    expect((await app.inject({ method: 'GET', url: '/v1/usage' })).json().totals.requests).toBe(0);
  });

  it('does not count a response that reports no usage', async () => {
    stub = await StubUpstream.start((_r, respond) => {
      respond.json(200, { id: 'x', object: 'chat.completion', model: 'm', choices: [] });
    });
    const test = buildTestApp({ baseUrl: stub.baseUrl });
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect((await app.inject({ method: 'GET', url: '/v1/usage' })).json().totals.requests).toBe(0);
  });
});
