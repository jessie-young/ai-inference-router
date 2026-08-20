import type { Route } from '../router/resolve.js';
import { RouterError } from '../router/errors.js';
import { forward, type UpstreamResult, type ForwardOptions } from './client.js';

/**
 * Walking a model's fallback chain.
 *
 * Retry (in client.ts) and fallback (here) solve different problems and are
 * deliberately separate layers. Retry re-attempts the *same* target for a
 * blip — a 503 that will probably succeed a moment later. Fallback gives up on
 * a target entirely and moves to the *next* one, for a failure that retrying
 * will not fix: the model is out of quota, the provider is down, credentials
 * are rejected. Each target exhausts its own retries before the chain advances.
 */

/** What happened at one hop, for logging and for building the final error. */
export interface AttemptRecord {
  upstream: string;
  upstreamModel: string;
  position: number;
  status: number | null;
  attempts: number;
  latencyMs: number;
  error?: string;
}

export interface ChainResult {
  result: UpstreamResult;
  /** The hop that actually succeeded. */
  route: Route;
  /** Every hop tried, in order, including the successful one. */
  history: AttemptRecord[];
}

/**
 * Statuses worth failing over for.
 *
 * A 400 normally means the request itself is malformed — the next provider
 * would reject it the same way, so failing over just multiplies latency and
 * cost for a guaranteed failure. Auth, quota, capacity, and availability
 * problems are specific to one target and are exactly what a chain exists for.
 */
const FAILOVER_STATUSES = new Set([
  401, // upstream credentials rejected
  402, // out of credit — common on :free tiers
  403, // access to that model denied
  404, // upstream does not have this model
  408, // upstream timed out internally
  429, // rate limited or quota exhausted
  500, 502, 503, 504, // provider-side failure
]);

/**
 * Does a 400 body indicate the *model id* was rejected, rather than the
 * request being malformed?
 *
 * Each hop in a chain sends a different model id, so "unknown model" is
 * target-specific even though the provider reports it as a 400 — the next hop
 * may well succeed. OpenRouter returns exactly this for an id it does not
 * recognise ("... is not a valid model ID"), so treating every 400 as fatal
 * would silently defeat the chain. The match is deliberately narrow: it looks
 * for model-identity wording, not any 400 mentioning the word "model".
 */
export function isModelRejection(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const error = (body as Record<string, unknown>)['error'];
  const message =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['message']
      : undefined;
  if (typeof message !== 'string') return false;

  return (
    /\bnot a valid model\b/i.test(message) ||
    /\b(unknown|invalid|unsupported|unrecognized) model\b/i.test(message) ||
    /\bmodel .* (does not exist|not found|is not available)\b/i.test(message)
  );
}

export function shouldFailover(status: number, body?: unknown): boolean {
  if (FAILOVER_STATUSES.has(status)) return true;
  // A 400 is fatal unless the provider is telling us this specific model id
  // is the problem, in which case a different id downstream may work.
  if (status === 400 && isModelRejection(body)) return true;
  return false;
}

/** Router-level errors that mean "this target is unusable", not "bad request". */
function isFailoverError(err: unknown): boolean {
  if (!(err instanceof RouterError)) return false;
  return err.code === 'upstream_unreachable' || err.code === 'upstream_timeout';
}

export interface ForwardWithFallbackOptions
  extends Omit<ForwardOptions, 'route'> {
  /** The alias's ordered targets, from resolveChain(). */
  chain: Route[];
  /** Called before each hop after the first, for logging. */
  onFailover?: (record: AttemptRecord, next: Route) => void;
}

/**
 * Try each target in order until one succeeds.
 *
 * Returns the first success. If every target fails, the *last* failure is
 * surfaced to the client — by then the chain is exhausted, and the final
 * attempt is the most recent evidence of why.
 */
export async function forwardWithFallback(
  options: ForwardWithFallbackOptions,
): Promise<ChainResult> {
  const { chain, onFailover, ...forwardOptions } = options;
  const history: AttemptRecord[] = [];

  let lastError: unknown;
  let lastResult: UpstreamResult | undefined;
  let lastRoute: Route | undefined;

  for (const route of chain) {
    const isLast = route.position === chain.length - 1;
    let record: AttemptRecord;

    try {
      const result = await forward({ ...forwardOptions, route });
      record = {
        upstream: route.upstream.name,
        upstreamModel: route.upstreamModel,
        position: route.position,
        status: result.status,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
      };
      history.push(record);

      // A success, or a failure not worth failing over for, ends the walk.
      if (result.status < 400 || !shouldFailover(result.status, result.body) || isLast) {
        return { result, route, history };
      }

      lastResult = result;
      lastRoute = route;
      lastError = undefined;
    } catch (err) {
      // A malformed request or an unknown model is not the target's fault;
      // surface it immediately rather than replaying it down the chain.
      if (!isFailoverError(err)) throw err;

      record = {
        upstream: route.upstream.name,
        upstreamModel: route.upstreamModel,
        position: route.position,
        status: null,
        attempts: 1,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
      history.push(record);

      if (isLast) throw err;

      lastError = err;
      lastResult = undefined;
      lastRoute = route;
    }

    const next = chain[route.position + 1];
    if (next && onFailover) onFailover(record, next);
  }

  // Unreachable: the loop returns or throws on its final iteration. Kept so a
  // future edit to the loop cannot silently fall through to undefined.
  if (lastError) throw lastError;
  if (lastResult && lastRoute) return { result: lastResult, route: lastRoute, history };
  throw new RouterError(
    500,
    'Fallback chain completed without producing a result.',
    'internal_error',
    'empty_chain',
  );
}
