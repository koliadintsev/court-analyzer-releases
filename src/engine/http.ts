// Мережеві запити з повторами. Реалізація fetch передається ззовні:
// в Electron це net.fetch (системний проксі й сертифікати), у тестах — глобальний fetch.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body = '',
  ) {
    super(message);
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Зупинено користувачем');
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, reason: string, delayMs: number) => void;
}

/** Виконує запит, повторюючи його при мережевих збоях і статусах 429/5xx. */
export async function fetchWithRetry(fetchFn: FetchFn, url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1500;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(opts.signal);
    try {
      const res = await fetchFn(url, { ...init, signal: opts.signal });
      if (res.ok || res.status === 206 || res.status === 304) return res;
      const body = await res.text().catch(() => '');
      lastError = new HttpError(`HTTP ${res.status}`, res.status, body);
      if (!RETRY_STATUSES.has(res.status) || attempt === retries) throw lastError;
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 120_000) : backoff(base, attempt);
      opts.onRetry?.(attempt + 1, `HTTP ${res.status}`, delay);
      await sleep(delay, opts.signal);
    } catch (e) {
      if (isCancelled(e) || opts.signal?.aborted) throw new CancelledError();
      if (e instanceof HttpError) throw e;
      lastError = e;
      if (attempt === retries) break;
      const delay = backoff(base, attempt);
      opts.onRetry?.(attempt + 1, errorText(e), delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function backoff(base: number, attempt: number): number {
  return Math.round(base * 2 ** attempt * (0.75 + Math.random() * 0.5));
}

export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) return `${e.message} (${cause.message})`;
    return e.message;
  }
  return String(e);
}

export async function fetchJson<T>(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetchWithRetry(fetchFn, url, { headers: { Accept: 'application/json' } }, { signal, retries: 2 });
  return (await res.json()) as T;
}
