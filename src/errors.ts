// Error type + the text a model sees when a call fails.
//
// LexAPI answers errors in two shapes (docs.md "Errors & retries"):
//   typed:  { success: false, error: { code, message, details? } }
//   legacy: { error: "slug or sentence", message?, details?, retryAfter?, upgradeUrl?, usage? }
//           — newer servers also send a top-level `code` (e.g. RATE_LIMITED,
//           QUOTA_EXHAUSTED) and, on quota 429s, a top-level `resetsAt`.
//           — the 403 PAYMENT_PAST_DUE body adds `billingUrl` and `accessEndedAt`.
// We normalise both, then turn the status into a message that says what
// happened AND what to do next — the model relays it to the user, so it has
// to be actionable without the model knowing LexAPI's billing rules.

const DASHBOARD_URL = 'https://lex-api.com/dashboard?ref=mcp';
const PRICING_URL = 'https://lex-api.com/pricing?ref=mcp';

/**
 * What a 403 PAYMENT_PAST_DUE body says about the account, as received:
 * strings of bounded length, not yet checked for what they hold.
 * describeError shows a value only after checking it.
 */
export interface PastDueInfo {
  billingUrl?: string;
  accessEndedAt?: string;
  /** Hostname of the API base URL the answer came from; `billingUrl` is shown only on this host. */
  siteHost?: string;
}

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
    /** 403 PAYMENT_PAST_DUE only. */
    public readonly pastDue?: PastDueInfo,
  ) {
    super(message);
    this.name = 'LexAPIError';
  }
}

/** Raised for network failures / timeouts before any HTTP status arrived. */
export class LexAPITransportError extends Error {
  constructor(
    message: string,
    public readonly timedOut: boolean,
    public readonly cancelled = false,
    /** The API answered with a redirect that is not followed: the same call is answered the same way. */
    public readonly redirectRefused = false,
  ) {
    super(message);
    this.name = 'LexAPITransportError';
  }
}

/**
 * The hosted server's OAuth credential could not authenticate a call
 * (token exchange refused / failed, or the API refused the exchanged
 * token). `httpStatus` is what the MCP client is answered when the HTTP
 * response is still uncommitted (src/oauth/upstream.ts); otherwise the
 * model sees describeError's text as a tool error.
 */
export type UpstreamAuthKind = 'invalid_token' | 'insufficient_scope' | 'config' | 'client_auth' | 'unavailable' | 'rate_limited' | 'upstream' | 'api_rejected';

export class UpstreamAuthError extends Error {
  constructor(
    public readonly kind: UpstreamAuthKind,
    public readonly httpStatus: number,
    /** Token-free reason. */
    public readonly description: string,
    public readonly retryAfterSeconds?: number,
    /** `insufficient_scope` only: the scope the refused call needs. */
    public readonly requiredScope?: 'lex:read' | 'lex:webhooks',
  ) {
    super(description);
    this.name = 'UpstreamAuthError';
  }
}

/** Code of the error a tool raises when the API has no such route: the deployment is older than the endpoint. */
export const ENDPOINT_NOT_AVAILABLE = 'ENDPOINT_NOT_AVAILABLE';

/** `error.details.reason` of the API's 404 for a route it does not have (LexAPI API 2.27.0 or later). */
const UNKNOWN_ENDPOINT_REASON = 'unknown_endpoint';

function hasUnknownEndpointReason(details: unknown): boolean {
  return !!details && typeof details === 'object' && !Array.isArray(details)
    && (details as Record<string, unknown>).reason === UNKNOWN_ENDPOINT_REASON;
}

/**
 * Whether a 404 is about the route, not about a document. The API answers
 * an unmatched route with the same code as an unknown document (NOT_FOUND)
 * and marks it with `details.reason: "unknown_endpoint"`; no other 404
 * carries that value. An API older than 2.27.0 sends no such field, so the
 * message prefix is still accepted. A 404 without the typed code did not
 * come from an endpoint either.
 */
export function isUnknownEndpoint(err: unknown): err is LexAPIError {
  return err instanceof LexAPIError && err.status === 404
    && (hasUnknownEndpointReason(err.details)
      || err.code !== 'NOT_FOUND'
      || /^Unknown API endpoint\b/i.test(err.message.trim()));
}

/**
 * The API's own typed 404 for a route it does not have, by its mark alone.
 * Narrower than isUnknownEndpoint: a 404 from a proxy or another server is
 * not one.
 */
export function isMarkedUnknownEndpoint(err: unknown): err is LexAPIError {
  return err instanceof LexAPIError && err.status === 404 && err.code === 'NOT_FOUND' && hasUnknownEndpointReason(err.details);
}

const MAX_BILLING_URL_LENGTH = 300;
const MAX_TIMESTAMP_LENGTH = 40;

/** A domain name: not an IP literal, and no punycode label. */
function isPlainDomain(host: string): boolean {
  return /^[a-z0-9.-]+$/.test(host) && !/^[0-9.]+$/.test(host) && !/(^|\.)xn--/.test(host);
}

/**
 * An absolute https URL in printable ASCII, without credentials, on the
 * host the API was called on (`siteHost`, a domain name); anything else is
 * not shown.
 */
function billingLink(value: unknown, siteHost: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_BILLING_URL_LENGTH) return undefined;
  if (!/^https:\/\/[!-~]+$/.test(value) || /[<>"'`\\()]/.test(value)) return undefined;
  if (typeof siteHost !== 'string' || !isPlainDomain(siteHost)) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname === siteHost ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A UTC instant as the API writes it (`2026-11-25T09:14:03.000Z`; the
 * fraction may be shorter or absent) that names a real date and time;
 * anything else is not shown.
 */
function isoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!m) return undefined;
  const normalised = `${m[1]}.${(m[2] ?? '').padEnd(3, '0')}Z`;
  const t = Date.parse(normalised);
  return !Number.isNaN(t) && new Date(t).toISOString() === normalised ? value : undefined;
}

/** `billingUrl` / `accessEndedAt` of one object, kept only as strings of bounded length. */
function pastDueFields(o: unknown): PastDueInfo | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  const out: PastDueInfo = {};
  if (typeof r.billingUrl === 'string' && r.billingUrl.length <= MAX_BILLING_URL_LENGTH) out.billingUrl = r.billingUrl;
  if (typeof r.accessEndedAt === 'string' && r.accessEndedAt.length <= MAX_TIMESTAMP_LENGTH) out.accessEndedAt = r.accessEndedAt;
  return Object.keys(out).length ? out : undefined;
}

export function parseErrorBody(
  json: unknown,
  rawText: string,
  status: number,
): { code: string; message: string; details?: unknown; retryAfter?: number; resetsAt?: string; pastDue?: PastDueInfo } {
  const fallback = { code: `HTTP_${status}`, message: rawText.trim().slice(0, 300) || `HTTP ${status}` };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fallback;
  const j = json as Record<string, unknown>;
  const retryAfter = typeof j.retryAfter === 'number' ? j.retryAfter : undefined;
  // A top-level string `code` beats the legacy `error` text.
  const topCode = typeof j.code === 'string' && j.code ? j.code : undefined;
  const usage = j.usage && typeof j.usage === 'object' ? j.usage as Record<string, unknown> : undefined;
  const resetsAt = typeof j.resetsAt === 'string' ? j.resetsAt
    : usage && typeof usage.resetsAt === 'string' ? usage.resetsAt
      : undefined;
  // National error bodies carry `jurisdiction` (and, for a withdrawn
  // document, also `id` and `withdrawnAt`) as plain top-level siblings of
  // `error`/`code`/`message`,
  // never nested in `details` — the document-id 404, the 409
  // NATIONAL_SEMANTIC_NOT_ENABLED and 503 NATIONAL_SEMANTIC_UNAVAILABLE
  // bodies, the per-jurisdiction 403 tier gate, and the citation routes' 410
  // DOCUMENT_WITHDRAWN all do this. Fall back to it only when nothing else
  // supplied a details object, so it never shadows a real one.
  const strayFields: Record<string, unknown> = {};
  if (typeof j.jurisdiction === 'string') strayFields.jurisdiction = j.jurisdiction;
  if (typeof j.id === 'string') strayFields.id = j.id;
  if (typeof j.withdrawnAt === 'string') strayFields.withdrawnAt = j.withdrawnAt;
  // The citation routes' legacy 400 INVALID_PARAMS names the parameter and
  // its allowed values at the top level; the national-terms 403 its acceptUrl.
  if (typeof j.param === 'string') strayFields.param = j.param;
  if (Array.isArray(j.allowed)) strayFields.allowed = j.allowed;
  if (typeof j.acceptUrl === 'string') strayFields.acceptUrl = j.acceptUrl;
  // National semantic 503/422: why the search could not be completed.
  if (typeof j.partialReason === 'string') strayFields.partialReason = j.partialReason;
  const jurisdictionFallback = Object.keys(strayFields).length ? strayFields : undefined;
  const e = j.error;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const eo = e as Record<string, unknown>;
    const pastDue = pastDueFields(j) ?? pastDueFields(eo.details);
    return {
      ...(pastDue ? { pastDue } : {}),
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
  // 403 PAYMENT_PAST_DUE: where the invoice is paid and when access ended,
  // read at the top level whatever else the body carries.
  const pastDue = pastDueFields(j);
  return {
    ...(pastDue ? { pastDue } : {}),
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

/** A wait in seconds as shown to a model: more than an hour is not spelt out. */
function waitText(seconds: number): string {
  return seconds > 3600 ? 'more than an hour' : `${seconds} s`;
}

/** The Retry-After of a 5xx, as a model reads it. */
function namedWait(seconds: number): string {
  return `The API names a wait of ${waitText(seconds)}; a retry before it has passed is likely to get the same error.`;
}

/** A 5xx other than the ones with their own text; a Retry-After the API sent is named. */
function serverError(head: string, wait: number | undefined): string {
  return wait !== undefined
    ? `${head} LexAPI had a server error; server failures are refunded. ${namedWait(wait)} If it persists, status is at https://lex-api.com/status.`
    : `${head} LexAPI had a server error; server failures are refunded. Retry once; if it persists, status is at https://lex-api.com/status.`;
}

/** Candidate versions listed in a boundary_unknown 404. */
const MAX_CANDIDATES = 10;

function boundaryUnknown(d: Record<string, unknown>): string {
  const listed = Array.isArray(d.candidates) ? d.candidates : [];
  const shown = listed
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c) && Number.isSafeInteger(c.version) && (c.version as number) >= 1)
    .slice(0, MAX_CANDIDATES)
    .map((c) => {
      const from = isoInstant(c.observedFrom);
      return `version ${c.version as number} (${from ? `observedFrom ${from}` : 'start not recorded'})`;
    });
  const more = d.candidatesTruncated === true || listed.length > shown.length;
  const candidates = shown.length
    ? ` Candidate versions (the stored snapshots it could be): ${shown.join('; ')}${more ? '; more exist, not listed' : ''}. lex_get_document_version reads each by its version number.`
    : ' The API listed no candidate version; lex_document_versions lists the stored versions.';
  return `LexAPI error 404 (NOT_FOUND, boundary_unknown): LexAPI holds this document, but cannot establish which stored snapshot LexAPI held on the requested date, so it returns none. This is not a "document not found" answer.${candidates} This call is refunded in full. Retrying will not help. These are LexAPI's fetch snapshots, not the law in force on a date.`;
}

function beforeTracking(d: Record<string, unknown>): string {
  const since = isoInstant(d.trackedSince);
  const lookup = d.inForceLookup && typeof d.inForceLookup === 'object'
    ? ' For the version of the EU act for a date, lex_legislation_as_of answers.'
    : '';
  return `LexAPI error 404 (NOT_FOUND, before_tracking): LexAPI's history of this document starts ${since ? `at ${since}` : 'after the requested date'}; it holds no snapshot from before then. The document itself is held: lex_document_versions lists its snapshots.${lookup} These snapshots are LexAPI's fetch history, not the law in force on a date. This answer costs 1 credit.`;
}

/**
 * The tool-result text for a failed call. Never includes the API key: the
 * key only travels in a request header and is never part of any message.
 */
export function describeError(err: unknown): string {
  if (err instanceof LexAPITransportError) {
    if (err.cancelled) return 'Cancelled: the client cancelled this request before LexAPI answered.';
    if (err.redirectRefused) {
      return `Redirect not followed: ${err.message}. The same call is answered the same way, so it is not retryable. Where this server is run with LEXAPI_BASE_URL set, that value must be the API's own address (default https://lex-api.com/api/v1).`;
    }
    return err.timedOut
      ? `LexAPI did not answer in time (${err.message}). Live EUR-Lex fetches can take longer than an MCP client waits; the call is safe to retry once, and a repeat may be served from the LexAPI corpus. If it keeps timing out, narrow the request (fewer pages, a smaller limit) or raise the client's tool timeout (Claude Code: MCP_TOOL_TIMEOUT) and LEXAPI_TIMEOUT_MS.`
      : `Could not reach LexAPI (${err.message}). Check network access to lex-api.com (or LEXAPI_BASE_URL) and retry.`;
  }
  if (err instanceof UpstreamAuthError) {
    switch (err.kind) {
      case 'invalid_token':
        return `LexAPI sign-in expired or was revoked (${err.description}). Reconnecting LexAPI in the MCP client (signing in again) restores access; retrying with the same sign-in does not.`;
      case 'insufficient_scope':
        return `This LexAPI connection is not permitted to do this (${err.description}). Reconnecting LexAPI in the MCP client and allowing that access adds it; retrying with the same sign-in does not.`;
      case 'rate_limited':
        return `LexAPI sign-in is rate limited right now.${err.retryAfterSeconds !== undefined ? ` Wait ${err.retryAfterSeconds} s before calling again.` : ' Wait a little before calling again.'}`;
      case 'upstream':
        return `LexAPI sign-in could not be checked right now (${err.description}). Retry in a minute; if it persists, status is at https://lex-api.com/status.`;
      case 'api_rejected':
        return `LexAPI refused this connection's access (${err.description}). Disconnecting and reconnecting LexAPI in the MCP client may fix it; otherwise support@lex-api.com can help.`;
      default:
        return `LexAPI sign-in is temporarily unavailable on this server (${err.kind}). This is not the user's fault and signing in again will not help; retry later or use an API key (https://lex-api.com/dashboard?ref=mcp).`;
    }
  }
  if (!(err instanceof LexAPIError)) {
    const message = err instanceof Error ? err.message : String(err);
    return `Tool execution failed: ${message}`;
  }

  // A legacy body without a code repeats its `error` slug as the code
  // ("Upgrade required: Upgrade required: …"): it is printed once.
  let shownMessage = err.message.trim().replace(/[.\s]+$/, '');
  while (shownMessage.startsWith(`${err.code}: `)) shownMessage = shownMessage.slice(err.code.length + 2).trim();
  if (shownMessage === err.code) shownMessage = '';
  const head = shownMessage ? `LexAPI error ${err.status} (${err.code}): ${shownMessage}.` : `LexAPI error ${err.status} (${err.code}).`;
  const d = (err.details && typeof err.details === 'object' && !Array.isArray(err.details))
    ? err.details as Record<string, unknown>
    : undefined;

  switch (err.status) {
    case 400:
      return `${head}${detailsLine(err.details)} The request was rejected before any work was done and its credits were refunded. Fix the arguments and call again.`;
    case 401:
      return `${head} The LexAPI API key is missing, wrong, or revoked. Check the key configured for this MCP server (LEXAPI_API_KEY, or the Authorization header for the hosted server), or create a new one at ${DASHBOARD_URL}.`;
    case 402: {
      // The monthly allowance of national-law calls for FREE/STARTER/
      // PROFESSIONAL plans — a separate counter from the
      // credit pool, so the usual "buy a top-up" advice does not apply.
      if (err.code === 'NATIONAL_ALLOWANCE_EXHAUSTED') {
        const parts: string[] = [];
        if (d) {
          if (typeof d.limit === 'number') parts.push(`the monthly allowance is ${d.limit} national-law calls`);
          if (typeof d.resetsAt === 'string') parts.push(`it resets at ${d.resetsAt} (start of next UTC month)`);
        }
        return `${head}${parts.length ? ` (${parts.join(', ')}).` : ''} This is the account's monthly allowance of national-law calls on its plan, not the LexAPI credit pool — a top-up does not help. The allowance resets at the start of each UTC month; BUSINESS and higher plans have no separate national-law limit (${DASHBOARD_URL}, plans: ${PRICING_URL}). Not retryable unchanged.`;
      }
      const parts: string[] = [];
      if (d) {
        if (typeof d.weight === 'number') parts.push(`this call needs ${d.weight} credits`);
        if (typeof d.available === 'number') parts.push(`${d.available} are available`);
        if (typeof d.resetsAt === 'string') parts.push(`the monthly pool resets at ${d.resetsAt}`);
      }
      return `${head}${parts.length ? ` (${parts.join(', ')}).` : ''} The account's monthly LexAPI credit pool is exhausted. Options: wait for the reset, buy a top-up pack or upgrade at ${DASHBOARD_URL} (plans: ${PRICING_URL}). Cheaper calls may still succeed (e.g. lex_resolve or lex_cites cost 1 credit); this call is not retryable unchanged.`;
    }
    case 403:
      if (err.code === 'NATIONAL_TERMS_NOT_ACCEPTED') {
        const url = d && typeof d.acceptUrl === 'string' ? ` (${d.acceptUrl})` : '';
        return `${head} The account must accept the national-source terms once in the LexAPI dashboard${url} before national documents are served; retrying before that does not help. Nothing was charged.`;
      }
      // A failed subscription payment that was not completed in time: every
      // request is refused until it succeeds. Not a plan question, so no
      // pricing pointer; the API's own sentence is not repeated.
      if (err.code === 'PAYMENT_PAST_DUE') {
        const ended = isoInstant(err.pastDue?.accessEndedAt);
        const billing = billingLink(err.pastDue?.billingUrl, err.pastDue?.siteHost);
        return `LexAPI error 403 (PAYMENT_PAST_DUE): Payment past due. A subscription payment for this account failed, so LexAPI refuses every API request from it until the payment succeeds${ended ? ` (access ended at ${ended})` : ''}; no LexAPI content was returned. Access returns when the open invoice is paid: the account holder pays it, or updates the card, in the LexAPI dashboard (${billing ?? DASHBOARD_URL}). Not retryable until then, with this or any other LexAPI tool; no credits were charged for this call.`;
      }
      return `${head} The account's plan or subscription does not allow this call (not a temporary error; not retryable). No credits were charged. Plans are compared at ${PRICING_URL}.`;
    case 404: {
      if (err.code === ENDPOINT_NOT_AVAILABLE) return `${head} The same call is answered the same way until the API is updated, so it is not retryable.`;
      // The snapshot-on-a-date route (LexAPI API 2.28.0): the document is
      // held, but no snapshot answers the date. Not a missing document.
      if (err.code === 'NOT_FOUND' && d?.reason === 'boundary_unknown') return boundaryUnknown(d);
      if (err.code === 'NOT_FOUND' && d?.reason === 'before_tracking') return beforeTracking(d);
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
        || /Unknown API endpoint/i.test(err.message)
        || hasUnknownEndpointReason(d);
      if (isNational) {
        // "Unknown API endpoint" is the generic 404 for ANY unmatched route,
        // not only an unlaunched country — these tools only ever build
        // known routes, so that's the near-certain cause here, but the
        // hedge keeps the message honest if that ever changes.
        return `${head} Not retryable as-is. Likely either the country is not live yet (call lex_national_coverage to check) or the id is wrong (call lex_list_national_documents). A not-found answer costs at most 1 credit.`;
      }
      return `${head} Not retryable as-is. Check the identifier (lex_resolve turns URLs, ELIs and ECLIs into CELEX numbers; lex_search finds documents by title). A not-found answer costs at most 1 credit.`;
    }
    case 409:
      // National semantic search not yet enabled for a live country: a different
      // country, not account state — do not say "tell the user to retry
      // their account", point at the right tools instead.
      if (err.code === 'NATIONAL_SEMANTIC_NOT_ENABLED') {
        const jur = d && typeof d.jurisdiction === 'string' ? d.jurisdiction : 'this country';
        return `${head} Semantic search is not available for ${jur} yet — check semanticSearch in lex_national_coverage's output before retrying. lex_list_national_documents and lex_get_national_document still work there. Not retryable; nothing was charged.`;
      }
      return `${head} The account's current state does not allow this action (not fixed by retrying).`;
    case 503:
      // National semantic index temporarily down (same source as 409 above).
      if (err.code === 'NATIONAL_SEMANTIC_UNAVAILABLE') {
        const jur = d && typeof d.jurisdiction === 'string' ? d.jurisdiction : 'This country';
        // The index could not complete this search and had nothing left to
        // return: an empty answer would not have meant "no matches".
        if (d && d.partialReason === 'SEARCH_INCOMPLETE') {
          const wait = err.retryAfterSeconds;
          return wait !== undefined
            ? `${head} ${jur}'s national semantic index could not complete this search and had nothing to return — this is NOT a "no matches" answer; nothing was charged. Retry after ${waitText(wait)}.`
            : `${head} ${jur}'s national semantic index has repeatedly been unable to complete this search — this is NOT a "no matches" answer; nothing was charged. An immediate retry is unlikely to help; try again later, or rephrase or narrow the query.`;
        }
        return `${head} ${jur}'s national semantic index is temporarily unavailable; nothing was charged. Retry later, with backoff.`;
      }
      // lex_counterparts past its server-side budget (legacy shape, refunded).
      if (err.code === 'TIMEOUT') {
        return `${head} The lookup ran out of its server-side time budget; nothing was charged. Narrow it with jurisdictions, or retry later.`;
      }
      return serverError(head, err.retryAfterSeconds);
    case 422:
      // The national index cannot search this slice completely and had
      // nothing left to return; the same request gets the same answer.
      if (err.code === 'NATIONAL_SEMANTIC_FILTER_UNREACHABLE') {
        const jur = d && typeof d.jurisdiction === 'string' ? d.jurisdiction : 'this country';
        return `${head} The national semantic index for ${jur} cannot search this slice (country, document kind, filters) completely and had nothing to return — this is NOT a "no matches" answer; nothing was charged. Retrying the same call will not help: rephrase the query, or change or drop the filters.`;
      }
      return `${head}${detailsLine(err.details)}`;
    case 429: {
      const wait = err.retryAfterSeconds;
      const resetsAt = err.resetsAt ?? (d && typeof d.resetsAt === 'string' ? d.resetsAt : undefined);
      // QUOTA_EXHAUSTED is a used-up legacy quota, whatever
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
        return `${head} This is ${which}, not a per-minute limit: it is exhausted${resetsAt ? ` until ${resetsAt}` : ''} — not retryable until then. Moving to a credit plan (${PRICING_URL}) removes the quota.`;
      }
      return `${head} Per-minute rate limit of the API key reached.${wait !== undefined ? ` Wait ${waitText(wait)} before calling again.` : ' Wait about a minute before calling again.'} Parallel calls count against the same limit; a higher plan raises the per-minute limit (${PRICING_URL}).`;
    }
    case 410: {
      // A national document its source withdrew — a
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
        return `${head}${parts.length ? ` (${parts.join(', ')}).` : ''} This document was withdrawn by its source and LexAPI serves nothing of it — not even the title. Gone for good, not a temporary failure; not retryable. A withdrawal can be a legal takedown or a pseudonymisation fix, so cached copies of the content should not be kept or re-derived. LexAPI's Terms prohibit re-identifying people in anonymised or pseudonymised decisions. Nothing was charged.`;
      }
      return `${head} Gone. Not retryable; nothing was charged.`;
    }
    case 502:
      return err.retryAfterSeconds !== undefined
        ? `${head} An upstream service (EUR-Lex or the semantic index) returned an error; failed calls are refunded. ${namedWait(err.retryAfterSeconds)}`
        : `${head} An upstream service (EUR-Lex or the semantic index) returned an error. Retry later; failed calls are refunded.`;
    case 504:
      return `${head} The upstream fetch timed out. Retry-safe — retry once, or narrow the request (fewer pages, a smaller limit). Failed searches are refunded.`;
    default:
      if (err.status >= 500) return serverError(head, err.retryAfterSeconds);
      return `${head}${detailsLine(err.details)}`;
  }
}
