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
  const e = j.error;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const eo = e as Record<string, unknown>;
    return {
      code: typeof eo.code === 'string' ? eo.code : (topCode ?? fallback.code),
      message:
        typeof eo.message === 'string' ? eo.message
          : typeof j.message === 'string' ? j.message
            : fallback.message,
      details: eo.details ?? j.details,
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
    details: j.details ?? j.usage,
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
    case 404:
      return `${head} Not retryable as-is. Check the identifier (lex_resolve turns URLs, ELIs and ECLIs into CELEX numbers; lex_search finds documents by title).`;
    case 409:
      return `${head} The account's current state does not allow this action; tell the user (it is not fixed by retrying).`;
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
