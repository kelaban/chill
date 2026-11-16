// Minimal structured logger. Everything passes through `redact`, so tokens and
// signed provider URLs can't reach the logs even if a caller is careless.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = "info";
let sink: (line: string) => void = (l) => process.stdout.write(l + "\n");

export function setLogLevel(l: Level) {
  threshold = l;
}
/** Tests capture output to assert redaction. */
export function setLogSink(fn: (line: string) => void) {
  sink = fn;
}

const SECRET_QUERY = /([?&](?:oauth_token|access_token|token|sig|signature|key|api_key|expires|Expires|X-Amz-[A-Za-z-]+)=)[^&\s"']+/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const MAGNET = /magnet:\?[^\s"']+/g;

export function redact(s: string): string {
  return s.replace(BEARER, "$1[redacted]").replace(SECRET_QUERY, "$1[redacted]").replace(MAGNET, "magnet:[redacted]");
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[threshold]) return;
  const rec: Record<string, unknown> = { t: new Date().toISOString(), level, msg, ...fields };
  if (fields?.err instanceof Error) rec.err = { message: fields.err.message, stack: fields.err.stack };
  sink(redact(JSON.stringify(rec)));
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
