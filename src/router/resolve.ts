import type { ResolvedConfig, ResolvedUpstream } from '../config/schema.js';
import { RouterError } from './errors.js';

/** The outcome of routing: where to send the request, and as what model. */
export interface Route {
  /** The alias the client asked for, e.g. router/gemma4. */
  alias: string;
  /** The upstream that will serve it, with credentials resolved. */
  upstream: ResolvedUpstream;
  /** The model id the upstream expects, e.g. google/gemma-4-26b-a4b-it. */
  upstreamModel: string;
}

/**
 * Resolve a client-supplied model alias to a concrete upstream target.
 *
 * This is the router's single routing decision, kept as a pure function over
 * config so it can be unit tested exhaustively without a server or a network.
 * Everything else in the request path is transport.
 */
export function resolveRoute(config: ResolvedConfig, requestedModel: string): Route {
  const route = config.models.get(requestedModel);
  if (!route) {
    throw RouterError.unknownModel(requestedModel, [...config.models.keys()]);
  }

  const upstream = config.upstreams.get(route.upstream);
  if (!upstream) {
    // Unreachable in practice: loadConfig cross-references these at boot.
    // Kept as a guard so a future config path cannot silently produce a
    // dangling reference that manifests as a confusing runtime crash.
    throw new RouterError(
      500,
      `Model "${requestedModel}" is mapped to upstream "${route.upstream}", which is not configured.`,
      'internal_error',
      'misconfigured_route',
    );
  }

  return { alias: requestedModel, upstream, upstreamModel: route.model };
}

/** All configured aliases, for GET /v1/models. */
export function listModels(config: ResolvedConfig): Array<{ alias: string; route: Route }> {
  return [...config.models.keys()].map((alias) => ({
    alias,
    route: resolveRoute(config, alias),
  }));
}
