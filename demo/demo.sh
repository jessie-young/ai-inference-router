#!/usr/bin/env bash
#
# Guided walkthrough of the AI Inference Router.
#
#   ./demo/demo.sh          # full demo, pauses between sections
#   ./demo/demo.sh --fast   # no pauses
#   ./demo/demo.sh live     # only the live-OpenRouter sections
#   ./demo/demo.sh errors   # only the error-handling sections (no credits used)
#
# Requires: the router running on :8080. See demo/README.md.

set -uo pipefail
BASE="${ROUTER_URL:-http://127.0.0.1:8080}"
FAST=0; SECTION="all"
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    live|errors|all) SECTION="$arg" ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
CYAN=$'\033[36m'; RED=$'\033[31m'; RESET=$'\033[0m'

hdr()  { echo; echo "${BOLD}${CYAN}━━━ $* ━━━${RESET}"; echo; }
note() { echo "${DIM}$*${RESET}"; }
cmd()  { echo "${YELLOW}\$ $*${RESET}"; }
pause() { [ "$FAST" = 1 ] || { echo; read -rp "${DIM}[Enter to continue]${RESET}" _; }; }

# Pretty-print JSON, falling back to raw text.
pp() { python3 -m json.tool 2>/dev/null || cat; }

# Show only the interesting fields of a completion response.
summarize() {
  python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception:
    print('  (non-JSON response)'); sys.exit()
if 'error' in d:
    e = d['error']
    print(f\"  error.message : {e.get('message','')[:100]}\")
    print(f\"  error.type    : {e.get('type')}\")
    print(f\"  error.code    : {e.get('code')}\")
    sys.exit()
ch = (d.get('choices') or [{}])[0]
msg = ch.get('message', {})
content = msg.get('content') or msg.get('reasoning') or ''
print(f\"  id            : {d.get('id')}\")
print(f\"  model         : {d.get('model')}   <- the ALIAS you asked for\")
print(f\"  provider      : {d.get('provider','n/a')}\")
print(f\"  finish_reason : {ch.get('finish_reason')}\")
print(f\"  usage         : {json.dumps(d.get('usage', {}))[:80]}\")
print(f\"  content       : {content.strip()[:120]}\")
"
}

if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "${RED}Router is not responding at $BASE${RESET}"
  echo "Start it first:  set -a; . ./.env; set +a; npm start"
  exit 1
fi

echo "${BOLD}AI Inference Router — demo${RESET}"
echo "${DIM}Target: $BASE${RESET}"

########################################################################
if [ "$SECTION" = "all" ] || [ "$SECTION" = "live" ]; then
########################################################################

hdr "1. The router is up"
note "A liveness check that never requires auth."
cmd "curl $BASE/health"
curl -s "$BASE/health" | pp
pause

hdr "2. Discovering models (OpenAI-compatible)"
note "Clients call this to populate a model picker. It lists our ALIASES,"
note "not the provider's model names."
cmd "curl $BASE/v1/models"
curl -s "$BASE/v1/models" | pp
pause

hdr "3. A basic chat completion (non-streaming)"
note "Standard OpenAI Chat Completions request with stream:false — the mode"
note "the core requirement targets. One JSON response, no SSE."
cmd "curl $BASE/v1/chat/completions -d '{\"model\":\"router/gemma4\",...,\"stream\":false}'"
curl -s "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"router/gemma4","messages":[{"role":"user","content":"Say hello in exactly 5 words."}],"stream":false,"max_tokens":40}' \
  | summarize
echo
note "Note 'model' came back as the alias router/gemma4 — not the upstream id."
note "Clients stay decoupled from whichever backend we route to."
pause

hdr "4. Same API, three different models (non-streaming)"
note "Only the model field changes. This is the whole point of the router."
for m in router/gemma4 router/nemotron3 router/mistral-small; do
  echo "${BOLD}$m${RESET}"
  curl -s "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"stream\":false,\"max_tokens\":30}" \
    | summarize
  echo
done
pause

hdr "5. PROOF: requests reach the correct upstream model"
note "Three independent lines of evidence, strongest last."
echo
echo "${BOLD}(a) The router's own structured log${RESET}"
note "Shows the alias and the upstream model it resolved to:"
cmd "tail -1 router.log"
curl -s -o /dev/null "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"router/nemotron3","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
if [ -f "${ROUTER_LOG:-/tmp/router.log}" ]; then
  tail -1 "${ROUTER_LOG:-/tmp/router.log}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k in ('model','upstream','upstreamModel','status','latencyMs'):
    print(f'  {k:<14}: {d.get(k)}')
" 2>/dev/null || note "  (set ROUTER_LOG=/path/to/log to show this)"
else
  note "  (set ROUTER_LOG=/path/to/router.log to display the log line here)"
fi
echo
echo "${BOLD}(b) The models identify themselves — non-streaming${RESET}"
note "Independent of our logs, and needs no streaming: each model reports a"
note "different creator, and only Nemotron emits a 'reasoning' field."
for m in router/gemma4 router/nemotron3 router/mistral-small; do
  printf "  %-22s → " "$m"
  curl -s "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Complete: 'I am a language model created by' — answer with ONLY the organization name.\"}],\"max_tokens\":30}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
msg = d['choices'][0]['message']
text = (msg.get('content') or msg.get('reasoning') or '').strip().replace(chr(10), ' ')
tag = '  \033[2m[+reasoning field]\033[0m' if msg.get('reasoning') else ''
print(f'\033[32m{text[:34]:<34}\033[0m{tag}')
"
done
echo
note "Gemma reports Google, Mistral reports Mistral AI, and Nemotron's distinct"
note "response structure is itself a fingerprint. Three aliases, three backends."
echo
echo "${BOLD}(c) Strongest: the raw SSE stream from OpenRouter${RESET}"
note "${DIM}(This one uses streaming — an extension beyond the required scope.)${RESET}"
note "We deliberately do NOT rewrite streaming chunks, so the model id inside"
note "them comes straight from the provider — unfiltered by our code."
for m in router/gemma4 router/nemotron3 router/mistral-small; do
  printf "  %-22s → " "$m"
  curl -sN "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true,\"max_tokens\":5}" \
    | grep -o '"model":"[^"]*"' | head -1 | sed "s/.*/${GREEN}&${RESET}/"
done
echo
note "Each alias resolved to exactly the upstream model the spec required."
pause

hdr "6. Non-streaming is the default"
note "Every way of saying \"not streaming\" returns one JSON body, never SSE."
for variant in '(omitted)::' 'false::,"stream":false' 'null::,"stream":null'; do
  label="${variant%%::*}"; frag="${variant##*::}"
  printf "  stream %-10s → " "$label"
  curl -s -o /tmp/_ns.json -w "HTTP %{http_code}  " "$BASE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"router/gemma4\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5$frag}"
  python3 -c "
import json
try: print('object=' + json.load(open('/tmp/_ns.json')).get('object', '?'))
except Exception: print('(non-JSON)')
"
done
rm -f /tmp/_ns.json
echo
note "OpenAI's spec declares stream as nullable with a false default, so an"
note "explicit null is accepted too — some clients serialize unset fields that"
note "way. Only an explicit true switches to SSE."
pause

hdr "7. Streaming (extension, beyond the required scope)"
note "stream:true returns Server-Sent Events, forwarded as they arrive."
cmd "curl -N $BASE/v1/chat/completions -d '{...,\"stream\":true}'"
curl -sN "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"router/mistral-small","messages":[{"role":"user","content":"Count from 1 to 5."}],"stream":true,"max_tokens":60}' \
  | head -6
echo "  ${DIM}...${RESET}"
echo
note "Tokens arrive incrementally, ending with 'data: [DONE]'."
pause

hdr "8. Works with the official OpenAI SDK"
note "The real compatibility test: only baseURL changes."
if [ -d node_modules/openai ]; then
  node demo/sdk-demo.mjs
else
  note "(skipped — run 'npm install --no-save openai' to enable)"
  echo "${DIM}  See demo/sdk-demo.mjs${RESET}"
fi
pause

fi

########################################################################
if [ "$SECTION" = "all" ] || [ "$SECTION" = "errors" ]; then
########################################################################

hdr "9. Error handling: unknown model"
note "The router never forwards a request it cannot route."
cmd "curl $BASE/v1/chat/completions -d '{\"model\":\"gpt-4\",...}'"
curl -s -w "\n${DIM}HTTP %{http_code}${RESET}\n" "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}' | pp
echo
note "404, OpenAI error envelope, and it lists the valid aliases so the"
note "caller can fix it without reading docs."
pause

hdr "10. Error handling: malformed requests"
for label in "missing messages:{\"model\":\"router/gemma4\"}" \
             "empty messages:{\"model\":\"router/gemma4\",\"messages\":[]}" \
             "wrong type:{\"model\":123,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
             "malformed JSON:{\"model\":,,}"; do
  name="${label%%:*}"; payload="${label#*:}"
  printf "%-18s → " "$name"
  curl -s -w " ${DIM}[HTTP %{http_code}]${RESET}" "$BASE/v1/chat/completions" \
    -H 'content-type: application/json' -d "$payload" \
    | python3 -c "
import sys,json
raw=sys.stdin.read()
body=raw.split(' [HTTP')[0]
try:
    e=json.loads(body).get('error',{})
    print(f\"{e.get('message','')[:52]:<54}\", end='')
except Exception: print(raw[:54], end='')
"
  echo
done
echo
note "Every failure uses the OpenAI error shape, so SDK error handling works."
pause

hdr "11. Simulating UPSTREAM failures"
note "Real providers fail on their own schedule. To demo this deterministically"
note "we point the router at a mock upstream that fails on command."
echo
note "In a second terminal:"
cmd "node demo/mock-upstream.mjs"
note "Then restart the router against the demo config:"
cmd "MOCK_API_KEY=demo CONFIG_PATH=demo/config.demo.yaml npm start"
echo
if curl -sf "$BASE/v1/models" 2>/dev/null | grep -q "demo/healthy"; then
  echo "${GREEN}Demo config detected — running the failure scenarios:${RESET}"
  echo
  printf "%-26s %-7s %s\n" "ALIAS" "STATUS" "WHAT IT PROVES"
  printf "%-26s %-7s %s\n" "──────────────────────────" "──────" "──────────────"
  for pair in "demo/healthy:baseline success" \
              "demo/error-500:upstream 5xx passed through" \
              "demo/rate-limited:429 preserved for client backoff" \
              "demo/bad-credentials:upstream auth error surfaced" \
              "demo/garbage-response:non-JSON upstream → 502" \
              "demo/unreachable:connection refused → 502"; do
    m="${pair%%:*}"; why="${pair#*:}"
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/chat/completions" \
      -H 'content-type: application/json' \
      -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
    printf "%-26s %-7s %s\n" "$m" "$code" "$why"
  done
  echo
  echo "${BOLD}Timeout (upstream hangs; router gives up at 2s):${RESET}"
  s=$(date +%s)
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d '{"model":"demo/timeout","messages":[{"role":"user","content":"hi"}]}')
  echo "  HTTP $code after $(( $(date +%s) - s ))s  ${DIM}(504, not a hung client)${RESET}"
  echo
  echo "${BOLD}Retry (upstream fails twice, then succeeds):${RESET}"
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d '{"model":"demo/flaky","messages":[{"role":"user","content":"hi"}]}')
  echo "  HTTP $code  ${DIM}— check the router log for \"attempts\": 3${RESET}"
  echo "  ${DIM}The mock upstream's own output shows it was hit 3 times.${RESET}"
  echo
  echo "${BOLD}Truncated stream (upstream dies mid-response):${RESET}"
  out=$(curl -sN "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d '{"model":"demo/truncated-stream","messages":[{"role":"user","content":"hi"}],"stream":true}' 2>&1)
  echo "  client received: $(echo "$out" | grep -o '"content":"[^"]*"' | tr '\n' ' ')"
  echo "  [DONE] sentinel: $(echo "$out" | grep -q '\[DONE\]' && echo 'yes' || echo "${RED}absent — client can detect truncation${RESET}")"
  echo "  ${DIM}Router logs this at level=error with truncated=true, even though${RESET}"
  echo "  ${DIM}the HTTP status was already 200.${RESET}"
else
  note "${YELLOW}Demo config not loaded — skipping live failure simulation.${RESET}"
  note "Start the mock upstream and restart the router as shown above."
fi
pause

hdr "12. Observability"
note "One structured JSON line per request. Point ROUTER_LOG at your log file"
note "to see them here; otherwise watch the terminal running the router."
echo
note "Every line carries: timestamp, requestId, alias, upstream, upstreamModel,"
note "status, attempts, latencyMs, upstreamLatencyMs, and token usage."
echo
note "Useful one-liners:"
cmd "tail -f router.log | python3 -m json.tool"
cmd "grep chat_completion router.log | jq '{model, upstream, status, latencyMs}'"
cmd "grep '\"level\":\"error\"' router.log     # failures only"
echo
note "Two deliberate properties, both covered by tests:"
note "  • API keys never appear in logs (redacted in the serializer)"
note "  • Prompt/response content is never logged (privacy by default)"

fi

echo
echo "${BOLD}${GREEN}Demo complete.${RESET}"
