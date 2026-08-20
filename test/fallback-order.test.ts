import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { createLogger } from '../src/observability/logger.js';
import type { ResolvedConfig } from '../src/config/schema.js';

/**
 * Does the router try chain targets in the CONFIGURED ORDER, one at a time,
 * stopping at the first success?
 *
 * The two-target tests elsewhere cannot answer this. With only a primary and a
 * fallback, "tried in order" and "tried in reverse" and "tried in parallel"
 * can all end with the same upstream serving the request. Proving ordering
 * needs three or more targets and a record of WHEN each was called, not just
 * whether it was.
 *
 * Every upstream here appends to one shared journal, so the assertions are
 * about the global sequence of calls rather than per-server counts.
 */

/** A shared, ordered record of which target was called and when. */
interface Journal {
  entries: Array<{ target: string; model: string; at: number }>;
}

interface OrderedStub {
  server: Server;
  url: string;
  name: string;
  setStatus(status: number, body?: unknown): void;
}

async function startOrdered(
  name: string,
  journal: Journal,
  initialStatus: number,
): Promise<OrderedStub> {
  let status = initialStatus;
  let body: unknown = null;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        /* ignore */
      }

      journal.entries.push({
        target: name,
        model: String(parsed['model'] ?? ''),
        at: Date.now(),
      });

      // A deliberate delay makes a parallel fan-out detectable: if the router
      // dispatched all targets at once, their journal timestamps would
      // overlap instead of being separated by roughly this delay.
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            body ?? {
              id: `chatcmpl-${name}`,
              object: 'chat.completion',
              created: 1700000000,
              model: `model-${name}`,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: `served by ${name}` },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ),
        );
      }, 40);
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    name,
    url: `http://127.0.0.1:${port}/v1`,
    setStatus(s, b = null) {
      status = s;
      body = b;
    },
  };
}

let stubs: OrderedStub[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  for (const s of stubs) {
    if (s.server.listening) {
      s.server.closeAllConnections?.();
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  }
  stubs = [];
  app = undefined;
});

/** Build a router over an N-target chain, one upstream per target. */
function buildOrderedApp(built: OrderedStub[]) {
  const upstreams = new Map(
    built.map((s) => [
      s.name,
      {
        name: s.name,
        base_url: s.url,
        api_key_env: 'K',
        apiKey: 'sk-x',
        timeout_ms: 3_000,
        max_retries: 0,
        headers: {},
      },
    ]),
  );

  const config: ResolvedConfig = {
    upstreams,
    models: new Map([
      [
        'router/chain3',
        { targets: built.map((s) => ({ upstream: s.name, model: `vendor/${s.name}-model` })) },
      ],
    ]),
  };

  const logs: Array<Record<string, unknown>> = [];
  return {
    app: buildApp({
      config,
      logger: createLogger({
        level: 'debug',
        write: (l) => logs.push(JSON.parse(l) as Record<string, unknown>),
      }),
    }),
    logs,
  };
}

const REQUEST = { model: 'router/chain3', messages: [{ role: 'user', content: 'hi' }] };

describe('chain ordering', () => {
  it('tries targets in the configured order, not an arbitrary one', async () => {
    // First two fail, the third succeeds. The journal must read exactly
    // first → second → third.
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 503),
      await startOrdered('second', journal, 503),
      await startOrdered('third', journal, 200),
    ];
    const test = buildOrderedApp(stubs);
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('served by third');
    expect(journal.entries.map((e) => e.target)).toEqual(['first', 'second', 'third']);
  });

  it('sends each hop the model id configured for THAT hop', async () => {
    // A chain that advanced but reused the primary's model id would defeat
    // the point: the whole reason to fall back is to try a different model.
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 429),
      await startOrdered('second', journal, 429),
      await startOrdered('third', journal, 200),
    ];
    const test = buildOrderedApp(stubs);
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(journal.entries.map((e) => `${e.target}:${e.model}`)).toEqual([
      'first:vendor/first-model',
      'second:vendor/second-model',
      'third:vendor/third-model',
    ]);
  });

  it('stops at the first success and never calls later targets', async () => {
    // A chain that kept walking after a success would double-bill every
    // request and could return a worse model's answer.
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 503),
      await startOrdered('second', journal, 200),
      await startOrdered('third', journal, 200),
    ];
    const test = buildOrderedApp(stubs);
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(res.json().choices[0].message.content).toBe('served by second');
    expect(journal.entries.map((e) => e.target)).toEqual(['first', 'second']);
    expect(journal.entries.some((e) => e.target === 'third')).toBe(false);
  });

  it('never calls any target when the primary succeeds', async () => {
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 200),
      await startOrdered('second', journal, 200),
      await startOrdered('third', journal, 200),
    ];
    const test = buildOrderedApp(stubs);
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(journal.entries.map((e) => e.target)).toEqual(['first']);
  });

  it('calls targets SEQUENTIALLY, not in parallel', async () => {
    // Each stub waits 40ms before replying. If the router fanned out, all
    // three calls would land at nearly the same instant; walking the chain
    // means each call starts only after the previous one answered.
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 503),
      await startOrdered('second', journal, 503),
      await startOrdered('third', journal, 200),
    ];
    const test = buildOrderedApp(stubs);
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(journal.entries).toHaveLength(3);
    const [a, b, c] = journal.entries;
    // Each subsequent call must start after the previous stub's 40ms delay.
    expect(b!.at - a!.at).toBeGreaterThanOrEqual(35);
    expect(c!.at - b!.at).toBeGreaterThanOrEqual(35);
  });

  it('walks the whole chain and reports the last failure when all fail', async () => {
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 429),
      await startOrdered('second', journal, 502),
      await startOrdered('third', journal, 503),
    ];
    stubs[2]!.setStatus(503, { error: { message: 'third and final failure' } });
    const test = buildOrderedApp(stubs);
    app = test.app;

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    expect(journal.entries.map((e) => e.target)).toEqual(['first', 'second', 'third']);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain('third and final failure');
  });

  it('records every hop in order in the access log', async () => {
    const journal: Journal = { entries: [] };
    stubs = [
      await startOrdered('first', journal, 503),
      await startOrdered('second', journal, 503),
      await startOrdered('third', journal, 200),
    ];
    const test = buildOrderedApp(stubs);
    app = test.app;

    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: REQUEST });

    const access = test.logs.find((l) => l['message'] === 'chat_completion');
    const attempts = access?.['chainAttempts'] as Array<{ upstream: string; status: number | null }>;

    expect(attempts.map((a) => a.upstream)).toEqual(['first', 'second', 'third']);
    expect(attempts.map((a) => a.status)).toEqual([503, 503, 200]);
    expect(access?.['upstream']).toBe('third'); // the hop that actually served it

    // One failover warning per advance: first→second and second→third.
    const failovers = test.logs.filter((l) => l['message'] === 'upstream_failover');
    expect(failovers).toHaveLength(2);
    expect((failovers[0]?.['to'] as { upstream: string }).upstream).toBe('second');
    expect((failovers[1]?.['to'] as { upstream: string }).upstream).toBe('third');
  });
});
