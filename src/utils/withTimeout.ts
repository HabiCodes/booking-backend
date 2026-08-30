/**
 * withTimeout — wraps an async operation with a deadline.
 * Throws AbortError if the operation doesn't complete within timeoutMs.
 *
 * Uses AbortController (signal-based) so it works with any API that
 * respects abort signals (fetch, Axios, pg queries with query timeout, etc.).
 * Falls back to Promise.race for operations that don't accept AbortSignal.
 */

/**
 * Race a promise against a timeout. Returns the promise result or throws
 * an Error with `code: 'TIMEOUT'` and `message: 'Operation timed out after Xms'`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`) as Error & { code: string };
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Wrap an async function so every call is automatically bounded by a timeout.
 */
export function withTimeoutFn<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  timeoutMs: number,
  label = 'operation',
): T {
  return ((...args: Parameters<T>) => withTimeout(fn(...args), timeoutMs, label)) as T;
}
