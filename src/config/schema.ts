import { z } from 'zod';

/**
 * Schema for the router's configuration file.
 *
 * Design note: API keys are referenced by environment variable name rather
 * than stored inline. That keeps secrets out of the file that gets committed,
 * and lets the same config.yaml work across dev/staging/prod unchanged.
 */

const headersSchema = z.record(z.string(), z.string());

export const upstreamSchema = z.object({
  /** Base URL of the OpenAI-compatible provider, e.g. https://openrouter.ai/api/v1 */
  base_url: z.string().url('base_url must be a valid URL'),

  /** Name of the env var holding this upstream's API key. Resolved at boot. */
  api_key_env: z.string().min(1, 'api_key_env must name an environment variable'),

  /** Request timeout in milliseconds. Generous by default: LLMs are slow. */
  timeout_ms: z.number().int().positive().default(120_000),

  /** Retry attempts after the initial try, for transient failures only. */
  max_retries: z.number().int().min(0).max(5).default(2),

  /** Extra headers sent with every request to this upstream. */
  headers: headersSchema.default({}),
});

export const modelRouteSchema = z.object({
  /** Key into `upstreams`. Validated by cross-reference after parsing. */
  upstream: z.string().min(1),

  /** The model identifier this upstream expects, e.g. google/gemma-4-26b-a4b-it */
  model: z.string().min(1),
});

export const configSchema = z.object({
  upstreams: z
    .record(z.string(), upstreamSchema)
    .refine((u) => Object.keys(u).length > 0, {
      message: 'at least one upstream must be configured',
    }),
  models: z
    .record(z.string(), modelRouteSchema)
    .refine((m) => Object.keys(m).length > 0, {
      message: 'at least one model alias must be configured',
    }),
});

export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type RawConfig = z.infer<typeof configSchema>;

/** An upstream with its API key resolved from the environment. */
export interface ResolvedUpstream extends UpstreamConfig {
  name: string;
  apiKey: string;
}

/** The fully validated, ready-to-use configuration. */
export interface ResolvedConfig {
  upstreams: Map<string, ResolvedUpstream>;
  models: Map<string, ModelRoute>;
}
