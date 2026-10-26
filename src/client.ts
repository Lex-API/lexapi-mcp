import { LexAPIError, LexAPITransportError, parseErrorBody } from './errors.js';
import { PACKAGE_VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://lex-api.com/api/v1';
/**
 * Per-attempt timeout. LexAPI's own upstream budgets: EUR-Lex fetches are
 * hard-capped at 90 s server-side, semantic legislation search (with asOf)
 * at 45 s, the citation network at 30 s — so 120 s covers every endpoint.
 */
export const LONG_TIMEOUT_MS = 120_000;
/**
 * Without a progress token the MCP client's own request timeout applies
 * (the TypeScript SDK default is 60 s; Claude Code: MCP_TOOL_TIMEOUT). Give up
 * a few seconds earlier so the model gets our actionable timeout message
 * instead of the client's generic -32001.
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
] as const;

export type KeptHeader = (typeof KEPT_HEADERS)[number];
export type Json = Record<string, unknown>;

export interface LexResponse<T = Json> {
  status: number;
  body: T;
  headers: Partial<Record<KeptHeader, string>>;
}

export interface LexAPIClientOptions {
  apiKey: string;
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
}

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Parse the body as NDJSON (one JSON value per line) instead of JSON. */
  ndjson?: boolean;
  /** Calls whose repetition has a side effect (create, test delivery) opt out. */
  retry?: boolean;
}

export class LexAPIClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal?: AbortSignal;
  private readonly opts: LexAPIClientOptions;

  constructor(opts: LexAPIClientOptions) {
    const key = (opts.apiKey ?? '').trim();
    if (!key) throw new Error('LexAPI API key is missing.');
    // Never include the key itself in this message.
    if (!isWellFormedKey(key)) throw new Error('LexAPI API key contains whitespace or control characters — paste it again as a single line.');
    this.opts = opts;
    this.apiKey = key;
    this.signal = opts.signal;
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

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      accept: opts.ndjson ? 'application/x-ndjson, application/json' : 'application/json',
      'user-agent': `lexapi-mcp/${PACKAGE_VERSION}`,
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const canRetry = opts.retry !== false;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: combineSignals(this.signal, AbortSignal.timeout(this.timeoutMs)),
        });
      } catch (err) {
        if (this.signal?.aborted) throw new LexAPITransportError('the request was cancelled by the client', false, true);
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (!timedOut && canRetry && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(500 * 2 ** attempt);
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
        await discard(res);
        throw new LexAPITransportError('the request was cancelled by the client', false, true);
      }
      if (res.status === 429 && canRetry && attempt < this.maxRetries) {
        const wait = retryAfterSeconds(res);
        if (wait !== undefined && wait <= MAX_RETRY_AFTER_SLEEP_S) {
          await discard(res);
          attempt++;
          await this.sleep(Math.max(1, wait) * 1000);
          continue;
        }
      }
      // 500/502/503 are transient and refunded in full on credit plans.
      // 504 is NOT retried: it already means a 90 s upstream budget ran out.
      if ((res.status === 500 || res.status === 502 || res.status === 503) && canRetry && attempt < this.maxRetries) {
        await discard(res);
        attempt++;
        await this.sleep(500 * 2 ** attempt);
        continue;
      }

      const text = res.status === 204 ? '' : await res.text();
      const kept: LexResponse['headers'] = {};
      for (const h of KEPT_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) kept[h] = v;
      }

      if (!res.ok) {
        const parsed = parseErrorBody(safeJson(text), text, res.status);
        throw new LexAPIError(
          res.status,
          parsed.code,
          parsed.message,
          parsed.details,
          retryAfterSeconds(res) ?? parsed.retryAfter,
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
  citationStats() { return this.request('GET', '/citations/stats'); }

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

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  const abort = () => c.abort();
  if (a.aborted || b.aborted) c.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return c.signal;
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
