#!/usr/bin/env bash
#
# One command for the whole upstream-failure demo.
#
# Starts the mock provider AND a router pointed at it, runs every failure
# scenario, and shows all three views side by side: what the client saw, what
# the mock received, and what the router logged. Cleans up on exit.
#
#   ./demo/run-mock-demo.sh
#
# Needs no API key and makes no external calls.

set -uo pipefail
cd "$(dirname "$0")/.."

MOCK_PORT="${MOCK_PORT:-9090}"
ROUTER_PORT="${ROUTER_PORT:-8080}"
MOCK_LOG=$(mktemp)
ROUTER_LOG=$(mktemp)

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'
CYAN=$'\033[36m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  [ -n "${ROUTER_PID:-}" ] && kill "$ROUTER_PID" 2>/dev/null
  rm -f "$MOCK_LOG" "$ROUTER_LOG"
}
trap cleanup EXIT INT TERM

# A portable sub-second sleep: `sleep 0.2` is not universal, and macOS has no
# `date +%N` either.
naptime() { perl -e "select(undef,undef,undef,$1)"; }

if [ ! -d dist ]; then
  echo "${YELLOW}Building first…${RESET}"
  npm run build >/dev/null 2>&1 || { echo "${RED}Build failed. Run 'npm install && npm run build'.${RESET}"; exit 1; }
fi

for port in "$MOCK_PORT" "$ROUTER_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "${RED}Port $port is already in use.${RESET}"
    echo "Free it with:  lsof -ti:$port | xargs kill -9"
    exit 1
  fi
done

echo "${BOLD}Upstream failure demo${RESET}"
echo "${DIM}Starting a mock provider and a router pointed at it. No API key used.${RESET}"
echo

node demo/mock-upstream.mjs "$MOCK_PORT" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
naptime 0.6
echo "  ${GREEN}✓${RESET} mock provider on :$MOCK_PORT   ${DIM}(pid $MOCK_PID)${RESET}"

MOCK_API_KEY=demo-key CONFIG_PATH=demo/config.demo.yaml PORT="$ROUTER_PORT" \
  node dist/index.js > "$ROUTER_LOG" 2>&1 &
ROUTER_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$ROUTER_PORT/health" >/dev/null 2>&1 && break
  naptime 0.25
done
if ! curl -sf "http://127.0.0.1:$ROUTER_PORT/health" >/dev/null 2>&1; then
  echo "  ${RED}✗ router failed to start${RESET}"; sed 's/^/    /' "$ROUTER_LOG"; exit 1
fi
echo "  ${GREEN}✓${RESET} router on :$ROUTER_PORT        ${DIM}(pid $ROUTER_PID)${RESET}"
echo

BASE="http://127.0.0.1:$ROUTER_PORT"

# scenario <alias> <expected-status> <what it demonstrates>
scenario() {
  local alias="$1" want="$2" why="$3"
  local before after code body

  before=$(grep -c "model=" "$MOCK_LOG" 2>/dev/null | head -1)
  before=${before:-0}

  code=$(curl -s -o /tmp/_demo_body.json -w '%{http_code}' --max-time 20 \
    "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"$alias\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
  naptime 0.25

  local mark="${GREEN}✓${RESET}"
  [ "$code" = "$want" ] || mark="${RED}✗ expected $want${RESET}"

  echo "${BOLD}${CYAN}$alias${RESET}  ${DIM}— $why${RESET}"
  echo "  client saw:   HTTP $code  $mark"

  body=$(head -c 110 /tmp/_demo_body.json)
  echo "  ${DIM}response:     $body${RESET}"

  after=$(grep -c "model=" "$MOCK_LOG" 2>/dev/null | head -1)
  after=${after:-0}
  local hits=$((after - before))
  if [ "$hits" -gt 0 ]; then
    echo "  mock received: ${DIM}$hits call(s)${RESET}"
    grep "model=" "$MOCK_LOG" | tail -n "$hits" \
      | sed "s|.*POST /v1|    →  /v1|" | sed "s/^/  /"
  else
    echo "  mock received: ${DIM}0 calls${RESET} ${DIM}(this alias points somewhere else)${RESET}"
  fi

  # The router's own record of the walk.
  tail -20 "$ROUTER_LOG" | grep '"chat_completion"' | tail -1 | python3 -c "
import sys, json
line = sys.stdin.read().strip()
if not line: raise SystemExit
d = json.loads(line)
served = d.get('upstreamModel')
print(f\"  router log:   served_by={served}  failedOver={d.get('failedOver', False)}\")
for h in d.get('chainAttempts', []):
    outcome = h.get('status') or (h.get('error','')[:38])
    print(f\"                  hop: {h['model']:<24} -> {outcome}\")
" 2>/dev/null
  echo
}

echo "${BOLD}━━━ Single-upstream failures ━━━${RESET}"
echo
scenario demo/healthy          200 "baseline: everything works"
scenario demo/error-500        500 "upstream 5xx passed through, not masked"
scenario demo/rate-limited     429 "429 preserved so clients can back off"
scenario demo/bad-credentials  401 "upstream auth failure surfaced"
scenario demo/garbage-response 502 "upstream sent 200 + non-JSON"
scenario demo/unreachable      502 "nothing listening on that port"
scenario demo/timeout          504 "upstream hangs; router gives up at 2s"

echo "${BOLD}━━━ Retry (same target, tried again) ━━━${RESET}"
echo
scenario demo/flaky            200 "fails twice then succeeds; client sees only success"
echo "  ${DIM}Note the mock was called 3 times for ONE client request.${RESET}"
echo

echo "${BOLD}━━━ Fallback chains (different target) ━━━${RESET}"
echo
scenario demo/fallback         200 "primary unreachable, fallback served it"
scenario demo/fallback-quota   200 "primary out of credit (402) — the :free-tier case"
scenario demo/fallback-exhausted 500 "every target failed; the LAST failure is returned"
scenario demo/fallback-badrequest 400 "malformed request must NOT walk the chain"
echo "  ${DIM}The mock shows only ONE call above: a 400 is the request's fault,${RESET}"
echo "  ${DIM}so trying another provider would just waste money.${RESET}"
echo

echo "${BOLD}━━━ Streaming truncation ━━━${RESET}"
echo
echo "${BOLD}${CYAN}demo/truncated-stream${RESET}  ${DIM}— upstream dies mid-stream${RESET}"
OUT=$(curl -sN --max-time 20 "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"demo/truncated-stream","messages":[{"role":"user","content":"hi"}],"stream":true}' 2>&1)
echo "  client received: $(echo "$OUT" | grep -o '"content":"[^"]*"' | tr '\n' ' ')"
if echo "$OUT" | grep -q '\[DONE\]'; then
  echo "  ${RED}[DONE] present — truncation would be undetectable${RESET}"
else
  echo "  ${GREEN}✓${RESET} no [DONE] sentinel — that is how a client detects truncation"
fi
naptime 0.4
tail -5 "$ROUTER_LOG" | grep '"chat_completion"' | tail -1 | python3 -c "
import sys, json
line = sys.stdin.read().strip()
if line:
    d = json.loads(line)
    print(f\"  router log:   level={d['level']}  truncated={d.get('truncated')}  status={d.get('status')}\")
    print('  \033[2mLogged as an error even though the status was already 200.\033[0m')
" 2>/dev/null
echo

echo "${BOLD}━━━ Token usage across all of the above ━━━${RESET}"
echo
curl -s "$BASE/v1/usage" -o /tmp/_demo_usage.json
python3 - /tmp/_demo_usage.json <<'PYUSAGE'
import sys, json
d = json.load(open(sys.argv[1]))
t = d['totals']
print(f"  {t['requests']} counted requests, {t['totalTokens']} total tokens")
print()
if d['byModel']:
    print(f"  {'ALIAS':<28} {'REQS':>5} {'PROMPT':>8} {'COMPL':>8} {'TOTAL':>8}")
    print("  " + "-" * 61)
    for alias, u in d['byModel'].items():
        print(f"  {alias:<28} {u['requests']:>5} {u['promptTokens']:>8} {u['completionTokens']:>8} {u['totalTokens']:>8}")
print()
print("  Only successful, usage-reporting responses are counted — the failures")
print("  above are absent by design.")
PYUSAGE
rm -f /tmp/_demo_usage.json /tmp/_demo_body.json
echo

echo "${BOLD}${GREEN}Done.${RESET} ${DIM}Mock and router are shut down automatically.${RESET}"
echo
echo "${DIM}To explore by hand, run the two servers in their own terminals:${RESET}"
echo "  ${YELLOW}node demo/mock-upstream.mjs${RESET}"
echo "  ${YELLOW}MOCK_API_KEY=demo CONFIG_PATH=demo/config.demo.yaml npm start${RESET}"
echo "${DIM}then curl any alias above from a third terminal.${RESET}"
