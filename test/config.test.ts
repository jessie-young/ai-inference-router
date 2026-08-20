import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config/load.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'router-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(contents: string): string {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, contents);
  return path;
}

const VALID = `
upstreams:
  openrouter:
    base_url: https://openrouter.ai/api/v1
    api_key_env: TEST_KEY
models:
  router/gemma4:
    upstream: openrouter
    model: google/gemma-4-26b-a4b-it
`;

describe('loadConfig', () => {
  it('loads a valid config and resolves the API key from the environment', () => {
    const config = loadConfig(writeConfig(VALID), { env: { TEST_KEY: 'sk-test' } });

    expect(config.models.size).toBe(1);
    expect(config.upstreams.get('openrouter')?.apiKey).toBe('sk-test');
    expect(config.models.get('router/gemma4')?.model).toBe('google/gemma-4-26b-a4b-it');
  });

  it('applies defaults for optional upstream fields', () => {
    const config = loadConfig(writeConfig(VALID), { env: { TEST_KEY: 'sk-test' } });
    const upstream = config.upstreams.get('openrouter');

    expect(upstream?.timeout_ms).toBe(120_000);
    expect(upstream?.max_retries).toBe(2);
    expect(upstream?.headers).toEqual({});
  });

  it('fails when the referenced environment variable is not set', () => {
    expect(() => loadConfig(writeConfig(VALID), { env: {} })).toThrow(ConfigError);
    expect(() => loadConfig(writeConfig(VALID), { env: {} })).toThrow(/TEST_KEY/);
  });

  it('fails when a model references an upstream that does not exist', () => {
    const path = writeConfig(`
upstreams:
  openrouter:
    base_url: https://openrouter.ai/api/v1
    api_key_env: TEST_KEY
models:
  router/typo:
    upstream: openrooter
    model: some/model
`);
    expect(() => loadConfig(path, { env: { TEST_KEY: 'sk-test' } })).toThrow(/unknown upstream/);
  });

  it('rejects a base_url that is not a URL', () => {
    const path = writeConfig(`
upstreams:
  bad:
    base_url: not-a-url
    api_key_env: TEST_KEY
models:
  router/x:
    upstream: bad
    model: y
`);
    expect(() => loadConfig(path, { env: { TEST_KEY: 'sk-test' } })).toThrow(/valid URL/);
  });

  it('reports every missing environment variable at once', () => {
    const path = writeConfig(`
upstreams:
  a:
    base_url: https://a.example.com/v1
    api_key_env: KEY_A
  b:
    base_url: https://b.example.com/v1
    api_key_env: KEY_B
models:
  router/x:
    upstream: a
    model: y
`);
    try {
      loadConfig(path, { env: {} });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('KEY_A');
      expect((err as Error).message).toContain('KEY_B');
    }
  });

  it('fails on malformed YAML', () => {
    expect(() => loadConfig(writeConfig('upstreams: [unclosed'), { env: {} })).toThrow(ConfigError);
  });

  it('fails when the file does not exist', () => {
    expect(() => loadConfig(join(dir, 'nope.yaml'), { env: {} })).toThrow(/Could not read/);
  });

  it('accepts the shipped example config', () => {
    const config = loadConfig('config.yaml', { env: { OPENROUTER_API_KEY: 'sk-test' } });

    expect([...config.models.keys()].sort()).toEqual([
      'router/gemma4',
      'router/mistral-small',
      'router/nemotron3',
    ]);
    expect(config.models.get('router/nemotron3')?.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
    expect(config.models.get('router/mistral-small')?.model).toBe('mistralai/mistral-small-2603');
  });
});
