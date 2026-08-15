/**
 * Logging.
 *
 * No logging library. Node's console is structured enough for a service this
 * small, and a dependency that touches every code path is exactly the kind of
 * thing that should have to justify itself.
 *
 * The one thing this does that `console.log` does not is REDACT. Tokens reach
 * this process from three directions — the HA long-lived token, the Immich API
 * key, and the panel bearer token in a WebSocket query string — and container
 * logs are the easiest place in the whole system for a credential to leak
 * into a paste in a support thread. Redaction is applied unconditionally,
 * including at debug level, because the moment it is opt-in someone will
 * forget.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: string): void {
  const parsed = ORDER[level as Level];
  threshold = parsed ?? ORDER.info;
}

/** Anything that has ever looked like a secret in this codebase. */
const SECRET_PATTERNS: [RegExp, string][] = [
  // ?t=<panel token> in a WebSocket URL
  [/([?&]t=)[^&\s"']+/gi, '$1<redacted>'],
  // Authorization: Bearer <token>
  [/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>'],
  // x-api-key: <key>
  [/(x-api-key["'\s:=]+)[^\s,"'}]+/gi, '$1<redacted>'],
  // "access_token": "<token>" in an HA auth frame
  [/("access_token"\s*:\s*")[^"]*/gi, '$1<redacted>'],
];

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
    return out;
  }
  if (value instanceof Error) return redact(value.stack ?? value.message);
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(redact(JSON.stringify(value)) as string) as unknown;
    } catch {
      return '[unserialisable]';
    }
  }
  return value;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const safe = args.map(redact);
  if (level === 'error') console.error(line, ...safe);
  else if (level === 'warn') console.warn(line, ...safe);
  else console.log(line, ...safe);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
