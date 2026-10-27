type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(secret|token|authorization|cookie|password|app_secret|client_secret)/i;
const SECRET_VALUE = /\b(at_|rt_|dc_|sess_|QQBot\s+|Bearer\s+)[A-Za-z0-9_\-.=+/]+/g;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>);
  return value;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(value);
  }
  return out;
}

export function createLogger(level: Level = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: Level, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...redactObject(bindings),
      ...(fields ? redactObject(fields) : {}),
    };
    const text = JSON.stringify(line);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(text + '\n');
    else process.stdout.write(text + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger(level, { ...bindings, ...b }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
