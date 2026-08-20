import { loadConfig, ConfigError } from './config/load.js';
import { createLogger, type LogLevel } from './observability/logger.js';
import { buildApp } from './server/app.js';

/**
 * Entry point: load config, build the app, listen.
 *
 * Any configuration problem exits non-zero with a readable message before the
 * socket is ever opened, so a bad deploy fails loudly at boot instead of
 * serving 500s.
 */
async function main(): Promise<void> {
  const configPath = process.env['CONFIG_PATH'] ?? 'config.yaml';
  const port = Number(process.env['PORT'] ?? 8080);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const level = (process.env['LOG_LEVEL'] ?? 'info') as LogLevel;

  const logger = createLogger({ level });

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\nConfiguration error:\n${err.message}\n\n`);
      process.exit(1);
    }
    throw err;
  }

  const routerApiKey = process.env['ROUTER_API_KEY'];

  const app = buildApp({ config, logger, routerApiKey });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host });

  logger.info('router started', {
    port,
    host,
    configPath,
    models: [...config.models.keys()],
    upstreams: [...config.upstreams.keys()],
    authRequired: Boolean(routerApiKey),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
