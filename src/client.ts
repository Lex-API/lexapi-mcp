import { LexAPIError, LexAPITransportError, parseErrorBody } from './errors.js';
import { PACKAGE_VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://lex-api.com/api/v1';
/**
 * Deadline for one tool call (all attempts, backoff and 429 sleeps included).
 * MCP clients give up after their own request timeout (the TypeScript SDK
 * default is 60 s; Claude Code: MCP_TOOL_TIMEOUT), so stop a few seconds
 * earlier and return an actionable message instead of the client's generic
 * -32001. LexAPI's own upstream budgets (EUR-Lex fetch 90 s, semantic
 * legislation 45 s, citation network 30 s) can exceed this on a cold live
 * fetch; users who raise their client's timeout raise LEXAPI_TIMEOUT_MS too.
 */
export const DEFAULT_TIMEOUT_MS = 55_000;

/** Printable ASCII, no spaces — anything else cannot be a LexAPI key (and would end up in an undici error message). */
const KEY_RE = /^[\x21-\x7e]+$/;

export function isWellFormedKey(key: string): boolean {
  return KEY_RE.test(key);
}
/** A 429 whose Retry-After is longer than this is returned to the model instead of slept on. */
const MAX_RETRY_AFTER_SLEEP_S = 10;

/** Response headers worth surfacing to a model; everything else is dropped. */
const KEPT_HEADERS = [
  'x-source',
  'x-language',
  'x-language-fallback',
  'x-text-available',
  'x-warning',
  'x-search-source',
  'x-search-cache',
  'x-ignored-documenttypes',
  'x-corpus-version',
  'x-export-total',
  'x-export-truncated',
  // National-law monthly allowance for FREE/STARTER/PROFESSIONAL accounts;
  // absent for BUSINESS and higher (no separate limit).
  'x-national-limit',
  'x-national-remaining',
  'x-national-reset',
] as const;

export type KeptHeader = (typeof KEPT_HEADERS)[number];
export type Json = Record<string, unknown>;

export interface LexResponse<T = Json> {
  status: number;
  body: T;
  headers: Partial<Record<KeptHeader, string>>;
}

/**
 * How a request authenticates to LexAPI. The API-key credential sends
 * `x-api-key`; the hosted server's OAuth credential (src/oauth/upstream.ts)
 * sends `Authorization: Bearer <exchanged API token>` and no `x-api-key`.
 */
export interface UpstreamAuth {
  /** Headers for one attempt (may exchange a token: throws its own typed errors). */
  headers(ctx: { signal?: AbortSignal }): Promise<Record<string, string>> | Record<string, string>;
  /**
   * The API answered 401. Return 'retry' to send the request once more with
   * fresh headers, an Error to fail with it, or undefined for the normal 401.
   */
  onUnauthorized?(info: { wwwAuthenticate: string | null; body: string }): Promise<'retry' | Error | undefined> | 'retry' | Error | undefined;
}

export interface LexAPIClientOptions {
  /** API key (stdio, hosted API-key requests). Required unless `auth` is given. */
  apiKey?: string;
  /** Any other credential (hosted OAuth requests). Takes precedence over `apiKey`. */
  auth?: UpstreamAuth;
  baseUrl?: string;
  /** Retries on transient failures (500/502/503, network errors, short 429s). Default 1. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Aborts every request of this client (MCP request cancellation). */
  signal?: AbortSignal;
  /** Injected for tests (the per-call deadline clock). */
  now?: () => number;
}

/** No retry or 429 sleep is started unless at least this much of the call's deadline would remain. */
const MIN_ATTEMPT_MS = 2000;

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Parse the body as NDJSON (one JSON value per line) instead of JSON. */
  ndjson?: boolean;
  /** Calls whose repetition has a side effect (create, test delivery) opt out. */
  retry?: boolean;
}

function apiKeyAuth(key: string): UpstreamAuth {
  const headers = { 'x-api-key': key };
  return { headers: () => headers };
}

export class LexAPIClient {
  private readonly auth: UpstreamAuth;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private readonly opts: LexAPIClientOptions;

  constructor(opts: LexAPIClientOptions) {
    if (opts.auth) {
      this.auth = opts.auth;
    } else {
      const key = (opts.apiKey ?? '').trim();
      if (!key) throw new Error('LexAPI API key is missing.');
      // Never include the key itself in this message.
      if (!isWellFormedKey(key)) throw new Error('LexAPI API key contains whitespace or control characters — paste it again as a single line.');
      this.auth = apiKeyAuth(key);
    }
    this.opts = opts;
    this.signal = opts.signal;
    this.now = opts.now ?? Date.now;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 1;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A client for one MCP request: its cancellation signal and timeout. */
  forCall(call: { signal?: AbortSignal; timeoutMs?: number }): LexAPIClient {
    return new LexAPIClient({
      ...this.opts,
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.timeoutMs ? { timeoutMs: call.timeoutMs } : {}),
    });
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  private credentialHeaders(): Record<string, string> | Promise<Record<string, string>> {
    if (this.signal?.aborted) throw new LexAPITransportError('the request was cancelled by the client', false, true);
    const h = this.auth.headers({ signal: this.signal });
    if (!(h instanceof Promise)) return h;
    return h.catch((err) => {
      if (this.signal?.aborted) throw new LexAPITransportError('the request was cancelled by the client', false, true);
      throw err;
    });
  }

  /** Low-level request. Throws LexAPIError (HTTP error) or LexAPITransportError. */
  async request<T = Json>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: RequestOptions = {},
  ): Promise<LexResponse<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        if (v.length) url.searchParams.set(k, v.join(','));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    const baseHeaders: Record<string, string> = {
      accept: opts.ndjson ? 'application/x-ndjson, application/json' : 'application/json',
      'user-agent': `lexapi-mcp/${PACKAGE_VERSION}`,
    };
    if (opts.body !== undefined) baseHeaders['content-type'] = 'application/json';

    const canRetry = opts.retry !== false;
    // ONE deadline for the whole call — attempts, backoff and 429 sleeps all
    // come out of it, so retries can never push a call past the timeout the
    // MCP client is waiting on.
    const deadline = this.now() + this.timeoutMs;
    const remaining = () => deadline - this.now();
    const canWait = (ms: number) => remaining() - ms >= MIN_ATTEMPT_MS;
    let attempt = 0;
    let authRetried = false;
    for (;;) {
      if (remaining() <= 0) {
        throw new LexAPITransportError(`no response within ${Math.round(this.timeoutMs / 1000)} s`, true);
      }
      // Per attempt: an OAuth credential re-exchanges after a 401. Its errors
      // (exchange refused, AS unreachable) propagate as they are.
      // An API key resolves synchronously (no extra tick before fetch).
      const pending = this.credentialHeaders();
      const credential = pending instanceof Promise ? await pending : pending;
      if (this.signal?.aborted) throw new LexAPITransportError('the request was cancelled by the client', false, true);
      const headers: Record<string, string> = { ...baseHeaders, ...credential };
      let res: Response;
      const attemptSignal = combineSignals(this.signal, AbortSignal.timeout(Math.max(1, remaining())));
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: attemptSignal.signal,
        });
      } catch (err) {
        attemptSignal.dispose();
        if (this.signal?.aborted) throw new LexAPITransportError('the request was cancelled by the client', false, true);
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const backoff = 500 * 2 ** (attempt + 1);
        if (!timedOut && canRetry && attempt < this.maxRetries && canWait(backoff)) {
          attempt++;
          await this.sleep(backoff);
          continue;
        }
        // Never forward the runtime's message: undici quotes header values
        // (the key) in some of them. Report only the error class / errno.
        const reason = timedOut
          ? `no response within ${Math.round(this.timeoutMs / 1000)} s`
          : networkReason(err);
        throw new LexAPITransportError(reason, timedOut);
      }

      if (this.signal?.aborted) {
        attemptSignal.dispose();
        await discard(res);
        throw new LexAPITransportError('the request was cancelled by the client', false, true);
      }
      if (res.status === 401 && this.auth.onUnauthorized) {
        let peek = '';
        try { peek = await res.clone().text(); } catch { /* unreadable body */ }
        const verdict = await this.auth.onUnauthorized({ wwwAuthenticate: res.headers.get('www-authenticate'), body: peek });
        // At most one credential retry per call, whatever the credential says.
        if (verdict === 'retry' && !authRetried) {
          attemptSignal.dispose();
          await discard(res);
          authRetried = true;
          continue;
        }
        if (verdict instanceof Error) {
          attemptSignal.dispose();
          await discard(res);
          throw verdict;
        }
      }
      // A used-up legacy quota (QUOTA_EXHAUSTED) cannot succeed
      // before it refills, whatever its Retry-After says: never retried.
      if (res.status === 429 && canRetry && attempt < this.maxRetries && !(await isQuotaExhausted(res))) {
        const wait = retryAfterSeconds(res);
        const waitMs = wait === undefined ? Infinity : Math.max(1, wait) * 1000;
        if (wait !== undefined && wait <= MAX_RETRY_AFTER_SLEEP_S && canWait(waitMs)) {
          attemptSignal.dispose();
          await discard(res);
          attempt++;
          await this.sleep(waitMs);
          continue;
        }
      }
      // 500/502/503 are transient and refunded in full on credit plans.
      // 504 is NOT retried: it already means a 90 s upstream budget ran out.
      const backoff = 500 * 2 ** (attempt + 1);
      if ((res.status === 500 || res.status === 502 || res.status === 503) && canRetry && attempt < this.maxRetries && canWait(backoff)) {
        attemptSignal.dispose();
        await discard(res);
        attempt++;
        await this.sleep(backoff);
        continue;
      }

      let text: string;
      try {
        text = res.status === 204 ? '' : await res.text();
      } catch (err) {
        if (this.signal?.aborted) throw new LexAPITransportError('the request was cancelled by the client', false, true);
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new LexAPITransportError(timedOut ? `no response within ${Math.round(this.timeoutMs / 1000)} s` : networkReason(err), timedOut);
      } finally {
        attemptSignal.dispose();
      }
      const kept: LexResponse['headers'] = {};
      for (const h of KEPT_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) kept[h] = v;
      }

      if (!res.ok) {
        const parsed = parseErrorBody(safeJson(text), text, res.status);
        const quota = parsed.code === 'QUOTA_EXHAUSTED';
        throw new LexAPIError(
          res.status,
          parsed.code,
          parsed.message,
          parsed.details,
          // A quota 429 has no meaningful retry-after.
          quota ? undefined : (retryAfterSeconds(res) ?? parsed.retryAfter),
          parsed.resetsAt,
        );
      }

      let body: unknown;
      if (opts.ndjson && !(res.headers.get('content-type') ?? '').includes('application/json')) {
        body = {
          lines: text
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => safeJson(l) ?? { _unparsed: l.slice(0, 200) }),
        };
      } else {
        body = text ? (safeJson(text) ?? { _unparsed: text.slice(0, 500) }) : {};
      }
      return { status: res.status, body: body as T, headers: kept };
    }
  }

  // ── Meta ─────────────────────────────────────────────────────────
  info() { return this.request('GET', '/info'); }

  // ── Search & documents ───────────────────────────────────────────
  search(body: Json) { return this.request('POST', '/search', { body }); }
  getDocument(body: Json) { return this.request('POST', '/documentContent', { body }); }
  getDocumentsBatch(body: Json) { return this.request('POST', '/documentContent/batch', { body }); }
  getMetadata(body: Json) { return this.request('POST', '/documents/metadata', { body }); }
  getDocumentByUrl(body: Json) { return this.request('POST', '/documents/url', { body }); }
  recentDocuments(query: Query) { return this.request('GET', '/documents/recent', { query }); }
  resolve(body: Json) { return this.request('POST', '/resolve', { body }); }

  // ── Version history (observation snapshots) ──────────────────────
  listVersions(celex: string, query: Query) {
    return this.request('GET', `/documents/${enc(celex)}/versions`, { query });
  }
  getVersion(celex: string, version: number, query: Query) {
    return this.request('GET', `/documents/${enc(celex)}/versions/${version}`, { query });
  }
  getAtDate(celex: string, date: string, query: Query) {
    return this.request('GET', `/documents/${enc(celex)}/at/${enc(date)}`, { query });
  }

  // ── Export (NDJSON) ──────────────────────────────────────────────
  exportCorpus(query: Query) {
    return this.request<{ lines?: unknown[] }>('GET', '/export', { query, ndjson: true });
  }

  // ── Semantic ─────────────────────────────────────────────────────
  semanticCaseLaw(body: Json) { return this.request('POST', '/search/semantic', { body }); }
  semanticLegislation(body: Json) { return this.request('POST', '/legislation/semantic', { body }); }

  // ── Citations ────────────────────────────────────────────────────
  extractCitations(body: Json) { return this.request('POST', '/citations/extract', { body }); }
  citedBy(celex: string, query: Query) { return this.request('GET', `/citations/cited-by/${enc(celex)}`, { query }); }
  cites(celex: string, query: Query) { return this.request('GET', `/citations/cites/${enc(celex)}`, { query }); }
  citationNetwork(celex: string, query: Query) {
    return this.request('GET', `/citations/network/${enc(celex)}`, { query });
  }
  citationPath(from: string, to: string, query: Query) {
    return this.request('GET', `/citations/path/${enc(from)}/${enc(to)}`, { query });
  }
  related(celex: string, query: Query) { return this.request('GET', `/citations/related/${enc(celex)}`, { query }); }
  citationStats(query: Query = {}) { return this.request('GET', '/citations/stats', { query }); }

  // ── National law ─────────────────────────────────────────────────
  // Jurisdiction codes are lower-cased on the wire (route pattern is
  // registry-generated from lower-case codes).
  nationalCoverage() { return this.request('GET', '/national/coverage'); }
  getNationalDocument(jurisdiction: string, id: string, query: Query) {
    return this.request('GET', `/${jurisdiction.toLowerCase()}/documents/${enc(id)}`, { query });
  }
  listNationalDocuments(jurisdiction: string, query: Query) {
    return this.request('GET', `/${jurisdiction.toLowerCase()}/documents`, { query });
  }
  nationalSemanticCaseLaw(jurisdiction: string, body: Json) {
    return this.request('POST', `/${jurisdiction.toLowerCase()}/search/semantic`, { body });
  }
  nationalSemanticLegislation(jurisdiction: string, body: Json) {
    return this.request('POST', `/${jurisdiction.toLowerCase()}/legislation/semantic`, { body });
  }

  // ── Webhooks ─────────────────────────────────────────────────────
  listWebhooks() { return this.request('GET', '/webhooks'); }
  getWebhook(id: string) { return this.request('GET', `/webhooks/${enc(id)}`); }
  webhookDeliveries(id: string, query: Query) {
    return this.request('GET', `/webhooks/${enc(id)}/deliveries`, { query });
  }
  // A retried create would make a second webhook — never auto-retried.
  createWebhook(body: Json) { return this.request('POST', '/webhooks', { body, retry: false }); }
  updateWebhook(id: string, body: Json) { return this.request('PUT', `/webhooks/${enc(id)}`, { body }); }
  // A lost response + retry would turn a successful delete into a confusing 404.
  deleteWebhook(id: string) { return this.request('DELETE', `/webhooks/${enc(id)}`, { retry: false }); }
  // A retried test would POST to the user's endpoint twice.
  testWebhook(id: string) { return this.request('POST', `/webhooks/${enc(id)}/test`, { retry: false }); }
}

/**
 * The call's cancellation signal combined with this attempt's timeout.
 * `dispose()` detaches the listeners of the pre-20.3 fallback (no
 * AbortSignal.any), so long-lived call signals don't accumulate them.
 */
export function combineSignals(a: AbortSignal | undefined, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!a) return { signal: b, dispose: () => {} };
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([a, b]), dispose: () => {} };
  const c = new AbortController();
  const dispose = () => {
    a.removeEventListener('abort', abort);
    b.removeEventListener('abort', abort);
  };
  function abort() {
    dispose();
    c.abort();
  }
  if (a.aborted || b.aborted) {
    c.abort();
    return { signal: c.signal, dispose: () => {} };
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return { signal: c.signal, dispose };
}

/** A key-free description of a network failure: errno code if there is one, else the error class. */
function networkReason(err: unknown): string {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string'
    ? (cause as { code: string }).code
    : undefined;
  if (code && /^[A-Z_]+$/.test(code)) return `network error ${code}`;
  if (err instanceof TypeError && /invalid header/i.test(err.message)) return 'invalid request header (check the API key)';
  return `network error (${err instanceof Error ? err.name : 'unknown'})`;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

/** Peeks a 429 body (on a clone) for `code: "QUOTA_EXHAUSTED"`. */
async function isQuotaExhausted(res: Response): Promise<boolean> {
  try {
    const j = safeJson(await res.clone().text());
    return !!j && typeof j === 'object' && (j as Record<string, unknown>).code === 'QUOTA_EXHAUSTED';
  } catch {
    return false;
  }
}

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
