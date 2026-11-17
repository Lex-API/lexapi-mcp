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

import { describeError, LexAPIError, LexAPITransportError } from './errors.js';
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
  | 'plan' | 'terms_not_accepted' | 'not_found' | 'withdrawn' | 'semantic_not_enabled'
  | 'search_incomplete' | 'timeout' | 'upstream_error' | 'network' | 'rejected'
  | 'not_live' | 'not_listed' | 'unconfirmed_not_found' | 'unreadable_response' | 'different_document';

interface Failure {
  reason: FailureReason;
  error: string;
  retryAfterSeconds?: number;
  /** The error as thrown, for the full text when it ends the tool call. */
  cause?: unknown;
}

/** After one of these, a later call of the same tool call cannot succeed either. */
const STOPS_ALL = new Set<FailureReason>(['credits_exhausted', 'rate_limited', 'quota_exhausted']);

/**
 * What a failed call means for the result. Errors that are not an API answer
 * about this one call (sign-in, a bad key, cancellation, a bug) are thrown:
 * they end the tool call.
 */
function failureOf(err: unknown): Failure {
  if (err instanceof LexAPITransportError && !err.cancelled) {
    return err.timedOut
      ? { reason: 'timeout', error: `LexAPI did not answer in time (${err.message})`, cause: err }
      : { reason: 'network', error: `LexAPI could not be reached (${err.message})`, cause: err };
  }
  if (!(err instanceof LexAPIError) || err.status === 401) throw err;
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
  /** Set once the credit pool or the rate limit is exhausted. */
  stopped?: Failure;
  succeeded = 0;
  private lowest: { remaining: number; body: unknown } | undefined;
  private allowanceSeen: Obj | undefined;

  constructor(private readonly client: LexAPIClient) {
    this.end = Date.now() + client.timeout;
  }

  async run(fn: (c: LexAPIClient) => Promise<LexResponse<Json>>): Promise<Outcome> {
    if (this.stopped) {
      return { notRun: true, failure: { reason: this.stopped.reason, error: `not run: an earlier call of this tool call ended with ${this.stopped.reason}` } };
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
      if (STOPS_ALL.has(failure.reason)) this.stopped ??= failure;
      return { failure };
    }
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
const NATIONAL_ID_RE = /^[A-Za-z]{2}-[0-9A-Za-z()./_-]+$/;
/** Sector, year, type letters, number: what is sent as a CELEX without resolving. */
const CELEX_SHAPE_RE = /^[0-9CE]\d{4}[A-Z]{1,2}\d[0-9A-Z()._-]*$/;

function upperCelex(v: string): string {
  return v.trim().replace(/^CELEX:/i, '').toUpperCase();
}

/** The year in a CELEX number; none for a corrigendum, whose number is that of the corrected act. */
function celexYear(celex: string): number | undefined {
  if (/R\(\d+\)$/.test(celex)) return undefined;
  const m = /^[1-9](\d{4})[A-Z]/.exec(celex);
  return m ? Number(m[1]) : undefined;
}

const IN_FORCE_UNKNOWN = 'No in-force status was returned for this document: none is recorded, the document type has none, or the API version does not report it.';

/** inForce as the API gave it, or "unknown"; with the fields that qualify it. */
function inForceOf(o: Obj): Obj {
  if (typeof o.inForce !== 'boolean') return { inForce: 'unknown' };
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
function carriedDocument(body: unknown, key: 'metadata' | 'document', requested: string, idKeys: string[]): Carried {
  const doc = isObj(body) && body.success !== false && isObj(body[key]) ? body[key] : undefined;
  const raw = doc ? idKeys.map((k) => doc[k]).find((v) => typeof v === 'string' && v.trim()) : undefined;
  if (!doc || typeof raw !== 'string') {
    return { problem: { reason: 'unreadable_response', note: `The answer carried no document with an identifier, so it does not show whether ${requested} exists.` } };
  }
  const returned = raw.trim().toUpperCase();
  if (returned !== requested) {
    return { problem: { reason: 'different_document', note: `${requested} was asked for and the answer is about ${returned}; nothing from it is reported.` } };
  }
  return { doc };
}

const CELEX_KEYS = ['celex', 'celexNumber'];

const LABEL_WORDS = new Set(['article', 'artikel', 'articulo', 'articolo', 'art', 'clen', 'cl', 'paragraph', 'paragraf', 'par']);

/** "§ 17a", "Art. 17a", "17a. člen" → "17a": a unit number without its label. */
function unitKey(v: unknown): string {
  return String(v ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t && !LABEL_WORDS.has(t)).join('');
}

interface ArticleRef { number: string; rest?: string }

/**
 * "Art. 17", "Article 17(1)", "art_17", "6a" → the article number the API
 * matches on, plus the paragraph or point part, which is not looked up.
 * Undefined for a form that cannot be mapped to one article number.
 */
export function parseArticle(v: string): ArticleRef | undefined {
  const t = v.trim().toLowerCase().replace(/^art(?:icle|\.)?[\s_]*/, '');
  const m = /^(\d+[a-z]{0,2})(?![a-z0-9])\s*(.*)$/.exec(t);
  if (!m) return undefined;
  const rest = m[2].trim();
  if (rest && !/^(?:[(,.;§]|para|point|pt\b|lit\b|subpara|sentence)/.test(rest)) return undefined;
  return rest ? { number: m[1], rest } : { number: m[1] };
}

const UNMAPPED_ARTICLE = 'This form could not be mapped to one article number (forms read: "17", "Art. 17", "Article 17(1)", "6a"), so nothing was compared.';

function guessType(identifier: string): string {
  if (/^ECLI:/i.test(identifier)) return 'ecli';
  if (/^https?:\/\//i.test(identifier)) return /\/eli\//i.test(identifier) ? 'eli' : 'url';
  if (/(^|\/)eli\//i.test(identifier)) return 'eli';
  return 'unrecognised';
}

export async function checkCitation(a: CheckArgs, client: LexAPIClient): Promise<Obj> {
  const identifier = a.identifier.trim();
  const calls = new Calls(client);
  if (NATIONAL_ID_RE.test(identifier)) return checkNational(identifier.toUpperCase(), a, calls);

  const out: Obj = { identifier };
  const basis: Obj = {};
  let celex = upperCelex(identifier);

  if (CELEX_SHAPE_RE.test(celex)) {
    out.identifierType = 'celex';
    basis.celex = 'the CELEX as given';
  } else {
    const r = await calls.run((c) => c.resolve({ identifier }));
    const type = guessType(identifier);
    if (r.failure) {
      if (!['not_found', 'unconfirmed_not_found', 'rejected'].includes(r.failure.reason)) throw asThrown(r.failure);
      const why = r.failure.reason === 'unconfirmed_not_found' ? 'The 404 was not the API\'s own NOT_FOUND answer, so it says nothing about the identifier.'
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
  // The whole article list is read, not one article: an empty match cannot
  // be told from a text without articles otherwise.
  const call = ref ? 'lex_get_document' : 'lex_get_metadata';
  const what = `existence, title, in-force status${ref ? ', article' : ''}`;
  const read = await calls.run((c) => (ref
    ? c.getDocument({ celexNumber: celex, include: ['metadata', 'articles'] })
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
        note: read.failure.reason === 'unconfirmed_not_found' ? 'The 404 was not the API\'s own NOT_FOUND answer, so it does not show that the document does not exist.' : undefined,
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
  if (out.inForce === 'unknown') out.inForceNote = IN_FORCE_UNKNOWN;
  else basis.inForce = `${call}: the act's status today, as recorded by the Publications Office${md.baseCelex ? ` for ${String(md.baseCelex)}` : ''}; amendments are not covered`;

  const pointers = consolidatedPointers(d);
  if (Object.keys(pointers).length) Object.assign(out, pointers);
  else if (/^3/.test(celex)) out.latestConsolidated = 'not_reported';

  const consolidated = consolidatedBaseOf(celex) !== null;
  if (ref && a.article) {
    const content = isObj(d.content) ? d.content : undefined;
    const units = content && Array.isArray(content.articles) ? content.articles.filter(isObj) : [];
    const hit = units.find((u) => {
      const id = String(u.id ?? '').toLowerCase();
      const number = String(u.number ?? '').toLowerCase();
      return id === `art_${ref.number}` || id === ref.number || number === `article ${ref.number}` || number === ref.number;
    });
    if (!content) {
      const ta = isObj(d.textAvailability) ? d.textAvailability : {};
      out.article = { requested: a.article, found: 'unknown', note: `No text was served for ${celex}${ta.reason ? ` (${String(ta.reason)})` : ''}, so the article could not be looked up.` };
    } else if (!units.length) {
      out.article = { requested: a.article, found: 'unknown', note: `The text of ${celex} has no article units as LexAPI holds it (a judgment, or a text parsed without articles), so the article could not be looked up.` };
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
    } else {
      out.article = {
        requested: a.article,
        found: false,
        checkedIn: celex,
        note: `Article ${ref.number} is not among the ${units.length} article units of ${celex}; only ${consolidated ? 'this consolidated version was' : 'the act as published was'} compared${consolidated ? '' : ', and an article inserted by a later amendment is only in a consolidated version'}.`,
      };
    }
    basis.article = `${call}: the article units of the text`;
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
  const read = await calls.run((c) => c.getNationalDocument(code, id, {}));
  if (read.failure) {
    const err = read.failure.cause;
    if (!['not_found', 'unconfirmed_not_found'].includes(read.failure.reason) || !(err instanceof LexAPIError)) throw asThrown(read.failure);
    const details = isObj(err.details) ? err.details : {};
    // A document id LexAPI does not hold: the API's NOT_FOUND, naming the
    // country. A country that is not live answers as a path that does not exist.
    if (read.failure.reason === 'not_found' && typeof details.jurisdiction === 'string') {
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
        note: /Unknown API endpoint/i.test(err.message)
          ? `LexAPI has no route for ${code}: the country is not live (lex_national_coverage lists the live ones), or the prefix is not a country code.`
          : 'The 404 was not the API\'s own answer about this document id, so it does not show that the document does not exist.',
      }],
    };
  }

  const carried = carriedDocument(read.res.body, 'document', id, ['id']);
  if (carried.problem) {
    return { ...out, exists: 'unknown', inForce: 'unknown', notChecked: [{ what: 'everything', call, ...carried.problem }], ...calls.footer() };
  }
  const doc = carried.doc;
  const basis: Obj = { exists: `${call}: document returned` };
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
    // The unit number, without a paragraph or point part: "§ 17 (1)" → "17".
    const cut = a.article.search(/[(,;]/);
    const want = unitKey(cut < 0 ? a.article : a.article.slice(0, cut));
    const rest = cut < 0 ? '' : a.article.slice(cut).trim();
    const hit = want ? units.find((u) => unitKey(u.number) === want) : undefined;
    if (!content) {
      out.article = { requested: a.article, found: 'unknown', note: 'No text was served for this document, so the unit could not be looked up.' };
    } else if (!units.length) {
      out.article = { requested: a.article, found: 'unknown', note: 'This document is held without numbered units (a decision, or an act its source publishes without units), so the unit could not be looked up.' };
    } else if (!want) {
      out.article = { requested: a.article, found: 'unknown', note: `This form could not be mapped to a unit number; the document's units are written like "${String(units[0].number)}".` };
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
        notChecked: rest ? `"${rest}": only the unit was looked up, not a paragraph or point of it.` : undefined,
      });
    } else {
      out.article = {
        requested: a.article,
        found: false,
        checkedIn: id,
        note: `No unit numbered "${want}" among the ${units.length} units of the text LexAPI holds (compared by number; they are written like "${String(units[0].number)}").`,
      };
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
const HISTORY_CAVEAT = "The relations come from LexAPI's citation graph and may be incomplete: an empty or short list is not proof that nothing changed.";

interface Change { type: ChangeType; celex: string; title?: string; celexYear?: number; date?: string; provenance?: unknown[]; dateNotRead?: Obj }

export async function actHistory(a: HistoryArgs, client: LexAPIClient): Promise<Obj> {
  const requested = upperCelex(a.celexNumber);
  const celex = consolidatedBaseOf(requested)?.base ?? requested;
  const limit = a.limit ?? 100;
  const offset = a.offset ?? 0;
  const calls = new Calls(client);
  const incomplete: Obj[] = [];
  const basis: Obj = {};
  const out: Obj = { celex };
  if (celex !== requested) out.requested = requested;

  // 1. The relations: one page of amendment / corrigendum / repeal edges.
  const edges = await calls.run((c) => c.citedBy(celex, compact({
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
    return { ...out, exists: false, inForce: 'unknown', basis: { exists: `lex_get_metadata: ${meta.failure.error}` }, ...calls.footer() };
  }
  if (edges.failure && meta.failure && meta.failure.reason !== 'unconfirmed_not_found') throw asThrown(edges.failure);

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
    if (out.inForce === 'unknown') out.inForceNote = IN_FORCE_UNKNOWN;
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
        : sync && sync.reason === 'not-applicable'
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
    const m = isObj(r.res.body.metadata) ? r.res.body.metadata : {};
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
    const cov = await calls.run((c) => c.nationalCoverage());
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
    const r = await calls.run((c) => (s.code === 'eu'
      ? (s.kind === 'legislation' ? c.semanticLegislation(compact({ ...body, language: a.language })) : c.semanticCaseLaw(compact({ ...body, language: a.language })))
      : (s.kind === 'legislation' ? c.nationalSemanticLegislation(s.code, body) : c.nationalSemanticCaseLaw(s.code, body))));
    if (r.failure) {
      // The allowance, the terms and the plan hold for the account, not for one country.
      if (s.code !== 'eu' && NATIONAL_STOPS.has(r.failure.reason)) nationalStopped ??= r.failure;
      Object.assign(s.report, r.notRun ? { status: 'not_run', reason: r.failure.reason, error: r.failure.error } : { status: 'failed', ...shown(r.failure) });
      return;
    }
    const b = r.res.body;
    const rows = Array.isArray(b.results) ? b.results : [];
    Object.assign(s.report, compact({
      status: 'ok',
      hits: rows.length,
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
  if (s.kind === 'legislation') {
    const flag = eu ? inForce : nationalInForce;
    hit.inForce = typeof flag === 'boolean' ? flag : 'unknown';
  } else if (inForce !== undefined) {
    // Sent only on a national decision, and only as false: its recorded end of validity has passed.
    hit.inForce = inForce;
  }
  // The source and its licence stay with every national hit.
  if (!eu && !hit.attribution && typeof responseAttribution === 'string' && responseAttribution) hit.attribution = responseAttribution;
  return hit;
}
