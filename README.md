# AI Inference Router

An OpenAI-compatible inference router. It exposes a single, stable Chat
Completions API and forwards each request to a configurable upstream LLM
provider based on the model alias the client asks for.

It is a drop-in proxy: point the official OpenAI SDK, curl, or any HTTP client
at it and everything works unchanged.

```
                    ┌─────────────────────┐
  OpenAI SDK ─────► │                     │ ──► OpenRouter
  curl       ─────► │  AI Inference Router│ ──► OpenAI
  LangChain  ─────► │                     │ ──► self-hosted vLLM
                    └─────────────────────┘
                     router/gemma4  →  google/gemma-4-26b-a4b-it
                     router/nemotron3 → nvidia/nemotron-3-nano-30b-a3b
                     router/mistral-small → mistralai/mistral-small-2603
```

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env       # then add your OpenRouter API key
npm run dev                # http://localhost:8080
```

Send it a request:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "router/gemma4",
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

With the official OpenAI SDK — note that only `baseURL` changes:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'not-used',           // unless ROUTER_API_KEY is set
});

const response = await client.chat.completions.create({
  model: 'router/gemma4',
  messages: [{ role: 'user', content: 'Say hello.' }],
});
```

## Demo

A complete guided walkthrough — live calls, streaming, routing verification,
and on-demand error simulation — lives in **[`demo/README.md`](demo/README.md)**.

```bash
set -a; . ./.env; set +a
npm start                 # terminal 1

./demo/demo.sh            # terminal 2
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the test suite (109 tests, no network required) |
| `npm run type-check` | Type-check without emitting |

## Configuration

Two files: `config.yaml` describes routing, `.env` holds secrets. They are kept
separate so `config.yaml` is safe to commit.

### `config.yaml`

```yaml
upstreams:
  openrouter:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY   # env var NAME, not the key itself
    timeout_ms: 120000                # optional, default 120000
    max_retries: 2                    # optional, default 2
    headers:                          # optional, sent with every request
      X-Title: AI Inference Router

models:
  router/gemma4:
    upstream: openrouter
    model: google/gemma-4-26b-a4b-it

  router/nemotron3:
    upstream: openrouter
    model: nvidia/nemotron-3-nano-30b-a3b

  router/mistral-small:
    upstream: openrouter
    model: mistralai/mistral-small-2603
```

**`upstreams`** are backends. **`models`** map a client-facing alias to an
upstream plus the model id that upstream expects.

API keys are referenced by environment variable *name* (`api_key_env`) rather
than written inline. That keeps secrets out of version control and lets the
same `config.yaml` work across every environment.

### Adding a provider

Purely additive — no code changes. To add a self-hosted vLLM server:

```yaml
upstreams:
  local-vllm:
    base_url: http://localhost:8000/v1
    api_key_env: VLLM_API_KEY
    timeout_ms: 300000

models:
  router/local-llama:
    upstream: local-vllm
    model: meta-llama/Llama-3.1-8B-Instruct
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | Referenced by the example config |
| `ROUTER_API_KEY` | No | If set, clients must send `Authorization: Bearer <key>` |
| `PORT` | No | Listen port (default `8080`) |
| `HOST` | No | Bind address (default `0.0.0.0`) |
| `CONFIG_PATH` | No | Config file path (default `config.yaml`) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default `info`) |

## API

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | Chat Completions. Non-streaming by default; SSE when `stream: true` |
| `GET /v1/models` | List configured aliases in OpenAI format |
| `GET /health` | Liveness check; never requires auth |

### Errors

Every error uses the OpenAI error envelope, so SDK error handling works
normally — the OpenAI SDK raises a typed `NotFoundError` for an unknown model.

```json
{
  "error": {
    "message": "The model `gpt-4` does not exist or you do not have access to it. Configured models: router/gemma4, router/nemotron3, router/mistral-small",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

| Condition | Status |
|---|---|
| Malformed body, missing `messages` | 400 |
| Unknown model alias | 404 |
| Missing/wrong router key (when enabled) | 401 |
| Upstream returned an error | upstream's status, body passed through |
| Upstream unreachable | 502 |
| Upstream timed out | 504 |

## Observability

One structured JSON line per request:

```json
{
  "timestamp": "2026-08-20T16:05:41.706Z",
  "level": "info",
  "message": "chat_completion",
  "requestId": "req-4",
  "method": "POST",
  "path": "/v1/chat/completions",
  "model": "router/gemma4",
  "upstream": "openrouter",
  "upstreamModel": "google/gemma-4-26b-a4b-it",
  "status": 200,
  "attempts": 1,
  "latencyMs": 1027,
  "upstreamLatencyMs": 961,
  "stream": false,
  "promptTokens": 18,
  "completionTokens": 2,
  "totalTokens": 20
}
```

`latencyMs` is total time in the router; `upstreamLatencyMs` is time spent
waiting on the provider. The gap between them is the router's own overhead —
typically 15–60ms, mostly JSON serialization.

Credentials are redacted centrally in the log serializer rather than at each
call site, so a new call site cannot leak a key by forgetting to scrub it.
A test asserts that no API key ever reaches the logs.

## Extensions implemented

All three Part 2 extensions — **A. Streaming**, **B. Fallback chains**, and
**C. Token counting** — plus a few smaller additions.

### A. Streaming

`stream: true` is forwarded upstream with streaming enabled, and SSE chunks are
relayed to the caller as they arrive rather than buffered. Backpressure is
respected, so a slow client cannot make chunks pile up in memory.

Mid-stream failures are handled on both sides. If the **client** disconnects,
the router closes its upstream side and stays healthy. If the **upstream** dies
mid-flight, the response has already sent `200 OK`, so no error body is
possible — instead the partial content is preserved, the stream ends without a
`[DONE]` sentinel (which is how a client detects truncation), and it is logged
at `error` level with `truncated: true` rather than looking like a success.

**Verifying it:** printing SSE frames does not prove real-time delivery, since a
buffering proxy emits identical bytes. Only timing separates them.

`curl` alone is enough to check every case — no webapp or SSE client needed.
`--trace-time` makes curl timestamp each receive itself:

```bash
curl -sN --trace-time --trace-ascii /dev/stdout \
  http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/mistral-small","messages":[{"role":"user","content":"Count 1 to 10."}],"stream":true}' \
  2>/dev/null | grep "Recv data"
```
```
10:19:36.607975 <= Recv data, 31 bytes (0x1f)
10:19:36.620560 <= Recv data, 292 bytes (0x124)
10:19:36.648547 <= Recv data, 292 bytes (0x124)
```

Distinct timestamps across separate receives is the proof; a buffering proxy
would deliver everything in one burst. See
[demo/README.md](demo/README.md#testing-streaming-with-curl-alone) for the
disconnect and truncation cases with curl.

For automated assertions that can fail CI:

```bash
node demo/verify-streaming.mjs          # against a live upstream
node demo/verify-streaming.mjs --self   # deterministic, no API key
```

This timestamps each chunk on arrival and asserts they are spread over time
after the first lands — deliberately measuring the streaming phase rather than
total latency, because time-to-first-token is the model thinking and says
nothing about buffering. `--self` adds the upstream-dies-mid-stream case, which
a real provider will not perform on command.

### B. Fallback chains

A model alias can list an ordered set of targets. When one fails, the router
advances to the next; the client sees a single successful response and never
learns a failure happened. See [Fallback chains](#fallback-chains) for the
config syntax.

**Retry and fallback are separate layers, deliberately.** Retry re-attempts the
*same* target for a blip that will probably clear on its own. Fallback gives up
on a target entirely for a failure retrying will not fix — out of quota,
provider down, credentials rejected. Each target exhausts its own retries before
the chain advances.

**What triggers a failover:** 401, 402, 403, 404, 408, 429, and 5xx — plus
network errors and timeouts. All are specific to one target.

**What does not:** a 400. The request itself is malformed, so the next provider
would reject it identically and failing over would only multiply latency and
cost. The one exception is a 400 whose body says the *model id* was rejected
(OpenRouter answers `"... is not a valid model ID"` this way). Each hop sends a
different model id, so that failure really is target-specific — treating every
400 as fatal silently defeats the chain, which live testing caught.

**When every target fails**, the *last* failure is surfaced: by then the chain
is exhausted and the final attempt is the most recent evidence of why.

Failovers log an `upstream_failover` warning naming both endpoints, and the
access line gains `failedOver: true` plus a `chainAttempts` array showing every
hop and what it returned.

**Verifying it:** a 200 does not prove the chain fired — a chain that never
engages returns 200 too. The evidence is which upstream received the request:

```bash
node demo/verify-fallback.mjs   # two independent upstreams, no API key
```

It runs a **three**-hop chain — two targets cannot prove ordering, since "in
sequence" and "in reverse" can both end with the same server answering — and
prints the actual call journal:

```
   call journal (the actual sequence of upstream calls):
     1. +   1ms  primary    model=vendor/tier-1
     2. +   1ms  secondary  model=vendor/tier-2
     3. +   2ms  tertiary   model=vendor/tier-3
```

Across ten scenarios it asserts the order is exactly as configured, that each
hop receives **its own** model id rather than the primary's, that the walk stops
at the first success, that a healthy primary leaves later targets untouched, and
that a genuinely malformed request does not walk the chain at all.

These assertions were themselves checked by deliberately breaking the router —
reversing the chain, continuing past a success, reusing the primary's model id,
and fanning out in parallel — and confirming the corresponding tests failed each
time. See [demo/README.md](demo/README.md#how-do-you-know-it-fell-back-to-the-correct-model).

### C. Token counting

`GET /v1/usage` reports cumulative prompt, completion, and total tokens, broken
down per model alias and sorted by spend:

```json
{
  "since": "2026-08-20T16:58:39.186Z",
  "totals": { "requests": 4, "promptTokens": 65, "completionTokens": 25, "totalTokens": 90 },
  "byModel": {
    "router/nemotron3": { "requests": 1, "promptTokens": 21, "completionTokens": 20, "totalTokens": 41 },
    "router/gemma4": { "requests": 2, "promptTokens": 24, "completionTokens": 3, "totalTokens": 27 }
  }
}
```

Counts are attributed to the **alias**, not the upstream model. With a fallback
chain one alias can be served by several different models, and the question
being answered is "what did this alias cost me".

Only responses that actually report usage are counted, so a provider that omits
the block does not silently record as zero — "not reported" stays distinct from
"free". Failed requests are not counted at all.

Deliberately in-process and unpersisted: a restart resets the counters. This is
operational visibility, not billing — anything authoritative belongs in the
provider's billing data or a metrics backend scraped from these numbers.

### Smaller additions

- **Retries with exponential backoff and jitter** on transient failures.
- **`GET /v1/models`** and **`GET /health`**.
- **Optional router-level auth** via `ROUTER_API_KEY`.

## Design decisions

**Validation is permissive by design.** The router validates only the fields it
routes on — `model`, `messages`, `stream` — and passes everything else through
untouched. Strictly validating the full OpenAI schema would mean this proxy
breaks every time a provider ships a new parameter, which is the opposite of
what a routing layer is for. A test asserts that unknown parameters survive
the hop.

**Non-streaming is the default, and every spelling of it works.** A request with
`stream` omitted, `stream: false`, or `stream: null` returns a single JSON
completion; only an explicit `stream: true` switches to SSE. OpenAI's OpenAPI
declares `stream` as `nullable: true, default: false`, so `null` is a legitimate
way for a client to say "not streaming" — clients that serialize unset optionals
as null do send it. The router accepts it and drops the key before forwarding,
because not every provider is that lenient (OpenRouter rejects an explicit null
with a 400). Tests pin all four cases.

**Responses report the alias, not the upstream id.** A client that asks for
`router/gemma4` gets `"model": "router/gemma4"` back. Leaking the upstream id
would couple clients to whichever backend the router happens to pick and defeat
the point of having an alias.

**Streaming chunks are not rewritten.** Applying that same rename inside the SSE
stream would mean parsing and re-serializing every frame in the hot path, adding
latency and a failure mode, for a cosmetic benefit. Streamed chunks therefore
carry the upstream's model id. This is a deliberate trade; if strict symmetry
mattered more than hot-path simplicity, a transform stream over `data:` lines
would be the fix.

**Only transient failures are retried.** A 400 or 404 is a client mistake:
retrying wastes time and multiplies load on the provider without ever
succeeding. 408/429/5xx and network errors are retried. Backoff uses full
jitter — without it, every request a provider rate-limits at the same moment
retries at the same moment, reproducing the spike that caused the limit.

**Streaming responses are never retried once bytes are written.** The client has
already seen partial output; replaying would corrupt it.

**Config is validated once at boot, not per request.** A typo in an upstream name
or a missing API key exits non-zero with a readable message before the socket
opens, rather than surfacing as a confusing 500 to whoever hits that route first.
Every missing variable is reported at once, so a misconfigured deploy does not
take one restart per mistake.

**The client's credential is never forwarded upstream.** The client authenticates
to the router; the router authenticates to the provider with its own key.
Forwarding the client's token would leak it to a third party. A test asserts it.

**Routing is a pure function.** `resolveRoute(config, alias)` has no I/O, so the
routing logic is exhaustively unit-testable without a server or a network.
Everything else in the request path is transport.

## Testing

```bash
npm test                                # 109 tests
node demo/verify-streaming.mjs --self   # streaming, end to end
node demo/verify-fallback.mjs           # fallback chains, end to end
```

The two verifiers run the real server over real sockets and assert on
observable behavior — chunk arrival times, which upstream got the request —
rather than on internals. Both are self-contained: no API key, no network.

The suite runs fully offline — no API key, no network — so it works in CI. Rather
than mocking `fetch`, integration tests run a real HTTP server as a stub upstream,
so they exercise genuine network behavior: headers actually sent, connections
actually refused, streams actually chunked. That is where proxy bugs live.

Coverage includes config validation, alias resolution, header and credential
handling, parameter passthrough, retry behavior, all error paths (unknown model,
upstream 5xx, timeout, unreachable, non-JSON response), streaming passthrough and
incremental delivery, auth, and log redaction. The extensions add fallback
chains (each failover trigger, the no-failover-on-400 rule, retry-then-advance
ordering, and chain exhaustion) and token counting.

Verified end to end against live OpenRouter: all three aliases return
completions, streaming works, and the official OpenAI SDK works unmodified
including typed errors and `models.list()`.

## What I would do next

Roughly in priority order:

1. **Circuit breaking on top of fallback.** Chains currently try the primary
   every time. A breaker that skips a target known to be failing would cut the
   latency penalty during a sustained outage.
2. **Load balancing across targets** for the same alias — weighted or
   least-latency — which the chain config already accommodates.
3. **Prometheus metrics.** The access log and usage tracker carry the right
   fields; exposing them at `/metrics` is mostly plumbing.
4. **Persisting usage** to survive restarts, and per-key budgets once more than
   one client uses it.
5. **Streaming token counts.** Usage is recorded for non-streaming responses;
   capturing it from a stream means parsing the final SSE frame, which the
   passthrough design deliberately avoids today.
6. **Request/response caching** for identical deterministic (`temperature: 0`)
   requests.

## Project structure

```
src/
├── config/          # Load and validate config; resolve API keys from env
│   ├── schema.ts
│   └── load.ts
├── router/          # The routing decision, and OpenAI-shaped errors
│   ├── resolve.ts
│   └── errors.ts
├── upstream/        # Forwarding, retry policy, fallback chains, timeouts
│   ├── client.ts
│   ├── fallback.ts
│   └── retry.ts
├── server/          # Fastify app, request validation
│   ├── app.ts
│   └── validate.ts
├── observability/   # Structured logging with redaction; token accounting
│   ├── logger.ts
│   └── usage.ts
└── index.ts         # Entry point
```

## Reflection: working with AI-assisted tooling

I built this with Claude Code (Claude Fable 5), which wrote essentially all of
the code. The workflow that worked was treating it as an engineer I was
reviewing rather than an autocomplete: agree the design first, then let it
implement, then check its work against reality.

**Where it helped most.** Scaffolding a well-structured project was close to
instant — module boundaries, the config schema, and the error taxonomy came out
clean on the first pass because I specified the shape up front rather than
letting it improvise. It was strongest on the tedious-but-important work I would
otherwise have cut for time: the hop-by-hop header list, full-jitter backoff, SSE
backpressure handling, and a 59-test suite covering error paths I would probably
have left for later. Writing a real stub HTTP server instead of mocking `fetch`
was its suggestion, and it was the right call.

**Where I had to course-correct.** Three things stood out.

The model instinctively wanted to validate the complete OpenAI request schema.
That looks more rigorous and is actively wrong for a proxy — it would break the
router every time a provider adds a parameter. I had it invert the default to
passthrough with validation only on the fields being routed on, and add a test
pinning that behavior.

It also initially rewrote the model id inside streaming chunks for symmetry with
the non-streaming path. Consistent, but it meant parsing and re-serializing every
SSE frame in the hot path for a cosmetic gain. We dropped it and documented the
asymmetry as a deliberate trade rather than hiding it.

Smaller, but telling: it wrote `new RouterError(message ? 401 : 401, ...)` — a
ternary with identical branches, which is the kind of plausible-looking noise
that survives if nobody reads the diff. TypeScript's strict mode caught a
separate class of issue in the Fastify error handler that the tests did not.

**The general lesson.** The model is good at producing code that looks right and
genuinely is right most of the time; the failure mode is confident,
well-formatted decisions that are subtly wrong for the specific problem. Passing
tests were not sufficient evidence — the permissive-validation and
streaming-rewrite issues both had green suites. What actually caught things was
running it against live OpenRouter and the real OpenAI SDK, which is why that
verification is in the README rather than left as an exercise.
