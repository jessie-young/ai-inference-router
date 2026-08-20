/**
 * Prove the fallback chain works, rather than asserting it.
 *
 * The hard part of verifying a fallback is that a working chain and a chain
 * that never fires look identical from the client: both return 200. The only
 * way to tell them apart is to observe WHICH upstream was hit — so this spins
 * up two independent upstreams and checks each one's request count after every
 * scenario. If the second server was never called, no fallback happened,
 * regardless of what the response says.
 *
 *   node demo/verify-fallback.mjs
 *
 * Self-contained: needs no API key and makes no external calls.
 */
import { createServer } from 'node:http';

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`    ${g('✓')} ${label}`); passed++; }
  else { console.log(`    ${r('✗')} ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

/** An upstream that records every request and answers however we tell it to. */
async function startUpstream(name) {
  const requests = [];
  const stubRef = {};
  let responder = (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(name)));
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
      requests.push(body);
      if (stubRef.journal) {
        stubRef.journal.push({ target: name, model: body.model, at: Date.now() });
      }
      responder(body, res);
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));

  Object.assign(stubRef, {
    name, server, requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    set(fn) { responder = fn; },
    reset() { requests.length = 0; },
  });
  return stubRef;
}

const completion = (who) => ({
  id: `chatcmpl-${who}`,
  object: 'chat.completion',
  created: 1700000000,
  model: `model-from-${who}`,
  choices: [{ index: 0, message: { role: 'assistant', content: `served by ${who}` },
              finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const respondWith = (status, payload) => (_b, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const { buildApp } = await import('../dist/server/app.js');
const { createLogger } = await import('../dist/observability/logger.js');

const primary = await startUpstream('primary');
const secondary = await startUpstream('secondary');
const tertiary = await startUpstream('tertiary');

/**
 * A shared, ordered record of which upstream was called and when.
 *
 * Per-server request counts cannot prove ORDER: with two targets, "tried in
 * sequence" and "tried in reverse" can both end with the same server serving
 * the request. One global journal across three targets can.
 */
const journal = [];
for (const stub of [primary, secondary, tertiary]) {
  stub.journal = journal;
}

const logs = [];
const mkUpstream = (name, url) => [name, {
  name, base_url: url, api_key_env: 'K', apiKey: 'sk-x',
  timeout_ms: 2000, max_retries: 0, headers: {},
}];

const app = buildApp({
  config: {
    upstreams: new Map([
      mkUpstream('primary', primary.url),
      mkUpstream('secondary', secondary.url),
      mkUpstream('tertiary', tertiary.url),
      mkUpstream('dead', 'http://127.0.0.1:9099/v1'),
    ]),
    models: new Map([
      ['router/chain', { targets: [
        { upstream: 'primary', model: 'vendor/model:free' },
        { upstream: 'secondary', model: 'vendor/model' },
      ]}],
      ['router/chain-dead-primary', { targets: [
        { upstream: 'dead', model: 'vendor/model:free' },
        { upstream: 'secondary', model: 'vendor/model' },
      ]}],
      ['router/chain3', { targets: [
        { upstream: 'primary', model: 'vendor/tier-1' },
        { upstream: 'secondary', model: 'vendor/tier-2' },
        { upstream: 'tertiary', model: 'vendor/tier-3' },
      ]}],
    ]),
  },
  logger: createLogger({ level: 'debug', write: (l) => logs.push(JSON.parse(l)) }),
});
await app.listen({ port: 0, host: '127.0.0.1' });
const URL_ = `http://127.0.0.1:${app.server.address().port}/v1/chat/completions`;

const ask = async (model = 'router/chain') => {
  const res = await fetch(URL_, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: res.status, body: await res.json() };
};

const reset = () => {
  primary.reset(); secondary.reset(); tertiary.reset();
  journal.length = 0; logs.length = 0;
};
const servedBy = (body) => body?.choices?.[0]?.message?.content ?? '(error)';

console.log(b('Fallback chain verification'));
console.log(d('Two independent upstreams. The proof is which one received the'));
console.log(d('request — a chain that never fires also returns 200.\n'));

// ── 1. No failure: the primary serves and the fallback is never touched ──
console.log(b('1. Primary healthy → fallback must NOT be touched'));
reset();
{
  const { status, body } = await ask();
  check('client got 200', status === 200, `got ${status}`);
  check('served by the primary', servedBy(body).includes('primary'), servedBy(body));
  check('primary received exactly 1 request', primary.requests.length === 1,
    `got ${primary.requests.length}`);
  check('secondary received 0 requests', secondary.requests.length === 0,
    `got ${secondary.requests.length} — the chain fired when it should not have`);
}

// ── 2. Quota exhausted (402): the spec's motivating case ──
console.log(b('\n2. Primary out of credit (402) → chain advances'));
console.log(d('   This is the :free-tier-exhausted case from the brief.'));
reset();
{
  primary.set(respondWith(402, { error: { message: 'Insufficient credits' } }));
  const { status, body } = await ask();
  check('client got 200 despite the primary failing', status === 200, `got ${status}`);
  check('served by the SECONDARY', servedBy(body).includes('secondary'), servedBy(body));
  check('primary was tried first', primary.requests.length === 1);
  check('secondary was then tried', secondary.requests.length === 1);
  check('each hop received its own model id',
    primary.requests[0]?.model === 'vendor/model:free' &&
    secondary.requests[0]?.model === 'vendor/model',
    `${primary.requests[0]?.model} / ${secondary.requests[0]?.model}`);
  const failover = logs.find((l) => l.message === 'upstream_failover');
  check('a failover was logged at warn level', failover?.level === 'warn');
  check('the log names both endpoints',
    failover?.from?.upstream === 'primary' && failover?.to?.upstream === 'secondary');
}

// ── 3. Unreachable primary ──
console.log(b('\n3. Primary unreachable (connection refused) → chain advances'));
reset();
{
  const { status, body } = await ask('router/chain-dead-primary');
  check('client got 200', status === 200, `got ${status}`);
  check('served by the secondary', servedBy(body).includes('secondary'), servedBy(body));
  const failover = logs.find((l) => l.message === 'upstream_failover');
  check('failover recorded the connection error', Boolean(failover?.error), failover?.error);
}

// ── 4. Model-id rejection reported as a 400 ──
console.log(b('\n4. Primary rejects the MODEL ID with a 400 → chain advances'));
console.log(d('   OpenRouter reports an unknown model this way. Each hop sends a'));
console.log(d('   different id, so this failure is specific to one target.'));
reset();
{
  primary.set(respondWith(400, { error: { message: 'vendor/model:free is not a valid model ID' } }));
  const { status, body } = await ask();
  check('client got 200', status === 200, `got ${status}`);
  check('served by the secondary', servedBy(body).includes('secondary'), servedBy(body));
  check('secondary was actually called', secondary.requests.length === 1);
}

// ── 5. A genuinely malformed request must NOT walk the chain ──
console.log(b('\n5. Genuinely malformed request (400) → must NOT advance'));
console.log(d('   The next provider would reject it identically, so failing over'));
console.log(d('   would only multiply cost and latency for a guaranteed failure.'));
reset();
{
  primary.set(respondWith(400, { error: { message: 'messages must be non-empty' } }));
  const { status } = await ask();
  check('client got the 400 straight back', status === 400, `got ${status}`);
  check('secondary was NOT called', secondary.requests.length === 0,
    `it was called ${secondary.requests.length} time(s) — wasted spend`);
}

// ── 6. Every target fails ──
console.log(b('\n6. All targets fail → the LAST failure is surfaced'));
reset();
{
  primary.set(respondWith(429, { error: { message: 'primary rate limited' } }));
  secondary.set(respondWith(503, { error: { message: 'secondary unavailable' } }));
  const { status, body } = await ask();
  check('client sees the final failure (503), not the first (429)', status === 503,
    `got ${status}`);
  check('the error body is the last one', JSON.stringify(body).includes('secondary unavailable'));
  check('both targets were tried',
    primary.requests.length === 1 && secondary.requests.length === 1,
    `${primary.requests.length} / ${secondary.requests.length}`);
  const access = logs.find((l) => l.message === 'chat_completion');
  check('the access log records every hop', Array.isArray(access?.chainAttempts) &&
    access.chainAttempts.length === 2, JSON.stringify(access?.chainAttempts));
}

// ── 7. Token usage is attributed to the alias, not the serving model ──
console.log(b('\n7. Usage counts the ALIAS even when a fallback served it'));
reset();
{
  primary.set(respondWith(402, { error: { message: 'no credit' } }));
  secondary.set((_b2, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion('secondary')));
  });
  await ask();
  const usage = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/usage`)
    .then((x) => x.json());
  check('usage is keyed by the alias', Boolean(usage.byModel['router/chain']),
    Object.keys(usage.byModel).join(', '));
  check('not keyed by the upstream model id',
    !Object.keys(usage.byModel).some((k) => k.startsWith('vendor/')));
}

// ── 8. Order: a 3-hop chain is walked in sequence ──
console.log(b('\n8. Three-hop chain → tried in ORDER, one at a time'));
console.log(d('   Two targets cannot prove ordering: "in sequence" and "in reverse"'));
console.log(d('   can both end with the same server answering. Three can.\n'));
reset();
{
  primary.set(respondWith(503, { error: { message: 'tier-1 down' } }));
  secondary.set(respondWith(503, { error: { message: 'tier-2 down' } }));
  tertiary.set((_b3, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion('tertiary')));
  });

  const t0 = Date.now();
  const { status, body } = await ask('router/chain3');

  console.log(d('   call journal (the actual sequence of upstream calls):'));
  for (const [i, e] of journal.entries()) {
    console.log(d(`     ${i + 1}. +${String(e.at - t0).padStart(4)}ms  ${e.target.padEnd(10)} model=${e.model}`));
  }
  console.log();

  check('client got 200', status === 200, `got ${status}`);
  check('the THIRD target served it', servedBy(body).includes('tertiary'), servedBy(body));
  check('all three were called', journal.length === 3, `${journal.length} calls`);
  check('called in configured order: primary → secondary → tertiary',
    journal.map((e) => e.target).join(' → ') === 'primary → secondary → tertiary',
    journal.map((e) => e.target).join(' → '));
  check('each hop got ITS OWN model id, not the primary\'s',
    journal.map((e) => e.model).join(',') === 'vendor/tier-1,vendor/tier-2,vendor/tier-3',
    journal.map((e) => e.model).join(','));

  const access = logs.find((l) => l.message === 'chat_completion');
  check('access log records all three hops in order',
    JSON.stringify(access?.chainAttempts?.map((a) => a.upstream)) ===
      JSON.stringify(['primary', 'secondary', 'tertiary']),
    JSON.stringify(access?.chainAttempts?.map((a) => a.upstream)));
  check('access log attributes the request to the hop that served it',
    access?.upstream === 'tertiary', access?.upstream);
}

// ── 9. Stops at the first success ──
console.log(b('\n9. Stops at the first success — later targets untouched'));
console.log(d('   A chain that kept walking would double-bill every request.'));
reset();
{
  primary.set(respondWith(429, { error: { message: 'tier-1 busy' } }));
  secondary.set((_b4, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion('secondary')));
  });
  tertiary.set(respondWith(200, completion('tertiary')));

  const { body } = await ask('router/chain3');
  console.log(d(`   call journal: ${journal.map((e) => e.target).join(' → ')}`));

  check('the SECOND target served it', servedBy(body).includes('secondary'), servedBy(body));
  check('exactly 2 calls were made', journal.length === 2, `${journal.length}`);
  check('the third target was NEVER called',
    !journal.some((e) => e.target === 'tertiary'),
    'it was called — that is wasted spend on every request');
}

// ── 10. Healthy primary short-circuits the whole chain ──
console.log(b('\n10. Healthy primary → chain never advances'));
reset();
{
  primary.set(respondWith(200, completion('primary')));
  secondary.set(respondWith(200, completion('secondary')));
  tertiary.set(respondWith(200, completion('tertiary')));

  const { body } = await ask('router/chain3');
  console.log(d(`   call journal: ${journal.map((e) => e.target).join(' → ')}`));

  check('served by the primary', servedBy(body).includes('primary'), servedBy(body));
  check('exactly 1 call was made', journal.length === 1, `${journal.length}`);
  const failovers = logs.filter((l) => l.message === 'upstream_failover');
  check('no failover was logged', failovers.length === 0, `${failovers.length} logged`);
}

await app.close();
primary.server.close();
secondary.server.close();
tertiary.server.close();

console.log(b(`\n${passed} passed, ${failed} failed\n`));
process.exit(failed > 0 ? 1 : 0);
