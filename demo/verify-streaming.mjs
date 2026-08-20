/**
 * Prove the streaming claims rather than asserting them.
 *
 * Two properties are easy to state and easy to get wrong:
 *
 *   1. Chunks are relayed in REAL TIME, not buffered until the upstream
 *      finishes. A buffering proxy produces byte-identical output — the only
 *      difference is *when* bytes arrive, so timing is the only proof.
 *
 *   2. A stream that dies mid-flight is handled GRACEFULLY: the client keeps
 *      the partial content it already received, the absence of [DONE] lets it
 *      detect truncation, and the router neither crashes nor hangs.
 *
 *   node demo/verify-streaming.mjs            # against the live router
 *   node demo/verify-streaming.mjs --self     # self-contained, no API key
 *
 * --self spawns its own upstream with controlled delays, so the timing
 * assertions are deterministic and the run costs nothing.
 */
import { createServer } from 'node:http';

const BASE = process.env.ROUTER_URL ?? 'http://127.0.0.1:8080';
const MODEL = process.env.ROUTER_MODEL ?? 'router/mistral-small';
const SELF = process.argv.includes('--self');

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  ${g('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${r('✗')} ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};

/**
 * Read an SSE response, timestamping every chunk as it arrives.
 * The timestamps are the entire point: they are what distinguishes a real
 * relay from a buffer-then-dump.
 */
async function readStreamTimed(url, payload) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const chunks = [];
  let text = '';
  let transportError = null;

  if (res.body) {
    try {
      for await (const chunk of res.body) {
        const decoded = new TextDecoder().decode(chunk);
        text += decoded;
        chunks.push({ at: Date.now() - started, bytes: chunk.byteLength });
      }
    } catch (err) {
      transportError = err.code ?? err.message;
    }
  }

  return { status: res.status, headers: res.headers, chunks, text, transportError,
           totalMs: Date.now() - started };
}

/** Count the content deltas in an SSE body, for reporting. */
const deltasIn = (text) => (text.match(/"content":"/g) ?? []).length;

// ──────────────────────────────────────────────────────────────────────
// Test 1 — real-time delivery
// ──────────────────────────────────────────────────────────────────────
async function testRealTime(url, payload, opts = {}) {
  console.log(b('\n1. Chunks arrive in real time (not buffered)\n'));
  console.log(d('   Timing is the only way to tell a relay from a buffer:'));
  console.log(d('   a buffering proxy emits identical bytes, just all at once.\n'));

  const { chunks, text, totalMs, status } = await readStreamTimed(url, payload);

  if (status !== 200) {
    check('stream returned 200', false, `got ${status}`);
    return;
  }

  console.log(d(`   ${chunks.length} chunks over ${totalMs}ms:`));
  const shown = chunks.slice(0, 8);
  for (const [i, c] of shown.entries()) {
    const bar = '█'.repeat(Math.max(1, Math.round(c.at / Math.max(totalMs, 1) * 40)));
    console.log(d(`     chunk ${String(i + 1).padStart(2)}  +${String(c.at).padStart(5)}ms  ${bar}`));
  }
  if (chunks.length > shown.length) console.log(d(`     … ${chunks.length - shown.length} more`));
  console.log();

  const first = chunks[0]?.at ?? Infinity;
  const last = chunks[chunks.length - 1]?.at ?? 0;
  const spread = last - first;

  check(`received multiple chunks (${chunks.length})`, chunks.length > 1,
    'a single chunk means the whole response was buffered');

  // The decisive assertion is about the STREAMING PHASE, not the whole
  // request. Time-to-first-token is the model thinking before it emits
  // anything — on a live provider that is often most of the wall clock, and
  // it says nothing about whether we buffer. What distinguishes a relay from
  // a buffer is whether chunks are spread out AFTER the first one lands.
  check(
    `chunks spread across ${spread}ms after the first arrived`,
    chunks.length > 1 && spread > (opts.minSpread ?? 50),
    'every chunk landed at the same instant, which is what buffering looks like',
  );

  // A buffering proxy cannot deliver the first byte before the upstream has
  // finished, so first-byte must land meaningfully before the stream ends.
  check(
    `first byte (+${first}ms) preceded the stream ending (+${last}ms)`,
    first < last,
    'the first byte arrived only when the stream ended — that is buffering',
  );

  const ttft = first;
  const streamingPhase = spread;
  console.log(d(`\n   → time-to-first-token: ${ttft}ms  (the model thinking)`));
  console.log(d(`   → streaming phase:     ${streamingPhase}ms across ${chunks.length} chunks`));
  console.log(d(`   → ${deltasIn(text)} content deltas, ${totalMs}ms total`));
  if (ttft > streamingPhase) {
    console.log(d('\n   Note: TTFT exceeds the streaming phase here. That is the model'));
    console.log(d('   thinking before it emits, not the router buffering — the chunk'));
    console.log(d('   timings above show delivery spread out once generation begins.'));
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 2 — client disconnects mid-stream
// ──────────────────────────────────────────────────────────────────────
async function testClientDisconnect(url, payload, base = BASE) {
  console.log(b('\n2. Client disconnects mid-stream — router survives\n'));
  console.log(d('   A client that hangs up must not take the router down or\n   leak the upstream connection.\n'));

  const controller = new AbortController();
  let readChunks = 0;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    for await (const _chunk of res.body) {
      readChunks++;
      if (readChunks >= 2) {
        controller.abort(); // hang up mid-stream
        break;
      }
    }
  } catch {
    // An abort surfaces here; that is the expected path.
  }

  console.log(d(`   read ${readChunks} chunks, then aborted`));
  await new Promise((r2) => setTimeout(r2, 400));

  const health = await fetch(`${base}/health`).then((x) => x.ok).catch(() => false);
  check('router still healthy after client abort', health, 'router stopped responding');

  const after = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: false, max_tokens: 5 }),
  }).then((x) => x.status).catch(() => 0);
  check('router still serves new requests', after === 200, `got ${after}`);
}

// ──────────────────────────────────────────────────────────────────────
// Test 3 — upstream dies mid-stream (needs a controllable upstream)
// ──────────────────────────────────────────────────────────────────────
async function testUpstreamTruncation(url, payload, base = BASE) {
  console.log(b('\n3. Upstream dies mid-stream — handled gracefully\n'));
  console.log(d('   Headers (200 OK) are already sent, so the router cannot\n   retroactively send an error body. It must instead: keep the\n   partial content, omit [DONE] so the client can detect the\n   truncation, and stay alive.\n'));

  const { status, text, chunks, transportError } = await readStreamTimed(url, payload);

  const deltas = deltasIn(text);
  console.log(d(`   status ${status}, ${chunks.length} chunks, ${deltas} content deltas`));
  console.log(d(`   transport error at client: ${transportError ?? 'none (clean EOF)'}`));

  check('partial content was delivered, not discarded', deltas > 0,
    'the client got nothing despite the upstream sending frames');
  check('no [DONE] sentinel — client can detect truncation', !text.includes('[DONE]'),
    'a [DONE] would falsely signal a complete stream');

  const health = await fetch(`${base}/health`).then((x) => x.ok).catch(() => false);
  check('router survived the upstream failure', health);

  console.log(d('\n   Check the router log for this request: level="error",'));
  console.log(d('   truncated=true — even though the HTTP status was 200.'));
}

// ──────────────────────────────────────────────────────────────────────
// Self-contained mode: our own upstream + router, no API key needed
// ──────────────────────────────────────────────────────────────────────
async function runSelfContained() {
  const { buildApp } = await import('../dist/server/app.js');
  const { createLogger } = await import('../dist/observability/logger.js');

  const logs = [];
  const paced = createServer(async (req, res) => {
    const dying = (req.url ?? '').includes('/truncate');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const words = ['Chunks', ' arrive', ' one', ' at', ' a', ' time', ' here'];
    for (const [i, w] of words.entries()) {
      res.write(`data: {"id":"s","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"${w}"}}]}\n\n`);
      if (dying && i === 1) {
        // Die mid-stream, with no [DONE].
        return setTimeout(() => res.socket?.destroy(), 60);
      }
      await new Promise((r2) => setTimeout(r2, 120)); // deliberate pacing
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r2) => paced.listen(0, '127.0.0.1', r2));
  const upstreamPort = paced.address().port;

  const mk = (name, path) => [name, {
    name, base_url: `http://127.0.0.1:${upstreamPort}${path}`,
    api_key_env: 'K', apiKey: 'sk-x', timeout_ms: 10000, max_retries: 0, headers: {},
  }];

  const app = buildApp({
    config: {
      upstreams: new Map([mk('paced', '/v1'), mk('dying', '/v1/truncate')]),
      models: new Map([
        ['router/paced', { targets: [{ upstream: 'paced', model: 'demo/paced' }] }],
        ['router/dying', { targets: [{ upstream: 'dying', model: 'demo/dying' }] }],
      ]),
    },
    logger: createLogger({ level: 'debug', write: (l) => logs.push(JSON.parse(l)) }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server.address().port}/v1/chat/completions`;
  process.env.ROUTER_URL = `http://127.0.0.1:${app.server.address().port}`;

  const msg = [{ role: 'user', content: 'hi' }];
  await testRealTime(url, { model: 'router/paced', messages: msg, stream: true }, { minSpread: 300 });

  const selfBase = process.env.ROUTER_URL;
  await testClientDisconnectSelf(url, { model: 'router/paced', messages: msg, stream: true }, selfBase);
  await testUpstreamTruncationSelf(url, { model: 'router/dying', messages: msg, stream: true }, selfBase, logs);

  await app.close();
  paced.close();
}

async function testClientDisconnectSelf(url, payload, base) {
  console.log(b('\n2. Client disconnects mid-stream — router survives\n'));
  const controller = new AbortController();
  let read = 0;
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    for await (const _c of res.body) { read++; if (read >= 2) { controller.abort(); break; } }
  } catch { /* expected */ }
  console.log(d(`   read ${read} chunks, then aborted`));
  await new Promise((r2) => setTimeout(r2, 400));
  const ok = await fetch(`${base}/health`).then((x) => x.ok).catch(() => false);
  check('router still healthy after client abort', ok);
  const again = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true }),
  }).then(async (x) => { await x.text(); return x.status; }).catch(() => 0);
  check('router still serves new streaming requests', again === 200, `got ${again}`);
}

async function testUpstreamTruncationSelf(url, payload, base, logs) {
  await testUpstreamTruncation(url, payload, base);
  const access = logs.filter((l) => l.message === 'chat_completion').pop();
  console.log();
  check('router logged truncated=true', access?.truncated === true,
    `truncated=${access?.truncated}`);
  check('router logged it at error level, not info', access?.level === 'error',
    `level=${access?.level} — a truncated stream must not look like a success`);
}

// ──────────────────────────────────────────────────────────────────────
console.log(b('Streaming verification'));
console.log(d(SELF ? 'Self-contained: own upstream, deterministic timing, no API key.'
                   : `Live: ${BASE}, model ${MODEL}`));

if (SELF) {
  await runSelfContained();
} else {
  const url = `${BASE}/v1/chat/completions`;
  const payload = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Count slowly from 1 to 20, one number per line.' }],
    stream: true,
    max_tokens: 120,
  };
  await testRealTime(url, payload);
  await testClientDisconnect(url, payload);
  console.log(b('\n3. Upstream dies mid-stream\n'));
  console.log(y('   Skipped: a real provider will not fail on command.'));
  console.log(d('   Run `node demo/verify-streaming.mjs --self` for this case,'));
  console.log(d('   or use the mock upstream (demo/README.md).'));
}

console.log(b(`\n${passed} passed, ${failed} failed\n`));
process.exit(failed > 0 ? 1 : 0);
