import type { ResolvedConfig, ResolvedUpstream } from '../config/schema.js';
import { RouterError } from './errors.js';

/** One resolved hop: where to send the request, and as what model. */
export interface Route {
  /** The alias the client asked for, e.g. router/gemma4. */
  alias: string;
  /** The upstream that will serve it, with credentials resolved. */
  upstream: ResolvedUpstream;
  /** The model id the upstream expects, e.g. google/gemma-4-26b-a4b-it. */
  upstreamModel: string;
  /** 0-based position in the fallback chain. 0 is the primary. */
  position: number;
  /** Total hops configured for this alias. 1 means no fallback. */
  chainLength: number;
}

/**
 * Resolve a client-supplied model alias to its ordered chain of targets.
 *
 * This is the router's single routing decision, kept as a pure function over
 * config so it can be unit tested exhaustively without a server or a network.
 * Everything else in the request path is transport.
 *
 * Returns every hop rather than just the first: the caller walks the chain,
 * falling through to the next entry when one fails.
 */
export function resolveChain(config: ResolvedConfig, requestedModel: string): Route[] {
  const route = config.models.get(requestedModel);
  if (!route) {
    throw RouterError.unknownModel(requestedModel, [...config.models.keys()]);
  }

  const chainLength = route.targets.length;

  return route.targets.map((target, position) => {
    const upstream = config.upstreams.get(target.upstream);
    if (!upstream) {
      // Unreachable in practice: loadConfig cross-references these at boot.
      // Kept as a guard so a future config path cannot silently produce a
      // dangling reference that manifests as a confusing runtime crash.
      throw new RouterError(
        500,
        `Model "${requestedModel}" is mapped to upstream "${target.upstream}", which is not configured.`,
        'internal_error',
        'misconfigured_route',
      );
    }
    return {
      alias: requestedModel,
      upstream,
      upstreamModel: target.model,
      position,
      chainLength,
    };
  });
}

/**
 * Resolve just the primary target.
 *
 * Retained for callers that only need to know where a request would go first,
 * such as the model listing.
 */
export function resolveRoute(config: ResolvedConfig, requestedModel: string): Route {
  const chain = resolveChain(config, requestedModel);
  // resolveChain guarantees at least one target: the schema enforces a
  // non-empty targets array, and the single-target form yields exactly one.
  return chain[0]!;
}

/** All configured aliases, for GET /v1/models. */
export function listModels(config: ResolvedConfig): Array<{ alias: string; route: Route }> {
  return [...config.models.keys()].map((alias) => ({
    alias,
    route: resolveRoute(config, alias),
  }));
}
