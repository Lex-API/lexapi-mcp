// Workflow tools: each does one common job with a few of the API calls the
// other tools make one at a time. Rules they share:
//   - every value in a result comes from an API answer, except two computed
//     from such values: onDate.status and celexYear. A value the API did
//     not return is reported as "unknown" (or "not_reported"), never filled in;
//   - a call that fails is named in the result with its reason, and the rest
//     of the result is still returned;
//   - once the credit pool or the rate limit is exhausted no further call is
//     started;
//   - all calls of one tool call share that call's deadline.

import { describeError, isMarkedUnknownEndpoint, isUnknownEndpoint, LexAPIError, LexAPITransportError } from './errors.js';
import {
  compact,
  consolidatedBaseOf,
  creditNotice,
  isObj,
  nationalAllowanceOf,
  shapeCaseLawHit,
  shapeLegislationHit,
  shapeMetadata,
  shapeNationalCaseLawHit,
  shapeNationalLegislationHit,
  truncate,
} from './shape.js';

import type { Json, LexAPIClient, LexResponse } from './client.js';

type Obj = Record<string, unknown>;

// ── Failures ───────────────────────────────────────────────────────
export type FailureReason =
  | 'credits_exhausted' | 'national_allowance_exhausted' | 'rate_limited' | 'quota_exhausted'
  | 'plan' | 'payment_past_due' | 'terms_not_accepted' | 'not_found' | 'withdrawn' | 'semantic_not_enabled'
  | 'search_incomplete' | 'timeout' | 'upstream_error' | 'network' | 'rejected'
  | 'not_live' | 'not_listed' | 'unconfirmed_not_found' | 'unreadable_response' | 'different_document';

interface Failure {
  reason: FailureReason;
  error: string;
  retryAfterSeconds?: number;
  /** The error as thrown, for the full text when it ends the tool call. */
  cause?: unknown;
  /** Every later call of the same tool call would end the same way, whatever its reason. */
  stopsAll?: boolean;
}

/** After one of these, a later call of the same tool call cannot succeed either. */
const STOPS_ALL = new Set<FailureReason>(['credits_exhausted', 'rate_limited', 'quota_exhausted', 'payment_past_due']);

/**
 * What a failed call means for the result. Errors that are not an API answer
 * about this one call (sign-in, a bad key, cancellation, a bug) are thrown:
 * they end the tool call.
 */
/** A 404 for a route the API does not have, not an answer about a document (a boolean, so the caller's type is not narrowed). */
function routeMissing(err: LexAPIError): boolean {
  return isUnknownEndpoint(err);
}

function failureOf(err: unknown): Failure {
  if (err instanceof LexAPITransportError && !err.cancelled) {
    // LexAPI was reached and answered, with something that cannot be used; the next call is answered the same way.
    if (err.redirectRefused) return { reason: 'upstream_error', error: `Redirect not followed: ${err.message}`, cause: err, stopsAll: true };
    return err.timedOut
      ? { reason: 'timeout', error: `LexAPI did not answer in time (${err.message})`, cause: err }
      : { reason: 'network', error: `LexAPI could not be reached (${err.message})`, cause: err };
  }
  if (!(err instanceof LexAPIError) || err.status === 401) throw err;
  // A failed subscription payment: every request is refused until it
  // succeeds. The text is describeError's, not the API's message: the
  // address in it is shown only after it was checked.
  if (err.status === 403 && err.code === 'PAYMENT_PAST_DUE') {
    return { reason: 'payment_past_due', error: describeError(err), cause: err };
  }
  // A route the API does not have (for example a LEXAPI_BASE_URL with the
  // wrong path): the API's NOT_FOUND code, but not an answer about a document.
  if (routeMissing(err)) {
    return {
      reason: 'unconfirmed_not_found',
      error: `LexAPI error 404 (${err.code}): This LexAPI deployment does not offer this endpoint (check LEXAPI_BASE_URL). The same call is answered the same way, so it is not retryable`,
      cause: err,
    };
  }
  const d = isObj(err.details) ? err.details : {};
  const reason: FailureReason =
    err.status === 402 ? (err.code === 'NATIONAL_ALLOWANCE_EXHAUSTED' ? 'national_allowance_exhausted' : 'credits_exhausted')
      : err.status === 429 ? (err.code === 'QUOTA_EXHAUSTED' || (err.retryAfterSeconds === undefined && err.resetsAt) ? 'quota_exhausted' : 'rate_limited')
        : err.status === 403 ? (err.code === 'NATIONAL_TERMS_NOT_ACCEPTED' ? 'terms_not_accepted' : 'plan')
          // Only the API's own NOT_FOUND is an answer about the document.
          : err.status === 404 ? (err.code === 'NOT_FOUND' ? 'not_found' : 'unconfirmed_not_found')
            : err.status === 410 ? 'withdrawn'
              : err.status === 409 && err.code === 'NATIONAL_SEMANTIC_NOT_ENABLED' ? 'semantic_not_enabled'
                : err.status === 422 || d.partialReason === 'SEARCH_INCOMPLETE' ? 'search_incomplete'
                  : err.status === 504 ? 'timeout'
                    : err.status >= 500 ? 'upstream_error'
                      : 'rejected';
  return compact({
    reason,
    error: `LexAPI error ${err.status} (${err.code}): ${err.message.trim().replace(/[.\s]+$/, '')}`,
    retryAfterSeconds: err.retryAfterSeconds,
    cause: err,
  }) as unknown as Failure;
}

/** The part of a failure shown in a result. */
function shown(f: Failure): Obj {
  return compact({ reason: f.reason, error: f.error, retryAfterSeconds: f.retryAfterSeconds });
}

// ── Calls of one tool call ─────────────────────────────────────────
/** No call is started with less than this left of the tool call's deadline. */
const MIN_CALL_MS = 3000;

type Outcome = { res: LexResponse<Json>; failure?: undefined } | { res?: undefined; failure: Failure; notRun?: boolean };

class Calls {
  private readonly end: number;
  /** Set once the credit pool or the rate limit is exhausted, a payment is past due, or a redirect was not followed. */
  stopped?: Failure;
  succeeded = 0;
  private lowest: { remaining: number; body: unknown } | undefined;
  private allowanceSeen: Obj | undefined;

  constructor(private readonly client: LexAPIClient) {
    this.end = Date.now() + client.timeout;
  }

  async run(fn: (c: LexAPIClient) => Promise<LexResponse<Json>>): Promise<Outcome> {
    if (this.stopped) {
      const how = this.stopped.stopsAll ? 'was answered with a redirect that is not followed' : `ended with ${this.stopped.reason}`;
      return { notRun: true, failure: { reason: this.stopped.reason, error: `not run: an earlier call of this tool call ${how}` } };
    }
    const left = this.end - Date.now();
    if (left < MIN_CALL_MS) {
      return { notRun: true, failure: { reason: 'timeout', error: 'not run: the time available to this tool call was used up' } };
    }
    try {
      const res = await fn(this.client.forCall({ timeoutMs: left }));
      this.succeeded++;
      this.note(res);
      return { res };
    } catch (err) {
      const failure = failureOf(err);
      if (STOPS_ALL.has(failure.reason) || failure.stopsAll) this.stopped ??= failure;
      return { failure };
    }
  }

  /**
   * A call whose answer must be an object carrying a list under `key`. An
   * empty body, a page that is not JSON, `success: false` or a missing list
   * is a failed call, never an empty list.
   */
  async runList(key: string, fn: (c: LexAPIClient) => Promise<LexResponse<Json>>): Promise<Outcome> {
    const r = await this.run(fn);
    if (r.failure) return r;
    const b: unknown = r.res.body;
    if (isObj(b) && b.success !== false && Array.isArray(b[key])) return r;
    return { failure: { reason: 'unreadable_response', error: `the answer was not readable: it carried no ${key} list` } };
  }

  private note(res: LexResponse<Json>): void {
    const credits = isObj(res.body) && isObj(res.body.credits) ? res.body.credits : undefined;
    if (credits && typeof credits.remaining === 'number' && (!this.lowest || credits.remaining < this.lowest.remaining)) {
      this.lowest = { remaining: credits.remaining, body: res.body };
    }
    const allowance = nationalAllowanceOf(res.headers);
    if (allowance && (!this.allowanceSeen || Number(allowance.remaining) <= Number(this.allowanceSeen.remaining ?? Infinity))) {
      this.allowanceSeen = allowance;
    }
  }

  /** The low-credit notice and the national allowance, as the other tools attach them. */
  footer(): Obj {
    return compact({ allowance: this.allowanceSeen, notice: this.lowest ? creditNotice(this.lowest.body) : undefined });
  }
}

/** The error to throw when a tool call obtained nothing: the API error as it was. */
function asThrown(f: Failure): unknown {
  return f.cause ?? new Error(f.error);
}

// ── Identifiers ────────────────────────────────────────────────────
// A national id: a two-letter country code, a hyphen, then whatever the
// source's own identifier holds (letters of any alphabet included). "EU-…" is
// not one. Which codes are countries is the API's answer, not this pattern's.
// The citation-graph tools check their ids with the same pattern.
// An id is checked and sent in its composed form (NFC): the API compares ids
// as strings, and stores "Ä" as one character, not as "A" and a combining mark.
export const NATIONAL_ID_RE = /^[A-Za-z]{2}-[\p{L}\p{N}()./_:+-]+$/u;
export function isNationalId(identifier: string): boolean {
  const t = identifier.trim().normalize('NFC');
  return NATIONAL_ID_RE.test(t) && !/^EU-/i.test(t);
}
/** Sector, year, type letters, number: what is sent as a CELEX without resolving. */
const CELEX_SHAPE_RE = /^[0-9CE]\d{4}[A-Z]{1,2}\d[0-9A-Z()._-]*$/;

/** A token that starts with a sector digit: sent as a CELEX as it is, so a mistyped one is answered by the read. */
const LOOSE_CELEX_RE = /^\d[0-9A-Z()._-]{4,}$/;

/**
 * A tag after a CELEX number that names a summary or another rendition of the
 * same work (`_SUM`, `_RES`). The API's resolver answers with the CELEX
 * without it.
 */
const VARIANT_TAG_RE = /_[A-Z]{2,4}$/;

/** The CELEX without such a tag, when what remains is still a CELEX; otherwise as given. */
function withoutVariantTag(celex: string): string {
  const untagged = celex.replace(VARIANT_TAG_RE, '');
  return untagged !== celex && (CELEX_SHAPE_RE.test(untagged) || LOOSE_CELEX_RE.test(untagged)) ? untagged : celex;
}

function withoutTagNote(celex: string, untagged: string): string {
  return `the CELEX as given, without its ${celex.slice(untagged.length)} tag (a summary or rendition of the same document)`;
}

function upperCelex(v: string): string {
  return v.trim().replace(/^(?:uri=)?CELEX[:/]\s*/i, '').toUpperCase();
}

/** The year in a CELEX number; none for a corrigendum, whose number is that of the corrected act. */
function celexYear(celex: string): number | undefined {
  if (/R\(\d+\)$/.test(celex)) return undefined;
  const m = /^[1-9](\d{4})[A-Z]/.exec(celex);
  return m ? Number(m[1]) : undefined;
}

const IN_FORCE_UNKNOWN = 'No in-force status was returned for this document: none is recorded, the document type has none, or the API version does not report it.';

const IN_FORCE_CONTRADICTORY = 'The in-force fields returned contradict each other (inForce and notInForceReason), so no status is reported.';

/** inForce as the API gave it, or "unknown"; with the fields that qualify it. */
function inForceOf(o: Obj): Obj {
  if (typeof o.inForce !== 'boolean') return { inForce: 'unknown' };
  // The API sends a reason with every false and never with a true.
  const reason = typeof o.notInForceReason === 'string' && o.notInForceReason ? o.notInForceReason : undefined;
  if (o.inForce === (reason !== undefined)) return { inForce: 'unknown', inForceNote: IN_FORCE_CONTRADICTORY };
  return compact({
    inForce: o.inForce,
    notInForceReason: o.notInForceReason,
    endOfValidity: o.endOfValidity,
    entryIntoForce: o.entryIntoForce,
  });
}

function consolidatedPointers(md: Obj): Obj {
  const ta = isObj(md.textAvailability) ? md.textAvailability : {};
  return compact({
    latestConsolidated: md.latestConsolidated ?? ta.latestConsolidated,
    upcomingConsolidated: md.upcomingConsolidated ?? ta.upcomingConsolidated,
    newestConsolidated: md.newestConsolidated ?? ta.newestConsolidated,
  });
}

/** A date compared with the dates the API returned for a document. */
function onDate(date: string, known: { documentDate?: unknown; entryIntoForce?: unknown; lastDayInForce?: unknown }): Obj {
  const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
  const doc = iso(known.documentDate);
  const start = iso(known.entryIntoForce);
  const end = iso(known.lastDayInForce);
  if (doc && date < doc) return { date, status: 'before_document_date', documentDate: doc };
  if (start && date < start) return { date, status: 'before_entry_into_force', entryIntoForce: start };
  if (end && date > end) return { date, status: 'after_end_of_validity', endOfValidity: end };
  return {
    date,
    status: 'unknown',
    note: 'The dates returned do not show whether the document was in force on this date.',
  };
}

// ── lex_check_citation ─────────────────────────────────────────────
export interface CheckArgs { identifier: string; article?: string; date?: string }

type Carried = { doc: Obj; problem?: undefined } | { doc?: undefined; problem: { reason: FailureReason; note: string } };

/**
 * The document an answer carries, when the answer is readable and is about
 * the document asked for. Anything else is not evidence that it exists.
 */
function carriedDocument(body: unknown, key: 'metadata' | 'document', requested: string, idKeys: string[], alsoAccepted?: string): Carried {
  const doc = isObj(body) && body.success !== false && isObj(body[key]) ? body[key] : undefined;
  const raw = doc ? idKeys.map((k) => doc[k]).find((v) => typeof v === 'string' && v.trim()) : undefined;
  if (!doc || typeof raw !== 'string') {
    return { problem: { reason: 'unreadable_response', note: `The answer carried no document with an identifier, so it does not show whether ${requested} exists.` } };
  }
  const returned = raw.trim().toUpperCase();
  if (returned !== requested && returned !== alsoAccepted) {
    return { problem: { reason: 'different_document', note: `${requested} was asked for and the answer is about ${returned}; nothing from it is reported.` } };
  }
  return { doc };
}

const CELEX_KEYS = ['celex', 'celexNumber'];

interface ArticleRef { number: string; rest?: string }

/**
 * "Art. 17", "Article 17(1)", "art_17", "6a", "017" → the article number the
 * API matches on, plus the paragraph or point part, which is not looked up.
 * Undefined for a form that cannot be mapped to one article number (an
 * ordinal, an annex, a list).
 */
export function parseArticle(v: string): ArticleRef | undefined {
  const t = v.trim().toLowerCase().replace(/^art(?:icle|\.)?[\s_]*/, '');
  const m = /^0*(\d+)([a-z]{0,2})(?![a-z0-9])\s*(.*)$/.exec(t);
  if (!m || ['st', 'nd', 'rd', 'th'].includes(m[2])) return undefined;
  const rest = m[3].trim();
  if (rest && !/^(?:\(|[,.;]?\s*(?:§|para|point|pt\b|lit\b|subpara|sentence))/.test(rest)) return undefined;
  const number = `${m[1]}${m[2]}`;
  return rest ? { number, rest } : { number };
}

// National unit numbers ("§ 5", "Art. 5", "Artikel 2", "5. člen"): a label,
// one number with an optional letter, and nothing else. Labels fall in two
// classes, so "§ 2" and "Artikel 2" of one document are told apart.
const UNIT_LABELS: Record<string, 'section' | 'article'> = {
  '§': 'section', paragraph: 'section', paragraf: 'section', par: 'section',
  article: 'article', artikel: 'article', articulo: 'article', articolo: 'article', artigo: 'article', art: 'article', clen: 'article', cl: 'article',
};
/** Words that open a paragraph, point or sentence inside a unit: not looked up. */
const SUBDIVISION_RE = /^(?:\(|(?:abs|absatz|z|ziff|ziffer|zif|lit|litera|satz|nr|nummer|odst|odstavec|odstavek|pism|pismeno|tocka|para|paragraph|point|pt|punkt|pkt|ust|ustep|lid|onder|sub|apartado|numero|num|comma|lett|lettera|al|alinea|alineja|sentence|subpara|halbsatz|unterabs|unterabsatz)\b)/;

interface UnitRef { label?: 'section' | 'article'; number: string; rest?: string }

/**
 * Lower case, without accents and without ordinal marks ("1.º", "2ª" → "1.",
 * "2"). Canonical decomposition only: a superscript, a fraction or a ligature
 * stays what it is, so it is never read as a digit or a letter.
 */
function plain(v: unknown): string {
  return String(v ?? '').replace(/[ºª°]/g, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * One national unit reference → its label class, number and the part after
 * it. Undefined when it is not one unit: an unknown label, a list, a range,
 * or a remainder that is not a paragraph or point. An inserted unit written
 * "42.a" is number 42a.
 */
export function parseUnit(v: unknown): UnitRef | undefined {
  let t = plain(v);
  let label: UnitRef['label'];
  const lead = /^(§+|[a-z]+)\.?\s*(?=\d)/.exec(t);
  if (lead) {
    label = UNIT_LABELS[lead[1]];
    if (!label) return undefined; // "§§", "Anl.", "Annex": not one article or section
    t = t.slice(lead[0].length);
  }
  const m = /^0*(\d+)(?:\.?([a-z]))?(?![a-z0-9])\s*(.*)$/.exec(t);
  if (!m) return undefined;
  let rest = m[3].trim();
  // "5. člen": the label after the number.
  const tail = /^\.?\s*(clen|cl)\b\.?\s*/.exec(rest);
  if (tail && !label) {
    label = 'article';
    rest = rest.slice(tail[0].length).trim();
  }
  const number = `${m[1]}${m[2] ?? ''}`;
  // "1." and "§ 5.": an ordinal dot closing the number.
  if (!rest || rest === '.') return { label, number };
  const sub = rest.replace(/^[,;.]\s*(?=[a-z(])/, '');
  if (!SUBDIVISION_RE.test(sub)) return undefined;
  return { label, number, rest };
}

/** "Art. 1 § 3" → its parts, when the whole string is two or more labelled numbers. */
function parseComposite(v: unknown): UnitRef[] | undefined {
  const t = plain(v);
  const parts: UnitRef[] = [];
  let at = 0;
  const re = /\s*[,;]?\s*(§|[a-z]+)\.?\s*0*(\d+)(?:\.?([a-z]))?(?![a-z0-9])/y;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(t);
    if (!m) break;
    const label = UNIT_LABELS[m[1]];
    if (!label) return undefined;
    parts.push({ label, number: `${m[2]}${m[3] ?? ''}` });
    at = re.lastIndex;
  }
  return parts.length >= 2 && !t.slice(at).trim() ? parts : undefined;
}

interface StoredUnit { index: number; raw: string; single?: UnitRef; parts?: UnitRef[]; numbers: number[]; open: boolean }

function storedUnit(v: unknown, index: number): StoredUnit {
  const raw = String(v ?? '');
  const t = plain(v);
  const one = parseUnit(v);
  const single = one && !one.rest ? one : undefined;
  const parts = single ? undefined : parseComposite(v);
  const first = /^(§+|[a-z]+)/.exec(t)?.[1] ?? '';
  return {
    index,
    raw,
    single,
    parts,
    numbers: [...t.matchAll(/\d+/g)].map((m) => Number(m[0])),
    // A label without a number read from it ("Artikel II", "Article premier"),
    // or a roman numeral alone: it may stand for any number.
    open: !single && !parts && (/^§/.test(t) || first in UNIT_LABELS || /^[ivxlcdm]+\.?$/.test(t)) && !/\d/.test(t),
  };
}

export interface UnitMatch { found: true | false | 'unknown'; index?: number; count?: number; rest?: string; note?: string }

const quoted = (units: StoredUnit[]) => [...new Set(units.map((u) => `"${u.raw}"`))].slice(0, 5).join(', ');
const sameLabel = (a: UnitRef, b: UnitRef) => a.label === undefined || b.label === undefined || a.label === b.label;

/**
 * Look one requested unit up among a document's unit numbers. found: true
 * only for a unit of that number and label; found: false only when no unit,
 * read or not, could carry the number; "unknown" otherwise.
 */
export function matchUnit(requested: string, numbers: unknown[]): UnitMatch {
  const stored = numbers.map(storedUnit);
  const singles = stored.filter((u) => u.single);
  const example = singles.length ? `"${singles[0].raw}"` : `"${stored[0]?.raw ?? ''}"`;
  const want = parseUnit(requested);
  if (!want) {
    // A reference written exactly as the document writes one of its units ("Art. 1 § 3").
    const key = (v: unknown) => plain(v).replace(/[\s.]+/g, ' ').trim();
    const same = stored.filter((u) => key(u.raw) && key(u.raw) === key(requested));
    if (same.length) return { found: true, index: same[0].index, count: same.length };
    return { found: 'unknown', note: `This form could not be read as one unit (one number, with a paragraph or point at most; not a list or a range), so nothing was compared. The document's units are written like ${example}.` };
  }
  const n = parseInt(want.number, 10);
  const numbered = singles.filter((u) => u.single?.number === want.number);
  const labels = new Set(numbered.map((u) => u.single?.label));
  // Units stored under another unit ("Art. 1 § 3") that carry this number.
  const nested = stored.filter((u) => u.parts?.some((p) => p.number === want.number && sameLabel(p, want)));
  // Units that were not read as one number but may hold it: the number among
  // their digits, a range around it, or no number at all after a label.
  const unread = stored.filter((u) => !u.single && !u.parts
    && (u.open || u.numbers.includes(n) || (u.numbers.length >= 2 && Math.min(...u.numbers) <= n && n <= Math.max(...u.numbers))));
  const matches = want.label === undefined
    ? (labels.size === 1 ? numbered : [])
    : numbered.filter((u) => u.single?.label === want.label).length
      ? numbered.filter((u) => u.single?.label === want.label)
      // A unit stored without a label, unless a sibling of that number carries another label.
      : labels.size === 1 ? numbered.filter((u) => u.single?.label === undefined) : [];

  if (nested.length) {
    return { found: 'unknown', note: `This document numbers units inside other units (${quoted(nested)}), so "${requested}" does not name one unit.` };
  }
  if (matches.length) return { found: true, index: matches[0].index, count: matches.length, rest: want.rest };
  if (numbered.length) {
    return {
      found: 'unknown',
      note: want.label === undefined
        ? `Number ${want.number} is carried by units with different labels (${quoted(numbered)}), so the one meant could not be told.`
        : labels.has(undefined)
          ? `Number ${want.number} is written ${quoted(numbered)} here, without the label asked for and under another one, so the unit meant could not be told.`
          : `Number ${want.number} is written ${quoted(numbered)} here, under another label than the one asked for; the two labels number different units.`,
    };
  }
  if (unread.length) {
    return { found: 'unknown', note: `No unit numbered ${want.number} was read, but these units could not be read as one number and may hold it: ${quoted(unread)}.` };
  }
  if (!singles.length) return { found: 'unknown', note: `The unit numbers of this document are not in a form that could be compared (they are written like ${example}).` };
  return { found: false, note: `No unit numbered ${want.number} among the ${singles.length} numbered units of the text LexAPI holds (compared by number; they are written like ${example}).` };
}

const UNMAPPED_ARTICLE = 'This form could not be mapped to one article number (forms read: "17", "Art. 17", "Article 17(1)", "6a"), so nothing was compared.';

/**
 * What the API's resolver would take the identifier for: an ECLI, an ELI
 * path, or anything URL-like (a EUR-Lex or data.europa.eu address with or
 * without a scheme, a uri= parameter). Anything else it cannot resolve.
 */
function guessType(identifier: string): string {
  if (/^ECLI:/i.test(identifier)) return 'ecli';
  if (/(^|\/)eli\/[a-z_]+\/\d{4}\/\d+/i.test(identifier)) return 'eli';
  if (/eur-lex\.europa\.eu|data\.europa\.eu|[?&]uri=|\/eli\//i.test(identifier)) return 'url';
  return 'unrecognised';
}

export async function checkCitation(a: CheckArgs, client: LexAPIClient): Promise<Obj> {
  const identifier = a.identifier.trim();
  const calls = new Calls(client);
  // A national id starts with the code of a country LexAPI lists; "EU-…" is not one.
  if (isNationalId(identifier)) return checkNational(identifier.toUpperCase().normalize('NFC'), a, calls);

  const out: Obj = { identifier };
  const basis: Obj = {};
  let celex = upperCelex(identifier);

  // A shape that is none of the identifiers read here is not sent anywhere.
  if (!CELEX_SHAPE_RE.test(celex) && !LOOSE_CELEX_RE.test(celex) && guessType(identifier) === 'unrecognised') {
    return {
      identifier,
      identifierType: 'unrecognised',
      exists: 'unknown',
      inForce: 'unknown',
      notChecked: [{ what: 'everything', reason: 'rejected', note: 'The identifier is not in the form of a CELEX number, EUR-Lex URL, ELI, ECLI or national document id, so no call was made.' }],
    };
  }

  if (CELEX_SHAPE_RE.test(celex) || LOOSE_CELEX_RE.test(celex)) {
    out.identifierType = 'celex';
    basis.celex = 'the CELEX as given';
    const untagged = withoutVariantTag(celex);
    if (untagged !== celex) {
      basis.celex = withoutTagNote(celex, untagged);
      celex = untagged;
    }
  } else {
    const r = await calls.run((c) => c.resolve({ identifier }));
    const type = guessType(identifier);
    if (r.failure) {
      if (!['not_found', 'unconfirmed_not_found', 'rejected'].includes(r.failure.reason)) throw asThrown(r.failure);
      const why = r.failure.reason === 'unconfirmed_not_found' ? 'The 404 was not the API\'s answer about this identifier (not its NOT_FOUND, or a route it does not have), so it says nothing about the identifier.'
        : type === 'ecli' ? 'LexAPI resolves an ECLI only for case law it holds, so this is not proof that the decision does not exist.'
          : type === 'eli' ? 'No CELEX was found for this ELI: the Publications Office register has no matching work, or the ELI is not in a form LexAPI reads.'
            : 'The identifier was not recognised as a CELEX, EUR-Lex URL, ELI or ECLI.';
      return {
        identifier,
        identifierType: type,
        exists: 'unknown',
        inForce: 'unknown',
        notChecked: [{ what: 'everything: the identifier did not resolve to a document', call: 'lex_resolve', ...shown(r.failure), note: why }],
      };
    }
    const b = r.res.body;
    const resolved = isObj(b) && b.success !== false && typeof b.celex === 'string' ? upperCelex(b.celex) : '';
    if (!CELEX_SHAPE_RE.test(resolved) && !/^[0-9A-Z][0-9A-Z()._-]{4,}$/.test(resolved)) {
      return {
        identifier,
        identifierType: type,
        exists: 'unknown',
        inForce: 'unknown',
        notChecked: [{ what: 'everything: the identifier did not resolve to a document', call: 'lex_resolve', reason: 'unreadable_response', note: 'The answer carried no CELEX number.' }],
      };
    }
    celex = resolved;
    out.identifierType = typeof b.identifierType === 'string' ? b.identifierType : type;
    basis.celex = `lex_resolve (${String(b.resolvedVia ?? out.identifierType)}; ${b.verified === true ? 'confirmed by a register' : 'read off the identifier, not looked up'})`;
  }
  out.celex = celex;

  const ref = a.article ? parseArticle(a.article) : undefined;
  // One article is read with the document. The whole article list is read
  // only when that comes back empty, to tell "no such article" from "a text
  // without articles".
  const call = ref ? 'lex_get_document' : 'lex_get_metadata';
  const what = `existence, title, in-force status${ref ? ', article' : ''}`;
  const read = await calls.run((c) => (ref
    ? c.getDocument({ celexNumber: celex, articleId: ref.number, include: ['metadata', 'articles'] })
    : c.getMetadata({ celexNumber: celex })));
  const unknownArticle = a.article && !ref ? { article: { requested: a.article, found: 'unknown', note: UNMAPPED_ARTICLE } } : {};

  if (read.failure) {
    // Only the API's own NOT_FOUND says the document does not exist.
    if (read.failure.reason === 'not_found') {
      out.exists = false;
      basis.exists = `${call}: ${read.failure.error}`;
      out.inForce = 'unknown';
      out.basis = basis;
      return { ...out, ...calls.footer() };
    }
    // Nothing was obtained at all: the API error is the answer.
    if (!calls.succeeded && read.failure.reason !== 'unconfirmed_not_found') throw asThrown(read.failure);
    return {
      ...out,
      exists: 'unknown',
      inForce: 'unknown',
      ...unknownArticle,
      basis,
      notChecked: [compact({
        what,
        call,
        ...shown(read.failure),
        note: read.failure.reason === 'unconfirmed_not_found' ? 'The 404 was not the API\'s answer about this document (not its NOT_FOUND, or a route it does not have), so it does not show that the document does not exist.' : undefined,
      })],
      ...calls.footer(),
    };
  }

  const carried = carriedDocument(read.res.body, ref ? 'document' : 'metadata', celex, CELEX_KEYS);
  if (carried.problem) {
    return {
      ...out,
      exists: 'unknown',
      inForce: 'unknown',
      ...unknownArticle,
      basis,
      notChecked: [{ what, call, ...carried.problem }],
      ...calls.footer(),
    };
  }
  const d = carried.doc;
  const md = shapeMetadata(d, read.res.headers);
  out.exists = true;
  basis.exists = `${call}: document returned${md.source ? ` (source: ${String(md.source)})` : ''}`;
  Object.assign(out, compact({
    title: md.title,
    titleLanguage: md.titleLanguage,
    documentType: md.documentType,
    dateOfDocumentISO: md.dateOfDocumentISO,
    dateOfEffectISO: md.dateOfEffectISO,
    ecli: md.ecli,
    eli: md.eli,
    url: md.url,
    consolidated: md.consolidated,
    consolidatedAsOf: md.consolidatedAsOf,
    baseCelex: md.baseCelex,
    consolidatedNote: md.consolidatedNote,
    textAvailability: md.textAvailability,
  }));

  Object.assign(out, inForceOf(d));
  if (out.inForce === 'unknown') out.inForceNote ??= IN_FORCE_UNKNOWN;
  else basis.inForce = `${call}: the act's status today, as recorded by the Publications Office${md.baseCelex ? ` for ${String(md.baseCelex)}` : ''}; amendments are not covered`;

  const pointers = consolidatedPointers(d);
  if (Object.keys(pointers).length) Object.assign(out, pointers);
  else if (/^3/.test(celex)) out.latestConsolidated = 'not_reported';

  const consolidated = consolidatedBaseOf(celex) !== null;
  if (ref && a.article) {
    // A unit's own number decides; its id is used when it has no number.
    const byNumber = (u: Obj) => {
      const m = typeof u.number === 'string' ? /^(?:article\s+)?0*(\d+[a-z]{0,2})$/.exec(u.number.trim().toLowerCase()) : null;
      return m ? m[1] === ref.number : undefined;
    };
    const byId = (u: Obj) => {
      const m = typeof u.id === 'string' ? /^(?:art_)?0*(\d+[a-z]{0,2})$/.exec(u.id.trim().toLowerCase()) : null;
      return m ? m[1] === ref.number : undefined; // an id in another form says nothing
    };
    const matchesRef = (u: Obj) => byNumber(u) ?? byId(u) ?? false;
    const disagrees = (u: Obj) => byNumber(u) !== undefined && byId(u) !== undefined && byNumber(u) !== byId(u);
    const unitsOf = (doc: Obj) => (isObj(doc.content) && Array.isArray(doc.content.articles) ? doc.content.articles.filter(isObj) : []);
    let units = unitsOf(d);
    let hit = units.find(matchesRef);
    let odd = units.find(disagrees);
    let listFailure: Obj | undefined;
    let listRead: 'read' | 'failed' | undefined;
    // The article list is read whenever the article was not matched. Only an
    // answer without an articles key at all is taken as a text without
    // article units; the API sends an empty list also for those.
    if (!hit && !odd && isObj(d.content) && 'articles' in d.content) {
      const list = await calls.run((c) => c.getDocument({ celexNumber: celex, include: ['articles'] }));
      listRead = 'read';
      const got = list.failure ? undefined : carriedDocument(list.res.body, 'document', celex, CELEX_KEYS);
      if (list.failure) listFailure = shown(list.failure);
      else if (!got || got.problem) listFailure = got?.problem;
      if (listFailure || !got?.doc) listRead = 'failed';
      else {
        units = unitsOf(got.doc);
        hit = units.find(matchesRef);
        odd = units.find(disagrees);
      }
    }
    if (!isObj(d.content)) {
      const ta = isObj(d.textAvailability) ? d.textAvailability : {};
      out.article = { requested: a.article, found: 'unknown', note: `No text was served for ${celex}${ta.reason ? ` (${String(ta.reason)})` : ''}, so the article could not be looked up.` };
    } else if (odd) {
      out.article = { requested: a.article, found: 'unknown', note: `A unit of ${celex} carries the id "${String(odd.id)}" and the number "${String(odd.number)}", which disagree, so it is not reported as Article ${ref.number}.` };
    } else if (hit) {
      const text = typeof hit.content === 'string' ? hit.content : typeof hit.text === 'string' ? hit.text : undefined;
      out.article = compact({
        requested: a.article,
        found: true,
        id: hit.id,
        number: hit.number,
        title: hit.title,
        excerpt: truncate(text, 300),
        checkedIn: celex,
        language: md.languageFallback ? md.language : undefined,
        notChecked: ref.rest ? `"${ref.rest}": only the article was looked up, not a paragraph or point of it.` : undefined,
      });
    } else if (listFailure) {
      out.article = { requested: a.article, found: 'unknown', note: `Article ${ref.number} was not returned for ${celex}, and the article list that would show whether the text has article units could not be read.` };
      out.notChecked = [{ what: 'article', call: 'lex_get_document', ...listFailure }];
    } else if (!units.length) {
      out.article = { requested: a.article, found: 'unknown', note: `The text of ${celex} has no article units as LexAPI holds it (a judgment, or a text parsed without articles), so the article could not be looked up.` };
    } else {
      out.article = {
        requested: a.article,
        found: false,
        checkedIn: celex,
        note: `Article ${ref.number} is not among the ${units.length} article units of ${celex} (written like "${String(units[0].number ?? units[0].id)}"); only ${consolidated ? 'this consolidated version was' : 'the act as published was'} compared${consolidated ? '' : ', and an article inserted by a later amendment is only in a consolidated version'}.`,
      };
    }
    basis.article = `${call} with articleId${listRead === 'read' ? ', then the article list of the text' : listRead === 'failed' ? ', then a read of the article list that failed' : ''}`;
  } else {
    Object.assign(out, unknownArticle);
  }

  if (a.date) {
    out.onDate = onDate(a.date, {
      // A consolidated version's date is the consolidation's, not the act's.
      documentDate: consolidated ? undefined : d.dateOfDocumentISO,
      entryIntoForce: d.entryIntoForce,
      lastDayInForce: d.endOfValidity,
    });
  }
  out.basis = basis;
  return { ...out, ...calls.footer() };
}

async function checkNational(id: string, a: CheckArgs, calls: Calls): Promise<Obj> {
  const code = id.slice(0, 2);
  const call = 'lex_get_national_document';
  const out: Obj = { identifier: id, identifierType: 'national_id', id, jurisdiction: code };
  // Which countries LexAPI lists and which are live: a free call, so an id of
  // a country that is not served costs nothing and is named as such.
  const cov = await calls.runList('jurisdictions', (c) => c.nationalCoverage());
  if (calls.stopped) throw asThrown(calls.stopped);
  // A country listed as not live is still asked for the document: the API
  // serves it to an account with access, and refuses it otherwise.
  let notLive = false;
  if (cov.failure) {
    out.coverage = { call: 'lex_national_coverage', ...shown(cov.failure), note: 'Whether the country is listed and live was not checked; the document read gives its own answer.' };
  } else {
    const listed = (cov.res.body.jurisdictions as unknown[]).filter(isObj).find((j) => String(j.code ?? '').toUpperCase() === code);
    if (!listed) {
      return {
        ...out,
        exists: 'unknown',
        inForce: 'unknown',
        notChecked: [{
          what: 'everything',
          call: 'lex_national_coverage',
          reason: 'not_listed',
          note: `LexAPI lists no country ${code}, so this is not a national document id it can look up; no document read was made.`,
        }],
      };
    }
    notLive = listed.live !== true;
  }
  const read = await calls.run((c) => c.getNationalDocument(code, id, {}));
  if (read.failure) {
    const err = read.failure.cause;
    if (!['not_found', 'unconfirmed_not_found'].includes(read.failure.reason) || !(err instanceof LexAPIError)) throw asThrown(read.failure);
    const details = isObj(err.details) ? err.details : {};
    // A document id LexAPI does not hold: the API's NOT_FOUND, naming the
    // country. A country that is not live answers as a path that does not exist.
    if (read.failure.reason === 'not_found' && typeof details.jurisdiction === 'string' && !notLive) {
      return { ...out, exists: false, inForce: 'unknown', basis: { exists: `${call}: ${read.failure.error}` } };
    }
    return {
      ...out,
      exists: 'unknown',
      inForce: 'unknown',
      notChecked: [{
        what: 'everything',
        call,
        ...shown(read.failure),
        // A missing national route is a country that is not served, not a
        // deployment without the endpoint: the API's own words are shown.
        ...(routeMissing(err) ? { error: `LexAPI error 404 (${err.code}): ${err.message.trim().replace(/[.\s]+$/, '')}` } : {}),
        note: notLive ? `lex_national_coverage lists ${code} as not live, and the document read was answered 404, so the document could not be looked up.`
          : /Unknown API endpoint/i.test(err.message) || isMarkedUnknownEndpoint(err)
          ? `LexAPI has no route for ${code}: the country is not live (lex_national_coverage lists the live ones), or the prefix is not a country code.`
          : 'The 404 was not the API\'s own answer about this document id, so it does not show that the document does not exist.',
      }],
    };
  }

  // The API restores the final dot a Slovenian decision id easily loses, for those ids only.
  const withDot = id.startsWith('SI-JUD-') && !id.endsWith('.') ? `${id}.` : undefined;
  const carried = carriedDocument(read.res.body, 'document', id, ['id'], withDot);
  if (carried.problem) {
    return { ...out, exists: 'unknown', inForce: 'unknown', notChecked: [{ what: 'everything', call, ...carried.problem }], ...calls.footer() };
  }
  const doc = carried.doc;
  const basis: Obj = { exists: `${call}: document returned` };
  if (String(doc.id).trim().toUpperCase() !== id) {
    out.id = String(doc.id).trim().toUpperCase();
    basis.id = `${call}: the id as LexAPI holds it, with its final dot`;
  }
  Object.assign(out, compact({
    jurisdiction: doc.jurisdiction,
    exists: true,
    documentKind: doc.documentKind,
    title: doc.title,
    documentType: doc.documentType,
    dateOfDocument: doc.dateOfDocument,
    ecli: doc.ecli,
    eli: doc.eli,
  }));
  const ta = doc.textAvailability;
  if (isObj(ta) && ta.available !== true) out.textAvailability = ta;

  if (typeof doc.inForce === 'boolean') {
    out.inForce = doc.inForce;
    basis.inForce = `${call}: derived by LexAPI from validTo, the end of validity its source confirmed`;
  } else {
    out.inForce = 'unknown';
    out.inForceNote = 'No end of validity is recorded for this document, so its status is not known; that is not a statement that it is in force.';
  }
  if (doc.validTo) out.validTo = doc.validTo;

  if (a.article) {
    const content = isObj(doc.content) ? doc.content : undefined;
    const units = content && Array.isArray(content.articles) ? content.articles.filter(isObj) : [];
    const match = units.length ? matchUnit(a.article, units.map((u) => u.number)) : undefined;
    const hit = match?.found === true && match.index !== undefined ? units[match.index] : undefined;
    if (!content) {
      out.article = { requested: a.article, found: 'unknown', note: 'No text was served for this document, so the unit could not be looked up.' };
    } else if (!match) {
      out.article = { requested: a.article, found: 'unknown', note: 'This document is held without numbered units (a decision, or an act its source publishes without units), so the unit could not be looked up.' };
    } else if (hit) {
      out.article = compact({
        requested: a.article,
        found: true,
        number: hit.number,
        title: hit.title,
        inForceFrom: hit.inForceFrom,
        inForceTo: hit.inForceTo,
        excerpt: truncate(typeof hit.text === 'string' ? hit.text : undefined, 300),
        checkedIn: id,
        unitsWithThisNumber: (match.count ?? 1) > 1 ? match.count : undefined,
        notChecked: match.rest ? `"${match.rest}": only the unit was looked up, not a paragraph or point of it.` : undefined,
      });
    } else {
      out.article = compact({ requested: a.article, found: match.found, checkedIn: match.found === false ? id : undefined, note: match.note });
    }
    basis.article = `${call}: the document's units, compared by number`;
  }

  if (a.date) out.onDate = onDate(a.date, { documentDate: doc.dateOfDocument, lastDayInForce: doc.validTo });
  // The source and its licence: kept with the content, as on every national result.
  if (doc.attribution) out.attribution = doc.attribution;
  out.basis = basis;
  return { ...out, ...calls.footer() };
}

// ── lex_act_history ────────────────────────────────────────────────
export interface HistoryArgs {
  celexNumber: string;
  since?: string;
  dates?: number;
  limit?: number;
  offset?: number;
  language?: string;
}

const CHANGE_TYPES = ['repeal', 'amendment', 'corrigendum'] as const;
type ChangeType = (typeof CHANGE_TYPES)[number];
const CHANGE_LISTS: Record<ChangeType, string> = { repeal: 'repeals', amendment: 'amendments', corrigendum: 'corrigenda' };

/** Said on every result: what the list can and cannot show. */
const HISTORY_CAVEAT = "The relations come from LexAPI's citation graph and may be incomplete: an empty or short list is not proof that nothing changed. A partial repeal is typed as an amendment, so an empty repeals list does not exclude one.";

interface Change { type: ChangeType; celex: string; title?: string; celexYear?: number; date?: string; provenance?: unknown[]; dateNotRead?: Obj }

export async function actHistory(a: HistoryArgs, client: LexAPIClient): Promise<Obj> {
  const requested = upperCelex(a.celexNumber);
  // A summary or rendition tag (_SUM, _RES) names the same act; a consolidated CELEX is read as its base act.
  const untagged = withoutVariantTag(requested);
  const celex = consolidatedBaseOf(untagged)?.base ?? untagged;
  const limit = a.limit ?? 100;
  const offset = a.offset ?? 0;
  const calls = new Calls(client);
  const incomplete: Obj[] = [];
  const basis: Obj = {};
  const out: Obj = { celex };
  if (celex !== requested) out.requested = requested;
  if (untagged !== requested) basis.celex = withoutTagNote(requested, untagged);

  // 1. The relations: one page of amendment / corrigendum / repeal edges.
  const edges = await calls.runList('citedBy', (c) => c.citedBy(celex, compact({
    citationType: [...CHANGE_TYPES],
    limit,
    offset,
    language: a.language,
  })));
  // 2. The act itself: title, dates, in-force status, consolidated pointers.
  const meta = await calls.run((c) => c.getMetadata({ celexNumber: celex }));
  // An act the API says does not exist has no history: its relations, if the
  // graph holds any for this id, are not shown as the changes of an act.
  if (meta.failure?.reason === 'not_found') {
    return { ...out, exists: false, inForce: 'unknown', basis: { ...basis, exists: `lex_get_metadata: ${meta.failure.error}` }, ...calls.footer() };
  }
  // Nothing was obtained and the API said why: its error is the answer.
  if (edges.failure?.cause && meta.failure && meta.failure.reason !== 'unconfirmed_not_found') throw asThrown(edges.failure);

  const ACT_PART = 'the act: whether it exists (not confirmed), title, dates, in-force status, end of validity, consolidated versions';
  const carried = meta.failure ? undefined : carriedDocument(meta.res.body, 'metadata', celex, CELEX_KEYS);
  if (meta.failure || !carried || carried.problem) {
    out.exists = 'unknown';
    out.inForce = 'unknown';
    incomplete.push({ part: ACT_PART, call: 'lex_get_metadata', ...(meta.failure ? shown(meta.failure) : carried?.problem) });
  } else {
    const d = carried.doc;
    const md = shapeMetadata(d, meta.res.headers);
    out.exists = true;
    basis.exists = 'lex_get_metadata: document returned';
    Object.assign(out, compact({
      title: md.title,
      documentType: md.documentType,
      dateOfDocumentISO: md.dateOfDocumentISO,
      dateOfEffectISO: md.dateOfEffectISO,
      url: md.url,
    }));
    Object.assign(out, inForceOf(d));
    if (out.inForce === 'unknown') out.inForceNote ??= IN_FORCE_UNKNOWN;
    else basis.inForce = "lex_get_metadata: the act's status today, as recorded by the Publications Office";
    const pointers = consolidatedPointers(d);
    if (Object.keys(pointers).length) {
      Object.assign(out, pointers);
      basis.consolidated = 'lex_get_metadata: the versions the API had looked up, not a full list; consolidated texts are documentation without legal force';
    } else {
      out.consolidatedVersions = 'not_reported';
    }
  }

  const changes: Change[] = [];
  if (edges.failure) {
    incomplete.push({ part: 'the changes: amendments, corrigenda, repeals', call: 'lex_cited_by', ...shown(edges.failure) });
    out.completeness = { note: HISTORY_CAVEAT };
  } else {
    const b = edges.res.body;
    for (const g of (Array.isArray(b.citedBy) ? b.citedBy : []).filter(isObj)) {
      const rows = (Array.isArray(g.citations) ? g.citations : []).filter(isObj);
      const type = CHANGE_TYPES.find((t) => rows.some((r) => r.citationType === t));
      const id = String(g.celexNumber ?? g.id ?? '');
      if (!type || !id) continue;
      changes.push({
        type,
        celex: id,
        title: truncate(typeof g.title === 'string' ? g.title : undefined, 200),
        celexYear: celexYear(id),
        provenance: [...new Set(rows.map((r) => r.provenance).filter((p) => typeof p === 'string'))],
      });
    }
    const sync = isObj(b.relationSync) ? b.relationSync : undefined;
    const current = sync && (sync.status === 'fresh' || sync.status === 'refreshed');
    out.completeness = compact({
      relationSync: sync,
      note: `${HISTORY_CAVEAT} ${current
        ? 'The amendment, corrigendum and repeal relations were refreshed from the Publications Office within the last 7 days.'
        : !sync ? 'The refresh status of the relations was not reported.'
        : sync.reason === 'not-applicable'
          ? 'These relations are refreshed from the Publications Office for legislation only (CELEX sectors 1–4); for this document only stored relations are returned.'
          : 'The stored relations were returned without a refresh from the Publications Office; a change recorded since may be missing.'}`,
    });
    basis.changes = 'lex_cited_by with citationType amendment, corrigendum, repeal';
    const total = typeof b.totalEdges === 'number' ? b.totalEdges : undefined;
    out.counts = compact({ relations: total, read: (Array.isArray(b.citedBy) ? b.citedBy : []).length });
    if (total !== undefined && offset + limit < total) {
      out.more = `Relations ${offset + 1}–${offset + limit} of ${total} read, in the order LexAPI recorded them. Call again with offset ${offset + limit}.`;
    }
  }

  // 3. since, by the year of the CELEX number (free), then exact dates for
  //    up to `dates` entries: first those the year cannot place.
  const sinceYear = a.since ? Number(a.since.slice(0, 4)) : undefined;
  let kept = sinceYear === undefined ? changes : changes.filter((c) => c.celexYear === undefined || c.celexYear >= sinceYear);
  const beforeSince = changes.length - kept.length;
  const newestFirst = (x: Change, y: Change) => (y.celexYear ?? 0) - (x.celexYear ?? 0) || (x.celex < y.celex ? 1 : -1);
  const undecided = (c: Change) => sinceYear !== undefined && (c.celexYear === undefined || c.celexYear === sinceYear);
  const queue = [...kept].sort((x, y) => Number(undecided(y)) - Number(undecided(x)) || newestFirst(x, y)).slice(0, a.dates ?? 0);
  let datesRead = 0;
  for (const c of queue) {
    const r = await calls.run((cl) => cl.getMetadata({ celexNumber: c.celex }));
    if (r.failure) {
      c.dateNotRead = r.notRun ? { reason: r.failure.reason, error: r.failure.error } : shown(r.failure);
      continue;
    }
    // The date is taken only from an answer about this act.
    const got = carriedDocument(r.res.body, 'metadata', c.celex.toUpperCase(), CELEX_KEYS);
    if (got.problem) {
      c.dateNotRead = {
        reason: got.problem.reason,
        error: got.problem.reason === 'different_document' ? `${got.problem.note.replace(/; nothing from it is reported\.$/, '')}, so its date was not used.` : 'The answer carried no document, so the date was not read.',
      };
      continue;
    }
    const m = got.doc;
    if (typeof m.dateOfDocumentISO === 'string') {
      c.date = m.dateOfDocumentISO;
      datesRead++;
    } else {
      c.dateNotRead = { reason: 'not_found', error: 'the metadata carries no document date' };
    }
  }
  let beforeSinceByDate = 0;
  if (a.since) {
    const since = a.since;
    const before = kept.filter((c) => c.date !== undefined && c.date < since);
    beforeSinceByDate = before.length;
    kept = kept.filter((c) => !before.includes(c));
  }
  if (queue.some((c) => c.dateNotRead)) {
    incomplete.push({ part: 'document dates of some listed acts (dateNotRead on each)', call: 'lex_get_metadata' });
  }

  if (!edges.failure) {
    kept.sort((x, y) => (y.date ?? `${y.celexYear ?? ''}`).localeCompare(x.date ?? `${x.celexYear ?? ''}`) || (x.celex < y.celex ? 1 : -1));
    const lists: Obj = {};
    for (const t of CHANGE_TYPES) {
      lists[CHANGE_LISTS[t]] = kept.filter((c) => c.type === t).map((c) => compact({
        celex: c.celex,
        title: c.title,
        date: c.date,
        celexYear: c.date ? undefined : c.celexYear,
        provenance: c.provenance,
        dateNotRead: c.dateNotRead,
      }));
    }
    out.changes = lists;
    if (a.since) {
      const undated = kept.filter((c) => c.date === undefined).length;
      out.since = compact({
        date: a.since,
        removedAsEarlier: beforeSince + beforeSinceByDate,
        note: `Entries with a CELEX year before ${sinceYear} or a document date before ${a.since} were removed. ${undated} kept ${undated === 1 ? 'entry has' : 'entries have'} no document date read (corrigenda have no year of their own) and may be earlier than ${a.since}.`,
      });
    }
    (out.counts as Obj).datesRead = datesRead || undefined;
    out.counts = compact(out.counts as Obj);
  }

  if (calls.stopped) out.stopped = { reason: calls.stopped.reason, detail: describeError(calls.stopped.cause) };
  if (incomplete.length) out.incomplete = incomplete;
  out.basis = basis;
  return { ...out, ...calls.footer() };
}

// ── lex_research ───────────────────────────────────────────────────
export type ResearchKind = 'legislation' | 'case_law';
export interface ResearchArgs {
  query: string;
  jurisdictions?: string[];
  kinds?: ResearchKind[];
  limit?: number;
  min_score?: number;
  language?: string;
}

/** Searches of one tool call run at most this many at a time. */
const RESEARCH_CONCURRENCY = 3;
/** Character budget of the merged hit list. */
export const RESEARCH_RESULT_BUDGET = 60_000;
const HIT_TEXT_CHARS = 500;

const NATIONAL_STOPS = new Set<FailureReason>(['national_allowance_exhausted', 'terms_not_accepted', 'plan']);

interface Search { code: string; kind: ResearchKind; call: string; report: Obj }

export async function research(a: ResearchArgs, client: LexAPIClient): Promise<Obj> {
  const codes = [...new Set((a.jurisdictions?.length ? a.jurisdictions : ['eu']).map((c) => c.toLowerCase()))];
  const kinds: ResearchKind[] = a.kinds?.length ? [...new Set(a.kinds)] : ['legislation', 'case_law'];
  const limit = a.limit ?? 5;
  const calls = new Calls(client);
  const out: Obj = { query: a.query };

  // Which of the requested countries are live: one free call, so a country
  // that is not live costs nothing and is named as such.
  const national = codes.filter((c) => c !== 'eu');
  const notLive = new Map<string, Failure>();
  if (national.length) {
    const cov = await calls.runList('jurisdictions', (c) => c.nationalCoverage());
    if (cov.failure) {
      out.coverage = { call: 'lex_national_coverage', ...shown(cov.failure), note: 'Live status was not checked; each national search reports its own answer.' };
    } else {
      const listed = new Map<string, Obj>();
      for (const j of (Array.isArray(cov.res.body.jurisdictions) ? cov.res.body.jurisdictions : []).filter(isObj)) {
        listed.set(String(j.code ?? '').toLowerCase(), j);
      }
      for (const code of national) {
        const j = listed.get(code);
        if (!j) notLive.set(code, { reason: 'not_listed', error: `lex_national_coverage lists no country ${code.toUpperCase()}` });
        else if (j.live !== true) notLive.set(code, { reason: 'not_live', error: `${code.toUpperCase()} is listed by lex_national_coverage but not live` });
      }
    }
  }

  const searches: Search[] = [];
  for (const code of codes) {
    for (const kind of kinds) {
      const call = code === 'eu'
        ? (kind === 'legislation' ? 'lex_semantic_legislation' : 'lex_semantic_case_law')
        : (kind === 'legislation' ? 'lex_national_semantic_legislation' : 'lex_national_semantic_case_law');
      searches.push({ code, kind, call, report: { jurisdiction: code.toUpperCase(), kind, call } });
    }
  }

  const hits: Obj[] = [];
  // Set when no further national search can succeed for this account.
  let nationalStopped: Failure | undefined;
  const body = compact({ query: a.query, limit, min_score: a.min_score });

  const runOne = async (s: Search): Promise<void> => {
    const skip = notLive.get(s.code) ?? (s.code !== 'eu' ? nationalStopped : undefined);
    if (skip) {
      Object.assign(s.report, { status: 'not_run', reason: skip.reason, error: skip === nationalStopped ? `not run: an earlier national search ended with ${skip.reason}` : skip.error });
      return;
    }
    const r = await calls.runList('results', (c) => (s.code === 'eu'
      ? (s.kind === 'legislation' ? c.semanticLegislation(compact({ ...body, language: a.language })) : c.semanticCaseLaw(compact({ ...body, language: a.language })))
      : (s.kind === 'legislation' ? c.nationalSemanticLegislation(s.code, body) : c.nationalSemanticCaseLaw(s.code, body))));
    if (r.failure) {
      // The allowance, the terms and the plan hold for the account, not for one country.
      if (s.code !== 'eu' && NATIONAL_STOPS.has(r.failure.reason)) nationalStopped ??= r.failure;
      Object.assign(s.report, r.notRun ? { status: 'not_run', reason: r.failure.reason, error: r.failure.error } : { status: 'failed', ...shown(r.failure) });
      return;
    }
    const b = r.res.body;
    const all = Array.isArray(b.results) ? b.results : [];
    const rows = all.filter(isObj);
    Object.assign(s.report, compact({
      status: 'ok',
      hits: rows.length,
      unreadableRows: all.length - rows.length || undefined,
      hint: b.hint,
      partial: b.partial,
      partialReason: b.partialReason,
    }));
    for (const row of rows) hits.push(mergedHit(s, row, b.attribution));
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(RESEARCH_CONCURRENCY, searches.length) }, async () => {
    while (next < searches.length) await runOne(searches[next++]);
  }));

  // One list, best score first. The sort is stable: equal scores keep the order searched.
  hits.sort((x, y) => Number(y.score ?? 0) - Number(x.score ?? 0));
  const results: Obj[] = [];
  let used = 0;
  for (const h of hits) {
    const cost = JSON.stringify(h).length;
    if (results.length && used + cost > RESEARCH_RESULT_BUDGET) break;
    results.push(h);
    used += cost;
  }

  const ran = searches.filter((s) => s.report.status === 'ok').length;
  out.searches = { requested: searches.length, ok: ran };
  out.resultCount = results.length;
  out.results = results;
  if (results.length < hits.length) {
    out.omitted = `${hits.length - results.length} lower-scored hits left out to keep the result under ${RESEARCH_RESULT_BUDGET} characters; a smaller limit or fewer jurisdictions returns all of them.`;
  }
  out.sources = searches.map((s) => s.report);
  if (ran < searches.length) out.incomplete = true;
  if (calls.stopped) out.stopped = { reason: calls.stopped.reason, detail: describeError(calls.stopped.cause) };
  else if (nationalStopped) out.stopped = { reason: nationalStopped.reason, scope: 'national searches', detail: describeError(nationalStopped.cause) };
  if (results.some((h) => h.kind === 'legislation')) {
    out.inForceNote = 'inForce is today\'s status as the API reported it; "unknown" means none was reported. On an EU hit it is the act\'s, as the Publications Office records it, and does not cover amendments. On a national hit it comes from the validity recorded in the national index for the matched text, or from a repeal LexAPI has recorded.';
  }
  if (new Set(results.map((h) => `${String(h.jurisdiction)}/${String(h.kind)}`)).size > 1) {
    out.scoreNote = 'Scores come from separate indexes; the order across sources is approximate.';
  }
  return { ...out, ...calls.footer() };
}

function mergedHit(s: Search, row: unknown, responseAttribution: unknown): Obj {
  const eu = s.code === 'eu';
  const shaped: Obj = s.kind === 'legislation'
    ? (eu ? shapeLegislationHit(row) : shapeNationalLegislationHit(row))
    : (eu ? shapeCaseLawHit(row) : shapeNationalCaseLawHit(row));
  const { in_force: nationalInForce, inForce, jurisdiction, snippet, summary, ...rest } = shaped;
  const hit: Obj = { jurisdiction: eu ? 'EU' : (jurisdiction ?? s.code.toUpperCase()), kind: s.kind, ...rest };
  if (typeof snippet === 'string') hit.snippet = truncate(snippet, HIT_TEXT_CHARS);
  if (typeof summary === 'string') hit.summary = truncate(summary, HIT_TEXT_CHARS);
  // Not asked for here; bounded like the snippet if an answer carries it, and marked as cut.
  if (typeof hit.text === 'string' && hit.text.length > HIT_TEXT_CHARS) {
    hit.text = truncate(hit.text, HIT_TEXT_CHARS);
    hit.textTruncated = true;
  }
  if (s.kind === 'legislation') {
    const label = eu ? inForceOf(shaped) : { inForce: nationalInForce };
    hit.inForce = typeof label.inForce === 'boolean' ? label.inForce : 'unknown';
    if (eu && label.inForceNote) {
      // Fields that contradict each other are not passed on beside "unknown".
      for (const k of ['notInForceReason', 'endOfValidity', 'entryIntoForce']) delete hit[k];
      hit.inForceNote = label.inForceNote;
    }
  } else if (inForce !== undefined) {
    // Sent only on a national decision, and only as false: its recorded end of validity has passed.
    hit.inForce = inForce;
  }
  // The source and its licence stay with every national hit.
  if (!eu && !hit.attribution && typeof responseAttribution === 'string' && responseAttribution) hit.attribution = responseAttribution;
  return hit;
}
