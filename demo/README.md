# Demo Guide

Everything needed to spin up the router and demonstrate it live, including
copy-pasteable commands, how to read the logs, and how to trigger every error
path on demand.

**Fastest path:** [Quick start](#quick-start) → `./demo/demo.sh`.

---

## Quick start

Two terminals. Terminal 1 runs the router and shows its logs; Terminal 2 is
where you type commands.

### Terminal 1 — start the router

```bash
cd /path/to/ai-inference-router
npm install
npm run build

# Load OPENROUTER_API_KEY from .env into the environment
set -a; . ./.env; set +a

npm start
```

You should see a startup line confirming what it loaded:

```json
{"timestamp":"2026-08-20T16:17:43.193Z","level":"info","message":"router started",
 "port":8080,"models":["router/gemma4","router/nemotron3","router/mistral-small"],
 "upstreams":["openrouter"],"authRequired":false}
```

**Leave this terminal visible during the demo** — every request logs a line here
in real time. That is your live observability view.

### Terminal 2 — run the guided demo

```bash
./demo/demo.sh
```

It pauses between sections so you can talk. Options:

```bash
./demo/demo.sh --fast     # no pauses
./demo/demo.sh live       # only live-OpenRouter sections
./demo/demo.sh errors     # only error handling (uses no credits)

# Show the router's log lines inline during the demo:
ROUTER_LOG=/tmp/router.log ./demo/demo.sh
```

To capture logs to a file while still watching them:

```bash
npm start 2>&1 | tee /tmp/router.log
```

---

## Manual commands

Every command below is standalone — good for improvising if someone asks
"what if…".

### Is it up?

```bash
curl http://localhost:8080/health
```
```json
{"status":"ok","models":3,"upstreams":1}
```

### What models are available?

```bash
curl http://localhost:8080/v1/models
```

Returns the OpenAI model-list shape, listing **aliases** — clients never see
provider model names.

### A basic completion (non-streaming)

One JSON response, no SSE. This is the default; streaming is covered below.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "router/gemma4",
    "messages": [{"role": "user", "content": "Say hello in 5 words."}],
    "stream": false
  }'
```

### Non-streaming is the default

Every way of saying "not streaming" returns a single JSON body:

```bash
for variant in '' ',"stream":false' ',"stream":null'; do
  curl -s -o /tmp/ns.json -w "HTTP %{http_code}  " http://localhost:8080/v1/chat/completions \
    -H 'content-type: application/json' \
    -d "{\"model\":\"router/gemma4\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5$variant}"
  python3 -c "import json;print('object=' + json.load(open('/tmp/ns.json'))['object'])"
done
```
```
HTTP 200  object=chat.completion    # stream omitted
HTTP 200  object=chat.completion    # stream: false
HTTP 200  object=chat.completion    # stream: null
```

Only an explicit `stream: true` returns `text/event-stream`. `null` is accepted
because OpenAI's spec declares `stream` as nullable with a `false` default.

### All three models, same request shape

```bash
for m in router/gemma4 router/nemotron3 router/mistral-small; do
  echo "--- $m ---"
  curl -s http://localhost:8080/v1/chat/completions \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"max_tokens\":20}"
  echo
done
```

Only the `model` field changes. That is the router's whole value proposition.

### Streaming (extension A)

Non-streaming is the default; `stream: true` returns Server-Sent Events:

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "router/mistral-small",
    "messages": [{"role": "user", "content": "Count from 1 to 10."}],
    "stream": true
  }'
```

`-N` disables curl's buffering so you see tokens arrive live. The stream ends
with `data: [DONE]`.

### Parameters pass straight through

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "router/mistral-small",
    "messages": [{"role": "user", "content": "Pick a number 1-10."}],
    "temperature": 0,
    "max_tokens": 50,
    "top_p": 0.9,
    "seed": 42
  }'
```

The router validates only `model`, `messages`, and `stream`; everything else is
forwarded untouched, so provider-specific parameters keep working.

### Multi-turn conversation

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "router/mistral-small",
    "messages": [
      {"role": "system",    "content": "You answer in one word."},
      {"role": "user",      "content": "Capital of France?"},
      {"role": "assistant", "content": "Paris"},
      {"role": "user",      "content": "And of Japan?"}
    ]
  }'
```
Replies `Tokyo` — history and system prompts survive the hop.

### Testing streaming with curl alone

You do **not** need a webapp, an SSE client library, or anything persistent.
`curl` handles every streaming case, including both mid-stream failures. The
only flag that really matters is `-N` (`--no-buffer`), which stops curl from
buffering the response before printing it — without it, output looks batched
even when the router is streaming perfectly.

#### 1. Watch tokens arrive live

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "router/mistral-small",
    "messages": [{"role": "user", "content": "Count from 1 to 20."}],
    "stream": true
  }'
```

Frames scroll as they are generated, ending with `data: [DONE]`.

#### 2. Prove it is real-time, not buffered

Watching text appear is suggestive but not proof — a fast enough buffered
response looks the same. `--trace-time` makes curl timestamp every receive
itself, so the evidence is curl's, not ours:

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
10:19:36.659202 <= Recv data, 291 bytes (0x123)
10:19:36.680477 <= Recv data, 292 bytes (0x124)
```

**Distinct timestamps across separate receives is the proof.** A buffering proxy
would show every byte arriving in one burst at the end.

For elapsed-time deltas instead of wall-clock, pipe through Python (no extra
tools to install, and `date +%N` does not work on macOS):

```bash
curl -sN http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/mistral-small","messages":[{"role":"user","content":"Count 1 to 10."}],"stream":true}' \
| python3 -u -c '
import sys, time
start = time.time()
try:
    for line in sys.stdin:
        if line.startswith("data: "):
            print(f"+{(time.time()-start)*1000:7.0f}ms  {line[6:50].strip()}")
except BrokenPipeError:
    pass          # tolerate being piped into head
'
```
```
+    477ms  {"id":"gen-...","object":"chat.completion.chunk"
+    507ms  {"id":"gen-...","object":"chat.completion.chunk"
+    538ms  {"id":"gen-...","object":"chat.completion.chunk"
+    694ms  [DONE]
```

The first number is time-to-first-token — the model thinking. What proves
streaming is that the *later* numbers keep climbing.

#### 3. Client disconnects mid-stream

Two ways to hang up on purpose. Either should leave the router healthy:

```bash
# (a) close the pipe early — curl dies of SIGPIPE
curl -sN http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/mistral-small","messages":[{"role":"user","content":"Write a long paragraph."}],"stream":true,"max_tokens":300}' \
  | head -3

# (b) give curl a deadline it will hit mid-stream
curl -sN --max-time 1 http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/mistral-small","messages":[{"role":"user","content":"Write a long story."}],"stream":true,"max_tokens":400}'
# curl exit code 28 = timeout, i.e. we hung up first

# then confirm the router is unharmed
curl -s http://localhost:8080/health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/gemma4","messages":[{"role":"user","content":"hi"}]}'
```

Both should print `200` — the router closed its upstream side and moved on.

Run these against a **live** upstream, not the mock: the mock replies in
milliseconds, so `--max-time 1` never fires and curl exits `0` instead of `28`.

#### 4. Upstream dies mid-stream

A real provider will not fail on command, so use the mock upstream:

```bash
node demo/mock-upstream.mjs &
MOCK_API_KEY=demo CONFIG_PATH=demo/config.demo.yaml npm start

curl -N http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo/truncated-stream","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

```
data: {"id":"mock",...,"delta":{"content":"Par"}}

data: {"id":"mock",...,"delta":{"content":"tial"}}

```

**The subtlety worth pointing out in a demo:** curl exits `0` and the status was
`200`, because headers were sent before the upstream died. Nothing in the HTTP
layer reports a problem. The *only* client-visible signal is the missing
`data: [DONE]` — which is exactly why that sentinel matters:

```bash
curl -sN http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo/truncated-stream","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  | grep -q '\[DONE\]' && echo "complete" || echo "TRUNCATED"
```

On the server side it is not silent: the router logs that request at
`level: "error"` with `truncated: true`, despite the 200.

#### When curl is not enough

Only for the automated assertions. `demo/verify-streaming.mjs` exists because a
script can *assert* on chunk timings and fail CI; curl shows you the same
evidence but cannot decide whether it passed. Use curl to demo and explore, the
verifier to gate.

### Verifying streaming actually streams (extension A)

Printing SSE frames does **not** prove real-time delivery: a proxy that buffered
the entire response would emit byte-identical output. The only difference is
*when* bytes arrive, so timing is the proof.

```bash
node demo/verify-streaming.mjs
```

It timestamps every chunk as it arrives and prints an arrival histogram:

```
   15 chunks over 969ms:
     chunk  1  +  653ms  ████████████████████
     chunk  2  +  658ms  █████████████████████
     chunk  3  +  669ms  █████████████████████
     ...
   → time-to-first-token: 653ms  (the model thinking)
   → streaming phase:     618ms across 60 chunks
```

**Reading this correctly matters.** Time-to-first-token is the model thinking
before it emits anything, and on a live provider it is often most of the wall
clock — it says nothing about buffering. What proves a live relay is that
chunks are spread out *after* the first one lands. A buffering proxy would
deliver every chunk at the same instant, at the very end.

**Graceful mid-stream failure.** Two different failures matter, and only one can
be demonstrated against a real provider:

| Failure | How to test |
|---|---|
| Client hangs up mid-stream | Covered by the live run above |
| Upstream dies mid-stream | Needs `--self` or the mock — a real provider will not fail on command |

```bash
node demo/verify-streaming.mjs --self
```

Self-contained: it spawns its own upstream with deliberate pacing and a
truncating endpoint, so the timing assertions are deterministic. **No API key,
no network, no cost** — this is also what runs in CI. It asserts that a
truncated stream keeps its partial content, omits `[DONE]` so the client can
detect the truncation, leaves the router healthy, and is logged at `error` level
with `truncated: true` despite the HTTP status already being `200`.

To watch a truncation by hand against the mock upstream:

```bash
node demo/mock-upstream.mjs &
MOCK_API_KEY=demo CONFIG_PATH=demo/config.demo.yaml npm start

curl -N http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo/truncated-stream","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Partial content arrives, then the stream simply stops — no `[DONE]`.

### Verifying the fallback chain (extension B)

The trap: **a 200 does not prove the chain fired.** A chain that never engages
also returns 200. The only real evidence is *which upstream received the
request*.

```bash
node demo/verify-fallback.mjs
```

It starts two independent upstreams and asserts each one's request count after
every scenario — so a chain that silently failed to advance is caught:

| Scenario | Asserted |
|---|---|
| Primary healthy | Secondary receives **zero** requests |
| Primary 402 (out of credit) | Client gets 200, secondary served it, each hop got its own model id |
| Primary unreachable | Chain advances, connection error is logged |
| Primary rejects the model id (400) | Chain advances — that failure is target-specific |
| Genuinely malformed request (400) | Chain does **not** advance — no wasted spend |
| Every target fails | Client sees the *last* failure; `chainAttempts` records every hop |
| Fallback served the request | Usage still counted against the alias |

Self-contained, no API key. Against live OpenRouter you generally will *not* see
a failover, because the `:free` tier works — to force one there, use the
dead-port config below.

### How do you know it fell back to the *correct* model?

"It returned 200" is not enough — a chain that never fired returns 200 too, and
a chain that jumped straight to the last target looks the same from outside.
Three independent records answer this, and they should agree.

**1. The mock upstream's own log.** It prints every model id it is asked for,
in arrival order — a record the router does not write:

```bash
node demo/mock-upstream.mjs        # terminal 1, watch this
```
```
[mock] POST /v1/fail-402/chat/completions  model=mock/free-tier-model
   → responding 402 (out of credit — like an exhausted :free tier)
[mock] POST /v1/chat/completions            model=mock/paid-model
   → responding 200 (success)
```

The free tier was tried **first** and the paid model **second**. That ordering
is the mock's testimony, not ours.

**2. The router's `chainAttempts` log.** Every hop, in order, with what each
returned:

```bash
grep chat_completion router.log | tail -1 | python3 -m json.tool
```
```json
{
  "model": "demo/fallback-quota",
  "upstreamModel": "mock/paid-model",
  "failedOver": true,
  "status": 200,
  "chainAttempts": [
    { "upstream": "mock-402", "model": "mock/free-tier-model", "status": 402 },
    { "upstream": "mock",     "model": "mock/paid-model",      "status": 200 }
  ]
}
```

`upstreamModel` is the hop that actually served the request; `chainAttempts`
shows the full walk.

**3. The automated verifier.** `demo/verify-fallback.mjs` runs a **three**-hop
chain and prints the call journal, because two targets cannot prove ordering —
"in sequence" and "in reverse" can both end with the same server answering:

```
   call journal (the actual sequence of upstream calls):
     1. +   1ms  primary    model=vendor/tier-1
     2. +   1ms  secondary  model=vendor/tier-2
     3. +   2ms  tertiary   model=vendor/tier-3
```

It asserts the order is exactly `primary → secondary → tertiary`, that each hop
received **its own** model id rather than the primary's, and that a healthy
primary means the later targets are never called at all.

#### Confirming the tests would actually catch a bug

Passing tests only mean something if they fail when the code is wrong. These
were checked by deliberately breaking the router and confirming the right tests
failed:

| Bug introduced | Tests that caught it |
|---|---|
| Chain walked in reverse order | all 7 ordering tests |
| Kept walking after a success | "stops at first success", "never calls when primary succeeds" |
| Sent the primary's model id to every hop | "each hop gets its own model id" |
| Fired all targets in parallel | "calls sequentially", "healthy primary", + 3 more |

The source was restored afterwards; `git diff src/` is clean.

### Token counting (extension C)

```bash
curl http://localhost:8080/v1/usage
```

Cumulative prompt/completion tokens per alias since process start, sorted by
spend. Generate some traffic first, then:

```bash
curl -s http://localhost:8080/v1/usage | python3 -m json.tool
```
```json
{
  "since": "2026-08-20T16:58:39.186Z",
  "totals": { "requests": 4, "promptTokens": 65, "completionTokens": 25, "totalTokens": 90 },
  "byModel": {
    "router/nemotron3": { "requests": 1, "promptTokens": 21, "completionTokens": 20, "totalTokens": 41 },
    "router/gemma4":    { "requests": 2, "promptTokens": 24, "completionTokens": 3,  "totalTokens": 27 }
  }
}
```

Counted against the **alias**, not the upstream model — with a fallback chain
one alias may be served by several models, and the question is what the alias
cost. Failed requests and responses that report no usage are not counted.

### Fallback chains (extension B)

`config.yaml` ships `router/gemma4` as a chain: the `:free` tier is tried first,
with the paid model as backup.

```yaml
models:
  router/gemma4:
    targets:
      - upstream: openrouter
        model: google/gemma-4-26b-a4b-it:free
      - upstream: openrouter
        model: google/gemma-4-26b-a4b-it
```

Against live OpenRouter the `:free` tier usually works, so **you will not see a
failover unless you force one**. To demo it deterministically, use the mock
upstream (below) — or point a primary at a dead port:

```bash
cat > /tmp/fb.yaml <<'YAML'
upstreams:
  dead:
    base_url: http://127.0.0.1:9099/v1
    api_key_env: OPENROUTER_API_KEY
    max_retries: 0
  openrouter:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    max_retries: 0
models:
  router/gemma4:
    targets:
      - upstream: dead
        model: google/gemma-4-26b-a4b-it:free
      - upstream: openrouter
        model: google/gemma-4-26b-a4b-it
YAML

set -a; . ./.env; set +a
CONFIG_PATH=/tmp/fb.yaml npm start
```

Then a normal request succeeds anyway:

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/gemma4","messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
```

The router log shows the hop:

```json
{"level":"warn","message":"upstream_failover","from":{"upstream":"dead"},"to":{"upstream":"openrouter"},"error":"Upstream \"dead\" is unreachable: fetch failed"}
{"level":"info","message":"chat_completion","upstream":"openrouter","failedOver":true,"status":200,
 "chainAttempts":[{"upstream":"dead","status":null},{"upstream":"openrouter","status":200}]}
```

### The official OpenAI SDK

```bash
npm install --no-save openai
node demo/sdk-demo.mjs
```

Exercises non-streaming, streaming, typed errors, and `models.list()` through
the real SDK with only `baseURL` changed. **This is the strongest compatibility
claim**: if the official client works unmodified, so does anything built on it.

---

## Proving requests reach the correct upstream model

The likeliest question you'll be asked. There are three independent answers,
in increasing order of persuasiveness.

### (a) The router's structured log

Every request logs the alias *and* what it resolved to:

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/nemotron3","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' > /dev/null
```

Terminal 1 shows:

```json
{"timestamp":"2026-08-20T16:18:55.031Z","level":"info","message":"chat_completion",
 "requestId":"req-3","model":"router/nemotron3","upstream":"openrouter",
 "upstreamModel":"nvidia/nemotron-3-nano-30b-a3b","status":200,
 "attempts":1,"latencyMs":296,"upstreamLatencyMs":248,"totalTokens":51}
```

`model` is what the client asked for; `upstreamModel` is where it went.

*Caveat, worth saying out loud:* this is our own log describing our own
behavior. It's the right operational tool, but it isn't independent evidence.

### (b) Ask the model to identify itself

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"router/gemma4","messages":[{"role":"user","content":"Who trained you? Answer in under 8 words."}],"max_tokens":40}'
```

Gemma answers *"I was trained by Google."* Independent of our logging, though
models are unreliable narrators about their own identity.

### (c) Strongest: the raw SSE stream

The router deliberately does **not** rewrite model ids inside streaming chunks.
So the id in a stream comes straight from OpenRouter, untouched by our code:

```bash
for m in router/gemma4 router/nemotron3 router/mistral-small; do
  printf "%-22s -> " "$m"
  curl -sN http://localhost:8080/v1/chat/completions \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true,\"max_tokens\":5}" \
    | grep -o '"model":"[^"]*"' | head -1
done
```

```
router/gemma4          -> "model":"google/gemma-4-26b-a4b-it"
router/nemotron3       -> "model":"nvidia/nemotron-3-nano-30b-a3b"
router/mistral-small   -> "model":"mistralai/mistral-small-2603"
```

Exactly the three mappings the spec required, attested by the provider rather
than by us. The design decision not to rewrite streaming chunks turns out to
double as the verification mechanism.

---

## Where requests and responses are logged

The router writes **one structured JSON line per request** to **stdout** — the
terminal running `npm start`. There is no log file by default; redirect if you
want one.

```bash
npm start > /tmp/router.log 2>&1        # to a file
npm start 2>&1 | tee /tmp/router.log    # to a file AND the screen
```

### Reading them live

```bash
# Pretty-print each line as it arrives
tail -f /tmp/router.log | while read -r l; do echo "$l" | python3 -m json.tool; done

# Just the routing decision and timing (needs jq)
tail -f /tmp/router.log | jq -c 'select(.message=="chat_completion")
  | {model, upstream, upstreamModel, status, attempts, latencyMs}'

# Failures only
grep '"level":"error"' /tmp/router.log
grep '"level":"warn"'  /tmp/router.log
```

### What each field means

| Field | Meaning |
|---|---|
| `timestamp` | ISO-8601, UTC |
| `requestId` | Correlates the log line to one request |
| `model` | The alias the client asked for |
| `upstream` | Which configured upstream served it |
| `upstreamModel` | The provider's model id — **the routing proof** |
| `status` | HTTP status returned to the client |
| `attempts` | 1 normally; >1 means retries happened |
| `latencyMs` | Total time inside the router |
| `upstreamLatencyMs` | Time waiting on the provider |
| `promptTokens` / `completionTokens` / `totalTokens` | Usage, when reported |
| `stream` | Whether it was a streaming request |
| `truncated` | Present when a stream died mid-flight |

`latencyMs − upstreamLatencyMs` is the router's own overhead — typically
**3–47ms warm** (median ~26ms). Early requests after boot run higher due to JIT
and TLS warmup; that's startup cost, not per-request cost.

### Two deliberate omissions

- **API keys are never logged.** Redaction happens in the log serializer, not at
  each call site, so a new call site can't leak one by forgetting.
- **Prompt and response content is never logged.** Only metadata and token
  counts. Sensible default for anything touching user data.

Both are covered by tests, so they can't silently regress.

---

## Simulating errors

Some failures need no setup; upstream failures use a mock provider.

### No setup required

```bash
# Unknown model -> 404, and it lists the valid aliases
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'

# Missing messages -> 400
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"router/gemma4"}'

# Malformed JSON -> 400, still an OpenAI error envelope
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":,,}'

# Wrong type -> 400 naming the offending field
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":123,"messages":[{"role":"user","content":"hi"}]}'

# Unknown endpoint -> 404, OpenAI-shaped rather than a framework default
curl -s http://localhost:8080/v1/embeddings -d '{}'
```

### Simulating UPSTREAM failures (the interesting ones)

Real providers fail on their own schedule, which is useless when demoing. The
mock upstream fails **on command**, so every failure mode is reproducible and
costs no credits.

**Terminal 1 — mock provider:**
```bash
node demo/mock-upstream.mjs
```

**Terminal 2 — router pointed at the mock:**
```bash
MOCK_API_KEY=demo-key CONFIG_PATH=demo/config.demo.yaml npm start
```

**Terminal 3 — trigger each failure:**

```bash
fail() {
  echo "--- $1 ---"
  curl -s -w "\nHTTP %{http_code}\n" http://localhost:8080/v1/chat/completions \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
}

fail demo/healthy            # 200 — baseline
fail demo/error-500          # 500 — upstream 5xx passed through
fail demo/rate-limited       # 429 — preserved so clients can back off
fail demo/bad-credentials    # 401 — upstream auth failure surfaced
fail demo/garbage-response   # 502 — upstream sent 200 + non-JSON
fail demo/unreachable        # 502 — nothing listening
fail demo/timeout            # 504 — after 2s, rather than hanging
```

| Alias | Result | What it demonstrates |
|---|---|---|
| `demo/healthy` | 200 | Baseline |
| `demo/error-500` | 500 | Upstream errors pass through, not masked |
| `demo/rate-limited` | 429 | Rate limits preserved for client backoff |
| `demo/bad-credentials` | 401 | Upstream auth failure surfaced |
| `demo/garbage-response` | 502 | Non-JSON upstream → gateway error |
| `demo/unreachable` | 502 | Connection refused |
| `demo/timeout` | 504 | Bounded wait, not a hung client |

**Fallback chains** (extension B) — the mock makes each case reproducible:

```bash
fail demo/fallback             # 200 — primary unreachable, fallback served it
fail demo/fallback-quota       # 200 — primary out of credit (402), fallback served it
fail demo/fallback-exhausted   # 500 — every target failed; last failure surfaced
fail demo/fallback-badrequest  # 400 — malformed request does NOT walk the chain
```

| Alias | Result | What it demonstrates |
|---|---|---|
| `demo/fallback` | 200 | Unreachable primary → transparent failover |
| `demo/fallback-quota` | 200 | 402 out-of-credit → the spec's motivating case |
| `demo/fallback-exhausted` | 500 | All targets fail → *last* failure returned |
| `demo/fallback-badrequest` | 400 | 400 is fatal — the next provider would reject it too |

The mock's own terminal shows exactly which targets were hit, and the router
logs an `upstream_failover` warning naming both endpoints.

**Retry with backoff** — the mock fails twice, then succeeds:

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo/flaky","messages":[{"role":"user","content":"hi"}]}'
```

Returns **200**. The router log shows `"attempts": 3`, and the mock's own
terminal shows it being hit three times — the client never saw the failures.

**Truncated stream** — upstream dies mid-response:

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo/truncated-stream","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Partial content arrives with **no `[DONE]`**, which is how a client detects
truncation. The router logs it at `level:"error"` with `truncated:true` — worth
pointing out, because the HTTP status was already `200` before the failure, so
naive status-based logging would file this as a success. (It did, until testing
caught it.)

### Router authentication

Off by default. Enable it:

```bash
ROUTER_API_KEY=sk-demo-secret npm start
```

```bash
curl -s -o /dev/null -w "no key:      %{http_code}\n" http://localhost:8080/v1/models
curl -s -o /dev/null -w "wrong key:   %{http_code}\n" http://localhost:8080/v1/models -H 'authorization: Bearer wrong'
curl -s -o /dev/null -w "correct key: %{http_code}\n" http://localhost:8080/v1/models -H 'authorization: Bearer sk-demo-secret'
curl -s -o /dev/null -w "/health:     %{http_code}\n" http://localhost:8080/health
```
```
no key:      401
wrong key:   401
correct key: 200
/health:     200   <- liveness stays open so orchestrators can probe it
```

---

## Suggested demo narrative (~10 minutes)

1. **Frame it** (30s) — "One stable API, many providers. Clients point here instead of at OpenAI."
2. **Health + models** (30s) — it's running; here's what it exposes.
3. **A completion** (1m) — ordinary OpenAI request. Note the response says `router/gemma4`, not the provider's id.
4. **Three models, one API** (1m) — only the `model` field changes.
5. **Prove the routing** (2m) — the log line, then the SSE stream carrying the provider's own model id. *This is the section that answers "how do you know it works?"*
6. **Streaming** (1m) — `-N`, tokens arriving live.
7. **The SDK** (1m) — `node demo/sdk-demo.mjs`. Official client, only `baseURL` changed, typed `NotFoundError`.
8. **Token counting** (1m) — `GET /v1/usage`, per-alias totals. Note it counts the alias, not the upstream model.
9. **Errors** (2m) — unknown model 404 that lists valid aliases; then the mock upstream for 500/429/timeout/retry.
10. **Fallback chains** (2m) — the four mock scenarios. The 400 case is the interesting one: it deliberately does *not* fail over.
11. **Observability** (1m) — the log terminal, and what you'd alert on. Mention keys and prompts are never logged.

**If you have less time:** sections 3, 5, and 9 carry the most weight — it works, here's proof it routes correctly, here's how it fails. Add 10 if fallback chains are of interest.

**Good things to volunteer:**
- Adding a provider is config-only, no code change (show `config.yaml`).
- Validation is deliberately permissive so new provider params don't break the proxy.
- Streaming chunks aren't rewritten — a deliberate hot-path trade that doubles as the routing proof.
- The truncated-stream log level was a real bug found by testing, not by the test suite passing.
- So was the fallback 400 rule: OpenRouter reports an unknown model id as a 400, so a blanket "400 never fails over" rule silently defeated the chain. Now a 400 that rejects the *model id* does fail over, since each hop sends a different id.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Configuration error: Missing required environment variables` | Key not exported. Run `set -a; . ./.env; set +a` in *that* shell. |
| `EADDRINUSE: 8080` | Already running. `lsof -ti:8080 \| xargs kill -9`, or `PORT=8081 npm start`. |
| All requests → 401 | `ROUTER_API_KEY` is set in that shell. Unset it, or send `Authorization: Bearer <key>`. |
| All requests → 502 | Upstream unreachable — check network, or the mock isn't running. |
| Streaming looks buffered | Add `-N` to curl. |
| `demo/*` aliases → 404 | Router isn't using the demo config. Restart with `CONFIG_PATH=demo/config.demo.yaml`. |
| Fallback never triggers on live OpenRouter | Expected — the `:free` tier is working. Force one with the dead-port config above, or use the mock. |
| `/v1/usage` shows zeroes | Counters are in-process and reset on restart; they only count responses that reported usage. |
| Demo says "Demo config not loaded" | Same as above — expected when running against live OpenRouter. |
