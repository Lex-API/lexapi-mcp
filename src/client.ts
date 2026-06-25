import type {
  AnyResponse,
  CitationsQuery,
  DocumentContentRequest,
  RecentDocumentsQuery,
  SearchRequest,
  SemanticSearchRequest,
} from './types.js';

const DEFAULT_BASE_URL = 'https://lex-api.com/api/v1';

export class LexAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly slug: string,
    message: string,
  ) {
    super(message);
    this.name = 'LexAPIError';
  }
}

export interface LexAPIClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Max retries on transient errors (5xx, network). Default 2. */
  maxRetries?: number;
}

export class LexAPIClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;

  constructor(opts: LexAPIClientOptions) {
    if (!opts.apiKey) throw new Error('LexAPIClient: apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
  }

  // ── HTTP ──────────────────────────────────────────────────────────
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, unknown> | object,
  ): Promise<AnyResponse> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const init: RequestInit = {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let attempt = 0;
    while (true) {
      const res = await fetch(url, init);

      // Honor 429 Retry-After once before giving up.
      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
        await sleep(Math.max(1, retryAfter) * 1000);
        attempt++;
        continue;
      }

      // Retry on transient 5xx with exponential backoff.
      if (res.status >= 500 && res.status < 600 && attempt < this.maxRetries) {
        await sleep(500 * Math.pow(2, attempt));
        attempt++;
        continue;
      }

      const text = await res.text();
      const json = text ? safeJson(text) : {};

      if (!res.ok) {
        const { slug, message } = extractError(json, text, res.status);
        throw new LexAPIError(res.status, slug, message);
      }

      return json as AnyResponse;
    }
  }

  // ── Endpoints ─────────────────────────────────────────────────────
  search(body: SearchRequest) {
    return this.request('POST', '/search', body);
  }

  getDocument(body: DocumentContentRequest) {
    return this.request('POST', '/documentContent', body);
  }

  getMetadata(body: DocumentContentRequest) {
    return this.request('POST', '/documents/metadata', body);
  }

  getDocumentByUrl(body: { url: string }) {
    return this.request('POST', '/documents/url', body);
  }

  recentDocuments(query: RecentDocumentsQuery) {
    return this.request('GET', '/documents/recent', undefined, query);
  }

  citedBy(celex: string, query: CitationsQuery = {}) {
    return this.request(
      'GET',
      `/citations/cited-by/${encodeURIComponent(celex)}`,
      undefined,
      query,
    );
  }

  cites(celex: string, query: CitationsQuery = {}) {
    return this.request(
      'GET',
      `/citations/cites/${encodeURIComponent(celex)}`,
      undefined,
      query,
    );
  }

  citationNetwork(celex: string) {
    return this.request(
      'GET',
      `/citations/network/${encodeURIComponent(celex)}`,
    );
  }

  semanticCaseLaw(body: SemanticSearchRequest) {
    return this.request('POST', '/search/semantic', body);
  }

  semanticLegislation(body: SemanticSearchRequest) {
    return this.request('POST', '/legislation/semantic', body);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'invalid_json', message: text.slice(0, 500) };
  }
}

// Gateway returns either the typed envelope { error: { code, message } } or
// the legacy flat shape { error: "slug", message: "..." }. Handle both;
// fall back to HTTP status when neither is present.
function extractError(
  json: unknown,
  text: string,
  status: number,
): { slug: string; message: string } {
  const fallbackMessage = text || `HTTP ${status}`;
  const fallbackSlug = `http_${status}`;
  if (!json || typeof json !== 'object') {
    return { slug: fallbackSlug, message: fallbackMessage };
  }
  const j = json as Record<string, unknown>;
  const e = j.error;
  if (e && typeof e === 'object') {
    const eo = e as Record<string, unknown>;
    const slug = typeof eo.code === 'string' ? eo.code : fallbackSlug;
    const message =
      typeof eo.message === 'string'
        ? eo.message
        : typeof j.message === 'string'
          ? j.message
          : fallbackMessage;
    return { slug, message };
  }
  const slug = typeof e === 'string' ? e : fallbackSlug;
  const message = typeof j.message === 'string' ? j.message : fallbackMessage;
  return { slug, message };
}
