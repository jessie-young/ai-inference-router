import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { createLogger } from '../../src/observability/logger.js';
import type { ResolvedConfig } from '../../src/config/schema.js';

export interface TestAppOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  routerApiKey?: string;
  headers?: Record<string, string>;
}

export interface TestApp {
  app: FastifyInstance;
  logs: Array<Record<string, unknown>>;
}

/** Build an app wired to a stub upstream, capturing logs for assertions. */
export function buildTestApp(options: TestAppOptions): TestApp {
  const config: ResolvedConfig = {
    upstreams: new Map([
      [
        'stub',
        {
          name: 'stub',
          base_url: options.baseUrl,
          api_key_env: 'STUB_KEY',
          apiKey: 'sk-upstream-secret',
          timeout_ms: options.timeoutMs ?? 5_000,
          max_retries: options.maxRetries ?? 0,
          headers: options.headers ?? {},
        },
      ],
    ]),
    models: new Map([
      ['router/gemma4', { targets: [{ upstream: 'stub', model: 'google/gemma-4-26b-a4b-it' }] }],
      [
        'router/nemotron3',
        { targets: [{ upstream: 'stub', model: 'nvidia/nemotron-3-nano-30b-a3b' }] },
      ],
    ]),
  };

  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });

  const app = buildApp({ config, logger, routerApiKey: options.routerApiKey });
  return { app, logs };
}
