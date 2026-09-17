/**
 * HTTP with bounded retries, timeouts and honest failure reporting.
 *
 * Retries are only applied to conditions that are plausibly transient
 * (429, 5xx, network errors). A 4xx other than 429 is a real answer and is
 * returned as-is - retrying it would waste the free-tier budget and could
 * mask an authorisation problem we need to surface to the operator.
 */

const DEFAULT_TIMEOUT_MS = 20000;

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * @returns {Promise<{status:number, headers:Headers, json:any, text:string}>}
 */
export async function request(url, {
  method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = 3, retryBaseMs = 800, expectJson = true,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      let json = null;
      if (expectJson && text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (!res.ok && isRetryable(res.status) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30000)
          : retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        await sleep(waitMs);
        continue;
      }
      return { status: res.status, headers: res.headers, json, text, ok: res.ok };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError?.name === 'AbortError'
    ? `Timed out after ${timeoutMs}ms`
    : (lastError?.message || 'Unknown network error');
  throw new HttpError(0, message, url);
}

/** Throwing variant for calls where a non-2xx is always a defect. */
export async function requestOk(url, options) {
  const res = await request(url, options);
  if (!res.ok) throw new HttpError(res.status, res.text?.slice(0, 500), url);
  return res;
}
