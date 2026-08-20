import { describe, expect, it } from 'vitest';
import { resolveRoute, listModels } from '../src/router/resolve.js';
import { RouterError } from '../src/router/errors.js';
import type { ResolvedConfig } from '../src/config/schema.js';

const config: ResolvedConfig = {
  upstreams: new Map([
    [
      'openrouter',
      {
        name: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
        apiKey: 'sk-test',
        timeout_ms: 120_000,
        max_retries: 2,
        headers: {},
      },
    ],
  ]),
  models: new Map([
    ['router/gemma4', { targets: [{ upstream: 'openrouter', model: 'google/gemma-4-26b-a4b-it' }] }],
    [
      'router/nemotron3',
      { targets: [{ upstream: 'openrouter', model: 'nvidia/nemotron-3-nano-30b-a3b' }] },
    ],
  ]),
};

describe('resolveRoute', () => {
  it('maps an alias to its upstream and upstream model id', () => {
    const route = resolveRoute(config, 'router/gemma4');

    expect(route.alias).toBe('router/gemma4');
    expect(route.upstream.name).toBe('openrouter');
    expect(route.upstreamModel).toBe('google/gemma-4-26b-a4b-it');
  });

  it('throws a 404 RouterError for an unknown alias', () => {
    try {
      resolveRoute(config, 'router/does-not-exist');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).status).toBe(404);
      expect((err as RouterError).code).toBe('model_not_found');
    }
  });

  it('lists the configured aliases in the error so callers can self-correct', () => {
    try {
      resolveRoute(config, 'gpt-4');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as RouterError).message).toContain('router/gemma4');
      expect((err as RouterError).message).toContain('router/nemotron3');
    }
  });

  it('does not treat the upstream model id as a valid alias', () => {
    // Routing is by alias only. Accepting upstream ids would leak the backend
    // naming into the router's public surface.
    expect(() => resolveRoute(config, 'google/gemma-4-26b-a4b-it')).toThrow(RouterError);
  });

  it('surfaces a dangling upstream reference as a 500, not a crash', () => {
    const broken: ResolvedConfig = {
      upstreams: new Map(),
      models: new Map([['router/x', { targets: [{ upstream: 'ghost', model: 'y' }] }]]),
    };
    try {
      resolveRoute(broken, 'router/x');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as RouterError).status).toBe(500);
    }
  });
});

describe('listModels', () => {
  it('returns every configured alias with its resolved route', () => {
    const models = listModels(config);

    expect(models.map((m) => m.alias)).toEqual(['router/gemma4', 'router/nemotron3']);
    expect(models[0]?.route.upstream.name).toBe('openrouter');
  });
});
