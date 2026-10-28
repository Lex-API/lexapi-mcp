// Error type + the text a model sees when a call fails.
//
// LexAPI answers errors in two shapes (docs.md "Errors & retries"):
//   typed:  { success: false, error: { code, message, details? } }
//   legacy: { error: "slug or sentence", message?, details?, retryAfter?, upgradeUrl?, usage? }
//           — from lex-api #304 on also a top-level `code` (e.g. RATE_LIMITED,
//           QUOTA_EXHAUSTED) and, on quota 429s, a top-level `resetsAt`.
// We normalise both, then turn the status into a message that says what
// happened AND what to do next — the model relays it to the user, so it has
// to be actionable without the model knowing LexAPI's billing rules.

const DASHBOARD_URL = 'https://lex-api.com/dashboard?ref=mcp';
const PRICING_URL = 'https://lex-api.com/pricing?ref=mcp';

export class LexAPIError extends Error {
  constructor(
    public readonly status: number,
    /** Typed `error.code` (e.g. CREDITS_EXHAUSTED) or the legacy slug. */
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** Seconds from the `Retry-After` header / `retryAfter` body (429); never set for QUOTA_EXHAUSTED. */
    public readonly retryAfterSeconds?: number,
    /** When an exhausted legacy quota refills (`resetsAt`, else `usage.resetsAt`). */
    public readonly resetsAt?: string,
  ) {
    super(message);
    this.name = 'LexAPIError';
  }
}

/** Raised for network failures / timeouts before any HTTP status arrived. */
export class LexAPITransportError extends Error {
  constructor(message: string, public readonly timedOut: boolean, public readonly cancelled = false) {
    super(message);
    this.name = 'LexAPITransportError';
  }
}

export function parseErrorBody(
  json: unknown,
  rawText: string,
  status: number,
): { code: string; message: string; details?: unknown; retryAfter?: number; resetsAt?: string } {
  const fallback = { code: `HTTP_${status}`, message: rawText.trim().slice(0, 300) || `HTTP ${status}` };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fallback;
  const j = json as Record<string, unknown>;
  const retryAfter = typeof j.retryAfter === 'number' ? j.retryAfter : undefined;
  // A top-level string `code` (lex-api #304) beats the legacy `error` text.
  const topCode = typeof j.code === 'string' && j.code ? j.code : undefined;
  const usage = j.usage && typeof j.usage === 'object' ? j.usage as Record<string, unknown> : undefined;
  const resetsAt = typeof j.resetsAt === 'string' ? j.resetsAt
    : usage && typeof usage.resetsAt === 'string' ? usage.resetsAt
      : undefined;
  // National error bodies (lex-api national-law lanes) carry `jurisdiction`
  // (and, for a withdrawn document — lex-api PR #320 — also `id` and
  // `withdrawnAt`) as plain top-level siblings of `error`/`code`/`message`,
  // never nested in `details` — the document-id 404, the 409
  // NATIONAL_SEMANTIC_NOT_ENABLED and 503 NATIONAL_SEMANTIC_UNAVAILABLE
  // bodies, the per-jurisdiction 403 tier gate, and the citation routes' 410
  // DOCUMENT_WITHDRAWN all do this. Fall back to it only when nothing else
  // supplied a details object, so it never shadows a real one.
  const strayFields: Record<string, unknown> = {};
  if (typeof j.jurisdiction === 'string') strayFields.jurisdiction = j.jurisdiction;
  if (typeof j.id === 'string') strayFields.id = j.id;
  if (typeof j.withdrawnAt === 'string') strayFields.withdrawnAt = j.withdrawnAt;
  const jurisdictionFallback = Object.keys(strayFields).length ? strayFields : undefined;
  const e = j.error;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const eo = e as Record<string, unknown>;
    return {
      code: typeof eo.code === 'string' ? eo.code : (topCode ?? fallback.code),
      message:
        typeof eo.message === 'string' ? eo.message
          : typeof j.message === 'string' ? j.message
            : fallback.message,
      details: eo.details ?? j.details ?? jurisdictionFallback,
      retryAfter,
      resetsAt,
    };
  }
  // Legacy: `error` is a short sentence ("Invalid API key"), `message` the detail.
  const errStr = typeof e === 'string' ? e : undefined;
  const msg = typeof j.message === 'string' ? j.message : undefined;
  return {
    code: topCode ?? errStr ?? fallback.code,
    message: errStr && msg ? `${errStr}: ${msg}` : (msg ?? errStr ?? fallback.message),
    details: j.details ?? j.usage ?? jurisdictionFallback,
    retryAfter,
    resetsAt,
  };
}

function detailsLine(details: unknown): string {
  if (details === undefined || details === null) return '';
  if (Array.isArray(details)) {
    const items = details.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).slice(0, 10);
    return items.length ? ` Details: ${items.join('; ')}.` : '';
  }
  if (typeof details === 'object') return ` Details: ${JSON.stringify(details)}.`;
  return ` Details: ${String(details)}.`;
}

/**
 * The tool-result text for a failed call. Never includes the API key: the
 * key only travels in a request header and is never part of any message.
 */
export function describeError(err: unknown): string {
  if (err instanceof LexAPITransportError) {
    if (err.cancelled) return 'Cancelled: the client cancelled this request before LexAPI answered.';
    return err.timedOut
      ? `LexAPI did not answer in time (${err.message}). Live EUR-Lex fetches can take longer than an MCP client waits; the call is safe to retry once, and a repeat may be served from the LexAPI corpus. If it keeps timing out, narrow the request (fewer pages, a smaller limit) or raise the client's tool timeout (Claude Code: MCP_TOOL_TIMEOUT) and LEXAPI_TIMEOUT_MS.`
      : `Could not reach LexAPI (${err.message}). Check network access to lex-api.com (or LEXAPI_BASE_URL) and retry.`;
  }
  if (!(err instanceof LexAPIError)) {
    const message = err instanceof Error ? err.message : String(err);
    return `Tool execution failed: ${message}`;
  }

  const head = `LexAPI error ${err.status} (${err.code}): ${err.message.trim().replace(/[.\s]+$/, '')}.`;
  const d = (err.details && typeof err.details === 'object' && !Array.isArray(err.details))
    ? err.details as Record<string, unknown>
    : undefined;

  switch (err.status) {
    case 400:
      return `${head}${detailsLine(err.details)} The request was rejected before any work was done and its credits were refunded. Fix the arguments and call again.`;
    case 401:
      return `${head} The LexAPI API key is missing, wrong, or revoked. Ask the user to check the key configured for this MCP server (LEXAPI_API_KEY, or the Authorization header for the hosted server) or create a new one at ${DASHBOARD_URL}.`;
    case 402: {
      // The monthly allowance of national-law calls for FREE/STARTER/
      // PROFESSIONAL plans (lex-api PR #306) — a separate counter from the
      // credit pool, so the usual "buy a top-up" advice does not apply.
      if (err.code === 'NATIONAL_ALLOWANCE_EXHAUSTED') {
        const parts: string[] = [];
        if (d) {
          if (typeof d.limit === 'number') parts.push(`the monthly allowance is ${d.limit} national-law calls`);
          if (typeof d.resetsAt === 'string') parts.push(`it resets at ${d.resetsAt} (start of next UTC month)`);
        }
        return `${head}${parts.length ? ` (${parts.join(', ')}).` : ''} This is the account's monthly allowance of national-law calls on its plan, not the LexAPI credit pool — a top-up does not help. Tell the user: wait for the reset, or upgrade to BUSINESS or higher, which has no separate national-law limit (${DASHBOARD_URL}, plans: ${PRICING_URL}). Do not retry this call unchanged.`;
      }
      const parts: string[] = [];
      if (d) {
        if (typeof d.weight === 'number') parts.push(`this call needs ${d.weight} credits`);
        if (typeof d.available === 'number') parts.push(`${d.available} are available`);
        if (typeof d.resetsAt === 'string') parts.push(`the monthly pool resets at ${d.resetsAt}`);
      }
      return `${head}${parts.length ? ` (${parts.join(', ')}).` : ''} The account's monthly LexAPI credit pool is exhausted. Tell the user: they can wait for the reset, buy a top-up pack or upgrade at ${DASHBOARD_URL} (plans: ${PRICING_URL}). Cheaper calls may still succeed (e.g. lex_resolve or lex_cites cost 1 credit); do not retry this call unchanged.`;
    }
    case 403:
      return `${head} The account's plan or subscription does not allow this call (not a temporary error — do not retry). Tell the user which feature was refused; plans are compared at ${PRICING_URL}.`;
    case 404: {
      // National 404s take three shapes, none of which point at lex_resolve
      // or lex_search (both EU-only): the typed document-id miss (`details:
      // {id, jurisdiction}`, via the jurisdiction fallback above), the
      // citation-graph id guard (`{"error": "Document not found: <ID>"}`,
      // no code/jurisdiction at all), and a country that is not live yet
      // (falls through every route to the generic `apiNotFound` handler's
      // "Unknown API endpoint" 404 — the jurisdiction path segment never
      // matched, which for a country code can only mean it is unlaunched).
      const isNational = (d && typeof d.jurisdiction === 'string')
        || /^Document not found:/i.test(err.message)
        || /Unknown API endpoint/i.test(err.message);
      if (isNational) {
        return `${head} Not retryable as-is. Either the country is not live yet (call lex_national_coverage to check) or the id is wrong (call lex_list_national_documents).`;
      }
      return `${head} Not retryable as-is. Check the identifier (lex_resolve turns URLs, ELIs and ECLIs into CELEX numbers; lex_search finds documents by title).`;
    }
    case 409:
      // National semantic search not yet enabled for a live country
      // (nationalSemanticController.js unavailableError): a different
      // country, not account state — do not say "tell the user to retry
      // their account", point at the right tools instead.
      if (err.code === 'NATIONAL_SEMANTIC_NOT_ENABLED') {
        const jur = d && typeof d.jurisdiction === 'string' ? d.jurisdiction : 'this country';
        return `${head} Semantic search is not available for ${jur} yet — check semanticSearch in lex_national_coverage's output before retrying. lex_list_national_documents and lex_get_national_document still work there. Not retryable; nothing was charged.`;
      }
      return `${head} The account's current state does not allow this action; tell the user (it is not fixed by retrying).`;
    case 503:
      // National semantic index temporarily down (same source as 409 above).
      if (err.code === 'NATIONAL_SEMANTIC_UNAVAILABLE') {
        const jur = d && typeof d.jurisdiction === 'string' ? d.jurisdiction : 'This country';
        return `${head} ${jur}'s national semantic index is temporarily unavailable; nothing was charged. Retry later, with backoff.`;
      }
      return `${head} LexAPI had a server error; server failures are refunded. Retry once; if it persists, status is at https://lex-api.com/status.`;
    case 429: {
      const wait = err.retryAfterSeconds;
      const resetsAt = err.resetsAt ?? (d && typeof d.resetsAt === 'string' ? d.resetsAt : undefined);
      // QUOTA_EXHAUSTED (lex-api #304) is a used-up legacy quota, whatever
      // else the response carries. Fallback for older servers: the per-minute
      // limiter sends Retry-After / retryAfter, the legacy quotas (daily
      // calls, monthly semantic searches) send neither — only usage.resetsAt.
      // Retrying a quota before it refills is pointless.
      if (err.code === 'QUOTA_EXHAUSTED' || (wait === undefined && (resetsAt || /quota/i.test(`${err.code} ${err.message}`)))) {
        const which = /semantic/i.test(err.message)
          ? 'the monthly semantic-search quota of this (legacy) plan'
          : /daily/i.test(err.message)
            ? 'the daily call quota of this (legacy) plan'
            : 'a usage quota of this plan';
        return `${head} This is ${which}, not a per-minute limit: it is exhausted${resetsAt ? ` until ${resetsAt}` : ''} — do not retry, tell the user. Moving to a credit plan (${PRICING_URL}) removes the quota.`;
      }
      return `${head} Per-minute rate limit of the API key reached.${wait !== undefined ? ` Wait ${wait} s before calling again.` : ' Wait about a minute before calling again.'} Avoid parallel calls; a higher plan raises the per-minute limit (${PRICING_URL}).`;
    }
    case 410: {
      // A national document its source withdrew (lex-api PR #320) — a
      // takedown, a pseudonymisation fix, a robots.txt listing. Served
      // nowhere: no title, no metadata, no text. Two shapes carry it: the
      // typed envelope (lex_get_national_document, details nested) and the
      // legacy shape (citation tools, id/jurisdiction/withdrawnAt as
      // top-level siblings via the fallback above) — `d` covers either.
      if (err.code === 'DOCUMENT_WITHDRAWN') {
        const parts: string[] = [];
        if (d) {
          if (typeof d.id === 'string') parts.push(`id ${d.id}`);
          if (typeof d.jurisdiction === 'string') parts.push(`jurisdiction ${d.jurisdiction}`);
          if (typeof d.withdrawnAt === 'string') parts.push(`withdrawn ${d.withdrawnAt}`);
        }
        return `${head}${parts.length ? ` (${parts.join(', ')}).` : ''} This document was withdrawn by its source and LexAPI serves nothing of it — not even the title. Gone for good, not a temporary failure: do not retry. If you or the user were holding a cached copy, drop it — a withdrawal can be a legal takedown or a pseudonymisation fix, and keeping or re-deriving the content (including trying to identify who it was about) would defeat that. Nothing was charged.`;
      }
      return `${head} Gone. Not retryable; nothing was charged.`;
    }
    case 502:
      return `${head} An upstream service (EUR-Lex or the semantic index) returned an error. Retry later; failed calls are refunded.`;
    case 504:
      return `${head} The upstream fetch timed out. Retry-safe — retry once, or narrow the request (fewer pages, a smaller limit). Failed searches are refunded.`;
    default:
      if (err.status >= 500) {
        return `${head} LexAPI had a server error; server failures are refunded. Retry once; if it persists, status is at https://lex-api.com/status.`;
      }
      return `${head}${detailsLine(err.details)}`;
  }
}
