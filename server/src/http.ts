import { EnvHttpProxyAgent, fetch as undiciFetch, type RequestInit, type Response } from "undici";

// Outbound HTTP for every adapter. Honors HTTPS_PROXY (and NO_PROXY) so the same
// code runs behind a corporate/dev proxy and on the home server.
const dispatcher = process.env.HTTPS_PROXY || process.env.https_proxy ? new EnvHttpProxyAgent() : undefined;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what} → HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  return undiciFetch(url, { ...rest, dispatcher, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
}

export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const res = await http(url, init);
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), init.what ?? new URL(url).pathname);
  return (await res.json()) as T;
}

/** A tiny counting semaphore (chill.institute asks for low concurrency). */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
