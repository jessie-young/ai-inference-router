# AI Inference Router — Design

**Date:** 2026-08-20
**Status:** Approved for implementation

## Goal

A lightweight HTTP service that exposes an OpenAI-compatible Chat Completions API
and forwards requests to configurable upstream LLM providers. Any client that
speaks the OpenAI protocol — the official SDK, curl, LangChain — points at the
router instead of the provider and works unchanged.

## Non-goals

Not a load balancer, not a cache, not a billing/quota system. No persistence.
No per-user auth beyond an optional shared router key. These are all reasonable
next steps, but they are out of scope for a focused routing layer.

## Architecture

Four modules, each with one job and a clean seam for testing:

```
client → server/ (HTTP, validation)
           ↓
         router/ (alias → upstream resolution)
           ↓
         upstream/ (fetch, retry, translate errors)
           ↓
       OpenRouter / OpenAI / vLLM
           ↕
       config/ (load + validate at boot)
       observability/ (structured logs)
```

- **config/** parses and validates a YAML file at startup with zod. API keys are
  never inlined — each upstream names an env var (`api_key_env`) that must
  resolve at boot. Invalid config fails fast with a readable error rather than
  surfacing as a 500 on the first request.
- **router/** owns exactly one decision: given a `model` string, which upstream
  and which upstream model id. A pure function over the loaded config, so it is
  trivially unit-testable with no network.
- **upstream/** performs the HTTP call. Rewrites the `model` field to the
  upstream id, strips hop-by-hop headers, applies timeout + bounded retry, and
  normalizes any failure into an OpenAI-shaped error body.
- **server/** is Fastify: schema validation, route handlers, error mapping.

## Data flow

1. `POST /v1/chat/completions` arrives. Body is validated as an OpenAI Chat
   Completions request — permissively: we validate the fields we route on
   (`model`, `messages`, `stream`) and pass everything else through untouched,
   so provider-specific params keep working as providers add them.
2. Router resolves `model` → `{upstream, upstreamModel}`. Unknown alias → 404.
3. Upstream client rewrites `model`, injects `Authorization`, and POSTs.
4. Non-streaming: the JSON body is returned as-is (it is already in OpenAI
   format). We rewrite the response's `model` field back to the requested alias
   so clients see a stable, router-owned name.
5. Streaming: the SSE byte stream is piped through unmodified. Chunk rewriting
   would mean parsing and re-serializing every frame for cosmetic benefit and
   would add a failure mode in the hot path; not worth it.

## Error handling

Every error path returns the OpenAI error envelope
`{"error": {"message", "type", "code", "param"}}`, so SDK error handling works.

| Condition | Status | `type` |
|---|---|---|
| Malformed body / missing `messages` | 400 | `invalid_request_error` |
| Unknown model alias | 404 | `invalid_request_error` (lists valid aliases) |
| Router key missing/wrong (if enabled) | 401 | `authentication_error` |
| Upstream returned an error | upstream's status | passthrough of upstream body |
| Upstream unreachable / DNS / connect | 502 | `upstream_error` |
| Upstream timeout | 504 | `upstream_error` |

Retries: transient failures only — network errors, 408, 429, 5xx — with
exponential backoff and jitter, capped by config. A 4xx that is not 408/429 is a
client mistake and is never retried. Streaming requests are not retried once the
first byte has been written, because the client has already seen partial output.

## Observability

One structured JSON log line per request: timestamp, request id, method, path,
requested alias, resolved upstream + model, upstream status, attempt count,
total latency, upstream latency, and token usage when the response reports it.
API keys are never logged; the `Authorization` header is redacted at the
serializer level rather than at each call site, so a new call site cannot leak.

## Extensions implemented

- **Streaming** (`stream: true`) via SSE passthrough.
- **Bounded retry with backoff** on transient upstream failures.
- **`GET /v1/models`** listing configured aliases in OpenAI format, and
  **`GET /health`** for liveness.
- **Optional router-level auth** (`ROUTER_API_KEY`) so the proxy is not an open
  relay for your provider credits when exposed beyond localhost.

## Testing

- Unit: config validation (good/bad files), alias resolution, error mapping,
  retry predicate.
- Integration: the router under test against a stub upstream HTTP server —
  happy path, unknown alias, upstream 500, upstream timeout, streaming.
- No test hits OpenRouter. The suite runs offline in CI with no API key.
