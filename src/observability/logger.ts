/**
 * Structured JSON logging.
 *
 * One line per request, machine-parseable, with secrets redacted centrally.
 * Redaction lives here rather than at each call site so that a future call
 * site cannot leak a key by forgetting to scrub it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Header names that must never appear in logs, lowercased. */
const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie']);

const REDACTED = '[REDACTED]';

/**
 * Recursively strip credentials from a value before it is serialized.
 * Handles the common shapes: header bags, nested objects, arrays.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_HEADERS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else if (/(^|_)(api[_-]?key|secret|token|password)($|_)/i.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injectable sink; defaults to stdout. Tests capture lines here. */
  write?: (line: string) => void;
  /** Injectable clock so tests can assert on deterministic timestamps. */
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());

  function log(entryLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    const entry = {
      timestamp: now().toISOString(),
      level: entryLevel,
      message: msg,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(entry));
  }

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}
