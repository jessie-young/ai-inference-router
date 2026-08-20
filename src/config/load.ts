import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, type ResolvedConfig, type ResolvedUpstream } from './schema.js';

/**
 * Thrown when configuration is invalid. Carries a human-readable, multi-line
 * message intended to be printed straight to stderr at boot.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface LoadOptions {
  /** Environment to resolve `api_key_env` against. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load, validate, and resolve the configuration file.
 *
 * Validation is deliberately strict and happens once at boot rather than per
 * request: a typo in an upstream name or a missing API key should crash the
 * process on startup with a clear message, not surface as a confusing 500 to
 * the first user who happens to hit that route.
 */
export function loadConfig(path: string, options: LoadOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not read config file at "${path}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Config file at "${path}" is not valid YAML: ${reason}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${location}: ${issue.message}`;
      })
      .join('\n');
    throw new ConfigError(`Invalid config at "${path}":\n${details}`);
  }

  const { upstreams, models } = result.data;

  // Resolve each upstream's API key from the environment. Collect every
  // problem before throwing so a misconfigured deploy surfaces all of its
  // missing variables at once instead of one per restart.
  const resolvedUpstreams = new Map<string, ResolvedUpstream>();
  const missingKeys: string[] = [];

  for (const [name, upstream] of Object.entries(upstreams)) {
    const apiKey = env[upstream.api_key_env];
    if (!apiKey) {
      missingKeys.push(
        `  - upstream "${name}" requires environment variable ${upstream.api_key_env}`,
      );
      continue;
    }
    resolvedUpstreams.set(name, { ...upstream, name, apiKey });
  }

  if (missingKeys.length > 0) {
    throw new ConfigError(
      `Missing required environment variables:\n${missingKeys.join('\n')}\n\n` +
        'Copy .env.example to .env and fill in your API keys.',
    );
  }

  // Cross-reference: every model alias must point at an upstream that exists.
  // zod cannot express this, so it is checked explicitly.
  const danglingRefs: string[] = [];
  for (const [alias, route] of Object.entries(models)) {
    if (!resolvedUpstreams.has(route.upstream)) {
      danglingRefs.push(
        `  - model "${alias}" references unknown upstream "${route.upstream}"`,
      );
    }
  }

  if (danglingRefs.length > 0) {
    const known = [...resolvedUpstreams.keys()].join(', ');
    throw new ConfigError(
      `Invalid config at "${path}":\n${danglingRefs.join('\n')}\n\n` +
        `Configured upstreams are: ${known}`,
    );
  }

  return {
    upstreams: resolvedUpstreams,
    models: new Map(Object.entries(models)),
  };
}
