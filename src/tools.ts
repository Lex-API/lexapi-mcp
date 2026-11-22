import { z } from 'zod';

import { ENDPOINT_NOT_AVAILABLE, isUnknownEndpoint, LexAPIError } from './errors.js';
import { SCOPE_READ, SCOPE_WEBHOOKS, type ToolScope } from './oauth/scope.js';
import { webhookUrlProblem } from './webhookUrl.js';
import { actHistory, checkCitation, isNationalId, NATIONAL_ID_RE, research } from './workflows.js';

import type { Json, LexAPIClient, LexResponse } from './client.js';
import {
  compact,
  creditNotice,
  isObj,
  nationalAllowanceOf,
  shapeAsOfLookup,
  shapeCaseLaw,
  shapeCitedBy,
  shapeCites,
  shapeContent,
  shapeCounterparts,
  shapeDocument,
  shapeLegislation,
  shapeMetadata,
  shapeNationalCaseLaw,
  shapeNationalDocument,
  shapeNationalLegislation,
  shapeNationalSearchResult,
  shapeNetwork,
  shapeRecent,
  shapeSearch,
  shapeTransposition,
  nodeFields,
  stripEnvelope,
  type View,
} from './shape.js';

// ── Shared vocabularies (mirroring openapi.yaml / GET /info) ─────────
export const LANGUAGES = [
  'en', 'fr', 'de', 'es', 'it', 'pl', 'nl', 'pt', 'ro', 'bg', 'cs', 'da',
  'el', 'et', 'fi', 'ga', 'hr', 'hu', 'lt', 'lv', 'mt', 'sk', 'sl', 'sv',
] as const;

/** Languages the semantic index holds. */
export const SEMANTIC_LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'sl', 'el', 'nl', 'pt', 'pl'] as const;

export const DOCUMENT_TYPES = [
  'judgment', 'opinion', 'order', 'regulation', 'directive', 'decision',
  'recommendation', 'communication', 'proposal', 'report', 'resolution',
  'declaration', 'treaty', 'protocol', 'agreement', 'written-question',
  'oral-question', 'consolidated-text', 'guideline', 'implementing',
  'staff-working-document',
] as const;

export const AUTHORS = [
  'commission', 'council', 'parliament', 'court-of-justice', 'general-court',
  'civil-service-tribunal', 'ecb', 'eca', 'eesc', 'cor', 'ema', 'efsa',
] as const;

export const PROCEDURES = [
  'ordinary', 'codecision', 'consent', 'consultation', 'budget',
  'implementing', 'delegated', 'comitology', 'appointment', 'non-legislative',
] as const;

/** EUR-Lex subdomain codes plus the friendly aliases the API maps to them. */
export const SUBDOMAINS = [
  'LEGISLATION', 'CONSLEG', 'TREATIES', 'EU_CASE_LAW', 'LEGAL_PROCEDURE',
  'INTER_AGREE', 'PRE_ACTS', 'PAR_QUESTION', 'NAT_CASE_LAW',
  'legislation', 'consolidated', 'treaties', 'case-law', 'legal-procedure',
  'international', 'preparatory', 'questions', 'national-case-law',
] as const;

export const CITATION_TYPES = [
  'reference', 'amendment', 'repeal', 'corrigendum', 'implementation', 'legal-basis', 'proposal', 'transposition',
] as const;

/** Where an edge comes from (API 2.11.0 CitationProvenance). */
export const CITATION_PROVENANCES = ['notice', 'cellar', 'notice+cellar', 'cellar-nim', 'source', 'resolver'] as const;

/** How a national edge's target was identified (API 2.11.0 CitationResolution). */
export const CITATION_RESOLUTIONS = ['id', 'key', 'abbreviation', 'text-pattern'] as const;

const CONTENT_PARTS = ['metadata', 'fullText', 'articles', 'recitals', 'paragraphs', 'sections', 'tables', 'annexes'] as const;

// The CELEX form the API accepts (corrigenda `32013R0952R(04)` and
// consolidated `02016R0679-20180524` included), case-insensitive; an
// optional `CELEX:` prefix is stripped before sending.
const CELEX_RE = /^(?:CELEX:)?[0-9A-Za-z][0-9A-Za-z()._-]{4,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const celex = (what = 'CELEX number') =>
  z.string().trim().refine((v) => CELEX_RE.test(v), `${what} must look like 32016R0679, 62018CJ0311, 02016R0679-20180524 or 32013R0952R(04)`)
    .describe(`${what}, e.g. 32016R0679.`);

// lex_legislation_as_of only: the forms above, and the CELEX of a treaty or
// agreement written with a slash (12012M/TXT), which the API answers as an
// act type the lookup does not cover.
const SLASH_CELEX_RE = /^(?:CELEX:)?[0-9CE][0-9]{4}[A-Z]{1,2}[0-9A-Z()_/-]{2,30}$/i;
const actCelex = () =>
  z.string().trim().refine((v) => CELEX_RE.test(v) || SLASH_CELEX_RE.test(v), 'CELEX number of the act must look like 32016R0679 or 02016R0679-20180524');

// National-corpus ids (e.g. `AT-NOR-10001597`, `SI-JUD-UPRS-2025-I.U.727.2022.`):
// a two-letter jurisdiction prefix, which is how the API recognises them on
// the citation graph, then the source's own identifier, letters of any
// alphabet included (NATIONAL_ID_RE, shared with the workflow tools). The
// pattern is checked on the composed form (NFC) in a refinement, so it is
// not published in the JSON schema. The citation tools accept either
// shape; document reads stay celex()-only (lex_get_national_document /
// lex_list_national_documents cover national documents directly).
const celexOrNationalId = (what = 'identifier') =>
  z.string().trim()
    .refine((v) => CELEX_RE.test(v) || NATIONAL_ID_RE.test(v.normalize('NFC')),
      `${what} must be a CELEX number (e.g. 32016R0679) or a national document id (e.g. AT-NOR-12345)`)
    .describe(`${what}: a CELEX number, or a national document id, e.g. "AT-NOR-12345".`);
// National law: jurisdiction codes
// are not enumerated here — the server is the single source of truth for
// which are registered and which are LIVE (lex_national_coverage), and the
// set grows over time. A two-letter code that isn't live 404s like any
// unmatched path, same as EU_LAW.
const jurisdiction = () => z.string().trim().regex(/^[A-Za-z]{2}$/, 'a two-letter country code, e.g. "at"')
  .transform((v) => v.toLowerCase())
  .describe('Two-letter code of a live country, e.g. "at" (lex_national_coverage lists them).');

// The 24-code enum used to be repeated in ~10 tools (~3k tokens of tools/list).
// A pattern + refine keeps the validation and lists the codes nowhere.
const LANG_SET = new Set<string>(LANGUAGES);
const lang = (d = 'Language: ISO 639-1 code of an official EU language (en, fr, de, …; default en).') =>
  z.string().regex(/^[a-z]{2}$/).refine((v) => LANG_SET.has(v), 'not an official EU language code').describe(d);
// Webhook targets: https, public host — mirrors the DNS-free part of the API's
// egress guard (defence in depth; the API is authoritative).
const webhookUrl = (d: string) => z.string().trim().superRefine((v, ctx) => {
  const problem = webhookUrlProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
}).describe(d);
// The export API's own date and timestamp checks, mirrored exactly so the
// schema accepts what the server accepts and nothing else: a calendar-valid YYYY-MM-DD; a date-time needs a
// zone (Z, ±HH:MM or ±HHMM), seconds are optional, a fraction has 1–9 digits.
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/;
export function isApiDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function isApiTimestamp(value: string): boolean {
  const m = ISO_TS_RE.exec(value);
  if (!m || !isApiDate(m[1])) return false;
  if (m[2] !== undefined && (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59)) return false;
  return !Number.isNaN(new Date(m[2] === undefined ? `${m[1]}T00:00:00Z` : value).getTime());
}
// Formats (dates, CELEX numbers) are checked in refinements, not by a regex on
// the schema: the pattern would be repeated in tools/list for every parameter.
const isoDate = (d?: string) => {
  const s = z.string().refine(isApiDate, 'use YYYY-MM-DD (a calendar date)');
  return d ? s.describe(d) : s;
};
/** An ISO 8601 date, or a date-time WITH a timezone (the API rejects one without). */
const since = (d: string) =>
  z.string().refine(isApiTimestamp, 'use YYYY-MM-DD or an ISO 8601 date-time with a timezone (Z or ±HH:MM)')
    .describe(`${d} ISO 8601: a date (YYYY-MM-DD, midnight UTC) or a date-time with a timezone.`);
// One value or a list; the allowed values are listed once, in the description
// (an enum inside a string|array union would print them twice).
const oneOrMany = <T extends readonly [string, ...string[]]>(values: T, d: string) => {
  const set = new Set<string>(values);
  return z.union([z.string(), z.array(z.string()).min(1)])
    .refine((v) => (Array.isArray(v) ? v : [v]).every((x) => set.has(x)), `allowed: ${values.join(', ')}`)
    .describe(`${d} One or a list of: ${values.join(', ')}.`);
};

// A list filter sent comma-separated: an array, one value, or "a,b".
const splitList = (v: string | string[]) =>
  (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean);
// The values are listed once, in the array's enum; a plain string ("a,b")
// is accepted too and checked against the same set.
const csvOf = <T extends readonly [string, ...string[]]>(values: T, d: string) => {
  const set = new Set<string>(values);
  return z.union([z.string(), z.array(z.enum(values)).min(1)])
    .transform(splitList)
    .refine((v) => v.length > 0 && v.every((x) => set.has(x)), `allowed: ${values.join(', ')}`)
    .describe(d);
};
// Two-letter codes (lower-cased), e.g. ["eu","at"]. Which national codes
// are live is the server's call (lex_national_coverage), not listed here.
const codeList = (d: string, max = 30) => z.union([z.string(), z.array(z.string()).min(1).max(max)])
  .transform((v) => splitList(v).map((x) => x.toLowerCase()))
  .refine((v) => v.length > 0 && v.length <= max && v.every((x) => /^[a-z]{2}$/.test(x)), `two-letter codes, e.g. ["eu","at"] (at most ${max})`)
  .describe(d);

/** The edge filters shared by the graph tools (API 2.11.0). */
const graphFilters = {
  citationType: csvOf(CITATION_TYPES, 'Only these edge types.').optional(),
  provenance: csvOf(CITATION_PROVENANCES, 'Edge origins (cellar-nim: a notified measure, not a finding of transposition). The last three: 400 while no country is live.').optional(),
  jurisdictions: codeList('Neighbours in: "eu" and/or live national codes (national: BUSINESS+).').optional(),
  resolution: csvOf(CITATION_RESOLUTIONS, 'National edges: match method.').optional(),
};
const titleLanguage = lang('Title language (default en).').optional();
const unresolved = z.boolean().optional()
  .describe('National id: add references that got no edge (100 shown).');
const includeNational = z.boolean().optional().describe('Add national documents of live countries (BUSINESS+).');
// A whole number with a lower bound only. z.number().int() also publishes the
// largest safe integer as "maximum" in the JSON schema, on every such
// parameter of tools/list; this checks the same range and publishes
// { type: "integer", minimum }.
const wholeNumber = (min: number) => z.number().min(min)
  .refine((v) => Number.isSafeInteger(v), 'must be a whole number within the safe integer range')
  .meta({ type: 'integer' });
const edgeOffset = wholeNumber(0).default(0).describe('Paging offset, in edges.');
const webhookId = z.string().trim().min(1).max(64).describe('Webhook id (from lex_list_webhooks).');
const NATIONAL_DOMAIN_NOTE = 'NATIONAL_LAW is EUR-Lex\'s own collection; member-state law is in the lex_national_* tools.';
// One language per national index: the API answers any other value with a 400.
const nationalLanguage = lang('Not needed. Only the country\'s own language is accepted (e.g. "de" for AT); any other value is a 400 that names it.').optional();
// Webhook matching rules, as the API validates them: the same keys and value
// forms on create and update. Every field may be null (same as leaving it out).
const YEAR_FORM = 'a 4-digit year (number or string), or a list of them';
const criteriaYear = z.union([z.number().int().min(1000, YEAR_FORM).max(9999, YEAR_FORM), z.string().regex(/^\d{4}$/, YEAR_FORM)], { error: YEAR_FORM });
const oneOrList = () => z.union([z.string(), z.array(z.string())], { error: 'a string or a list of strings' }).nullable().optional();
// The field descriptions are published once, on lex_create_webhook; the
// update tool takes the same schema and points there.
const webhookCriteria = (describe: boolean) => {
  const d = <T extends z.ZodType>(schema: T, text: string): T => (describe ? schema.describe(text) : schema);
  return z.object({
    query: d(z.string().nullable().optional(), 'Words that must all appear in the title (whole words; 4+ characters match word starts; trailing * for prefixes).'),
    documentType: d(oneOrList(), 'Document type(s), lex_search values.'),
    author: d(oneOrList(), 'Issuing institution(s), lex_search values.'),
    subdomain: d(oneOrList(), 'Replaces the default (EU law, no consolidated texts); "consolidated" = consolidated texts only.'),
    dateFrom: d(isoDate().nullable().optional(), 'Lower bound on the document date (YYYY-MM-DD).'),
    dateTo: d(isoDate().nullable().optional(), 'Upper bound on the document date (YYYY-MM-DD).'),
    year: d(z.union([criteriaYear, z.array(criteriaYear)], { error: YEAR_FORM }).nullable().optional(), 'Document year(s).'),
    textScope: d(z.enum(['title', 'title-text', 'any']).nullable().optional(), 'Accepted for compatibility; every value matches titles.'),
    domain: d(z.string().refine((v) => ['EU_LAW', 'ALL'].includes(v.toUpperCase()), 'EU_LAW or ALL').nullable().optional(),
      'EU_LAW or ALL (any case). Accepted for compatibility; only EU law is matched.'),
    language: d(z.string().nullable().optional(), 'Accepted for compatibility; no effect.'),
  }).strict();
};

const view = z.enum(['auto', 'outline', 'full']).default('auto').describe(
  'auto: the body if it fits maxChars, else an outline. full: body up to maxChars, then offset to continue.',
);
const maxChars = (def: number) => z.number().int().min(2000).max(200_000).default(def)
  .describe(`Text budget in characters (default ${def}).`);
const offset = wholeNumber(0).optional()
  .describe('Continue after a truncated response (value given in its note).');
const include = z.array(z.enum(CONTENT_PARTS)).min(1).optional().describe(
  'Only these parts. "paragraphs" = judgment grounds / text of documents without articles.',
);
const oneArticle = (d = 'Return only this article: "17", "art_17", "Article 17", "6a".') =>
  z.string().trim().min(1).max(40).optional().describe(d);
const acceptLanguages = (d: string) => z.union([z.array(lang()).min(1), z.literal('any')]).optional().describe(d);

/**
 * Text sent composed (NFC). Its length is checked on the composed form, the
 * one the API counts; the limits are published as minLength / maxLength.
 */
const composed = (min: number, max: number) => z.string().trim().transform((v) => v.normalize('NFC'))
  .pipe(z.string().min(min).max(max))
  .meta({ minLength: min, maxLength: max });
/** A national document id as it is sent: composed (NFC), as the API stores ids; its case is kept. */
const nationalId = () => composed(1, 200);

/** The id as it is sent: upper case and, for a national id with accented letters, composed (NFC). */
export function normCelex(v: string): string {
  return v.trim().replace(/^CELEX:/i, '').toUpperCase().normalize('NFC');
}

// ── Tool plumbing ─────────────────────────────────────────────────────
export interface ToolAnnotations {
  readOnlyHint: boolean;
  /** Always stated, also on read-only tools (false): some hosts require the three hints to be explicit. */
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  /**
   * The OAuth scope a connection needs to see and call the tool. It is the
   * scope the LexAPI API requires for the routes the tool calls. API keys
   * are not subject to scopes.
   */
  scope: ToolScope;
  title: string;
  description: string;
  /** The description shown in read-only mode, when `description` names a tool that mode hides. */
  readOnlyDescription?: string;
  /** The description shown to an OAuth connection without lex:read, when `description` names a read tool. */
  withoutReadDescription?: string;
  inputSchema: z.ZodRawShape;
  /** Parameters outside inputSchema are a validation error (otherwise they are dropped). */
  strict?: boolean;
  annotations: ToolAnnotations;
  /** Not read-only (webhooks, citation extraction). Hidden when LEXAPI_MCP_READ_ONLY is set. */
  write?: boolean;
  handler: (args: any, client: LexAPIClient) => Promise<unknown>;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/**
 * For `.catch()`: a 402 on a call that reserves more credits than it costs
 * gets a sentence saying so; every other error passes through unchanged.
 */
function explain402(why: string) {
  return (err: unknown): never => {
    if (err instanceof LexAPIError && err.status === 402 && err.code === 'CREDITS_EXHAUSTED') {
      throw new LexAPIError(err.status, err.code, `${err.message.trim().replace(/[.\s]+$/, '')}. ${why}`, err.details, err.retryAfterSeconds, err.resetsAt);
    }
    throw err;
  };
}

/**
 * For `.catch()`: the API's 404 for the route itself (a deployment older
 * than the endpoint) becomes an error that says so. The endpoint's own 404,
 * for a document it does not know, passes through unchanged.
 */
function endpointSince(apiVersion: string, route: string, meanwhile: string) {
  return (err: unknown): never => {
    if (isUnknownEndpoint(err)) {
      throw new LexAPIError(404, ENDPOINT_NOT_AVAILABLE, `This LexAPI deployment does not offer this endpoint yet (${route}, LexAPI API ${apiVersion} or later). ${meanwhile}`);
    }
    throw err;
  };
}

const SNAPSHOT_SEMANTICS = 'Observation snapshots (as fetched by LexAPI), not the law in force on a date.';

const NATIONAL_READ_402 = 'A national document read reserves 5 credits and settles at 1, so the pool must hold 5.';

/** Attach the low-credit notice (if any) to a shaped result. */
function withNotice(res: LexResponse<Json>, shaped: Record<string, unknown>): Record<string, unknown> {
  const notice = creditNotice(res.body);
  return notice ? { ...shaped, notice } : shaped;
}

/** Attach the national-law allowance (FREE/STARTER/PROFESSIONAL only), when the response carried it. */
function withAllowance(res: LexResponse<Json>, shaped: Record<string, unknown>): Record<string, unknown> {
  const allowance = nationalAllowanceOf(res.headers);
  return allowance ? { ...shaped, allowance } : shaped;
}

interface DocArgs {
  include?: string[];
  articleId?: string;
  view?: View;
  maxChars?: number;
  offset?: number;
}

/** API `include` for a document request — articleId alone means "metadata + that article". */
function apiInclude(a: DocArgs): string[] | undefined {
  if (a.include?.length) return a.include;
  if (a.articleId) return ['metadata', 'articles'];
  return undefined;
}

/** The API answers an unmatched articleId with `articles: []`, not an error — say so. */
function noteArticleMiss(a: DocArgs, shaped: Record<string, unknown>): Record<string, unknown> {
  if (!a.articleId || shaped.content === null) return shaped;
  const c = isObj(shaped.content) ? shaped.content : {};
  if (Array.isArray(c.articles) && c.articles.length) return shaped;
  return {
    ...shaped,
    note: `No article matched articleId "${a.articleId}". The outline (article ids, or paragraphs for documents without articles) is returned without articleId.`,
  };
}

/**
 * Shaping options. An articleId (or include) means "read these parts": the
 * selected parts are returned (paged by maxChars/offset), never re-outlined —
 * otherwise a large article would bounce the model back to the outline it
 * just used.
 */
function contentOpts(a: DocArgs, budget?: number) {
  const include = a.include?.length ? a.include : a.articleId ? ['articles'] : undefined;
  return {
    view: a.view,
    maxChars: budget ?? a.maxChars ?? 40_000,
    include,
    offset: a.offset,
  };
}

// ── Tools ─────────────────────────────────────────────────────────────
export const tools: ToolDef[] = [
  // ── Account ─────────────────────────────────────────────────────────
  {
    name: 'lex_info',
    scope: SCOPE_READ,
    title: 'LexAPI account & capabilities',
    description:
      "The caller's LexAPI plan, its limits (subscription: maxPages, maxBatchSize, maxWebhooks, rate limit), the credit balance (remaining, reset date), plus the accepted values for search filters. Free (0 credits). Also confirms the connection works.",
    inputSchema: {},
    annotations: READ,
    handler: async (_a, client) => {
      const res = await client.info();
      const b = res.body;
      return compact({
        service: b.service,
        apiVersion: b.version,
        subscription: b.subscription,
        credits: isObj(b.credits) ? compact({ ...b.credits, operation_weight: undefined }) : undefined,
        usage: b.credits ? undefined : b.usage,
        searchFilters: b.searchFilters,
        supportedLanguages: Array.isArray(b.supportedLanguages) ? b.supportedLanguages.join(',') : undefined,
      });
    },
  },

  // ── Workflows ───────────────────────────────────────────────────────
  // One common job each, made of the calls the tools below make one at a
  // time (src/workflows.ts). They add no data of their own.
  {
    name: 'lex_check_citation',
    scope: SCOPE_READ,
    title: 'Check a citation against the source',
    description:
      'Look a citation up: whether the document exists, its canonical id, title and link, whether a given article is in its text, and whether the act is in force today. Takes a CELEX, EUR-Lex URL, ELI or ECLI, or a national document id. exists, inForce and article.found are "unknown" when the check could not be made, which does not mean that the document or article does not exist; notChecked lists what could not be checked and why. article.found: true shows that the article unit is in the text compared, not that the citation supports a claim. inForce does not cover amendments and is not recorded for many acts. The article is looked up in the identified text (the act as published, unless a consolidated CELEX is given). For an EU act (CELEX sector 3), latestConsolidated is "not_reported" unless the API has it, which does not mean none exists. A national result carries attribution, which must be kept with republished content (Terms). Cost: 1 credit to resolve a URL, ELI or ECLI (a CELEX is not resolved), plus one read: 1 credit from the corpus, 4 via the Publications Office, 5 live; an article that is not matched can cost a second read. A national id: 1 credit. At most 11 credits.',
    inputSchema: {
      identifier: z.string().trim().min(3).max(2000).describe('CELEX, EUR-Lex URL, ELI URI or ECLI, or a national document id such as "AT-NOR-12345".'),
      article: oneArticle('Also look this article up among the text\'s article units: "17", "Art. 17", "Article 17(1)" (a paragraph or point is not checked); for a national id, the unit number as the source writes it, e.g. "§ 17".'),
      date: isoDate('Compare this date (YYYY-MM-DD) with the document date, entry into force and end of validity the API returns (onDate).').optional(),
    },
    annotations: READ,
    handler: (a, client) => (isNationalId(a.identifier)
      ? checkCitation(a, client).catch(explain402(NATIONAL_READ_402))
      : checkCitation(a, client)),
  },

  {
    name: 'lex_act_history',
    scope: SCOPE_READ,
    title: 'Changes to an EU act',
    description:
      'The acts that amend, correct (corrigenda) or repeal an EU act, from LexAPI\'s citation graph, with the act\'s title, dates, in-force status today and end of validity. Limits of the data: a relation carries no date, so each entry has the year of its CELEX number (corrigenda have none) and a document date only where dates read it, and since filters on those; a partial repeal is recorded as an amendment; relations are as current as their last refresh (completeness); consolidated versions are shown only when the API reports them ("not_reported" otherwise), never as a full list. An empty list is not proof that nothing changed. Cost: 1 credit per page of relations, plus the act\'s metadata (1 credit from the corpus, 4 via the Publications Office, 5 live), plus the same for each date read (dates, default 0, at most 10): 2–6 credits without dates, at most 56.',
    inputSchema: {
      celexNumber: celex('CELEX number of the act').describe('CELEX number of the act, e.g. 32016R0679; a consolidated CELEX is read as its base act.'),
      since: isoDate('Keep changes from this date on (YYYY-MM-DD): by CELEX year, and by document date where one was read.').optional(),
      dates: z.number().int().min(0).max(10).default(0).describe('Read the document date of up to this many listed acts (one metadata read each), first those the year cannot place.'),
      limit: z.number().int().min(1).max(500).default(100).describe('Relations per page.'),
      offset: edgeOffset,
      language: titleLanguage,
    },
    annotations: READ,
    handler: (a, client) => actHistory(a, client),
  },

  {
    name: 'lex_research',
    scope: SCOPE_READ,
    title: 'Search EU and national law in one call',
    description:
      'One query run as semantic searches over EU legislation, EU case law and the legislation and case law of chosen live countries, returned as one list. Each hit names its jurisdiction and kind and keeps its identifiers; a national hit keeps its attribution, which must be kept with republished content (Terms). Legislation hits carry inForce ("unknown" when no status is reported); an EU case-law hit has none, and a national decision carries inForce: false once its recorded end of validity has passed. sources lists every search as ok, failed or not_run with the reason (country not live, plan, national allowance, rate limit, credits): a search that did not run is not shown as empty, and none starts once credits or the rate limit run out. Scores come from separate indexes, so the order across sources is approximate. Cost: 5 credits per search; searches = jurisdictions × kinds: 2 by default, at most 16 (80 credits). Each national search also counts against the national-law allowance. For filters, asOf, hyde or paging use the single-index search tools.',
    inputSchema: {
      query: z.string().trim().min(3).max(1000).describe('Natural-language description of the provision or legal issue.'),
      jurisdictions: codeList('Where to search: "eu" and/or national codes, e.g. ["eu","at","de"] (default ["eu"]; at most 8, "eu" included; each adds up to 10 credits).', 8).optional(),
      kinds: z.array(z.enum(['legislation', 'case_law'])).min(1).optional().describe('What to search in each jurisdiction (default both).'),
      limit: z.number().int().min(1).max(20).default(5).describe('Max hits per search (plan caps as on the semantic tools).'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor for every search (default ≈0.7).'),
      language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Preferred language of EU texts (default en); a national search uses the country\'s own language.'),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: (a, client) => research(a, client),
  },

  // ── Search ──────────────────────────────────────────────────────────
  {
    name: 'lex_search',
    scope: SCOPE_READ,
    title: 'Search EUR-Lex',
    description:
      'Structured EUR-Lex search: keywords plus filters (dates, type, author, procedure, collection) → CELEX numbers, titles, dates (the full text is read with lex_get_document). Matching is literal and works best with 1–3 distinctive terms; lex_semantic_legislation / lex_semantic_case_law search by meaning. Cost: 3 credits per result page (~10 results; unfetched pages refunded).',
    inputSchema: {
      query: z.string().max(1000).optional().describe('Search text. Quotes force an exact phrase. "*" = no text constraint (filter-only search).'),
      textScope: z.enum(['title', 'text', 'title-text', 'any']).optional().describe('Where the text must match (API default title-text).'),
      dateFrom: isoDate('Document date from (inclusive, YYYY-MM-DD).').optional(),
      dateTo: isoDate('Document date to (inclusive, YYYY-MM-DD).').optional(),
      year: z.union([z.number().int().min(1950).max(2100), z.array(z.number().int().min(1950).max(2100)).min(1)]).optional().describe('Document year(s).'),
      month: z.union([z.number().int().min(1).max(12), z.array(z.number().int().min(1).max(12)).min(1)]).optional().describe('Month(s) 1–12, combined with year.'),
      documentType: oneOrMany(DOCUMENT_TYPES, 'Document type(s). Several types fan out into one EUR-Lex query each.').optional(),
      author: oneOrMany(AUTHORS, 'Issuing institution(s).').optional(),
      procedure: oneOrMany(PROCEDURES, 'Legislative procedure(s).').optional(),
      domain: z.enum(['EU_LAW', 'NATIONAL_LAW', 'ALL']).optional().describe(`EUR-Lex collection. ${NATIONAL_DOMAIN_NOTE}`),
      subdomain: oneOrMany(SUBDOMAINS, 'EUR-Lex sub-collection(s), e.g. "case-law", "legislation", "consolidated"; the national case-law value is EUR-Lex\'s own collection, not the lex_national_* tools.').optional(),
      language: lang('Result language (default en).').optional(),
      maxPages: z.number().int().min(1).max(100).default(1).describe('Result pages to fetch (3 credits each; clamped to the plan\'s maxPages, see lex_info). More pages help when a tight date filter reports postFilteredBy "date".'),
      fresh: z.boolean().optional().describe('Bypass the 60-minute result cache.'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.search(compact(a));
      return withNotice(res, shapeSearch(res));
    },
  },

  {
    name: 'lex_recent_documents',
    scope: SCOPE_READ,
    title: 'Recently published EU documents',
    description:
      'Documents published on EUR-Lex in the last N days (default 7), newest first, optionally filtered (e.g. what was published this week). Cost: 3 credits per 10 results of limit (default 20 → 6; clamped to the plan); an unfiltered request is usually answered by one query for 3 credits.',
    inputSchema: {
      days: z.number().int().min(1).max(366).default(7).describe('Look-back window in days.'),
      documentType: z.enum(DOCUMENT_TYPES).optional().describe('Only this document type.'),
      author: z.enum(AUTHORS).optional().describe('Only this issuing institution.'),
      domain: z.enum(['EU_LAW', 'NATIONAL_LAW', 'ALL']).optional().describe(`EUR-Lex collection. ${NATIONAL_DOMAIN_NOTE}`),
      subdomain: z.enum(SUBDOMAINS).optional().describe('EUR-Lex sub-collection; the national case-law value is EUR-Lex\'s own collection, not the lex_national_* tools.'),
      language: lang('Keep documents available in this language (default en).').optional(),
      limit: z.number().int().min(1).max(500).default(20).describe('Max results.'),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.recentDocuments(a);
      return withNotice(res, shapeRecent(res));
    },
  },

  {
    name: 'lex_resolve',
    scope: SCOPE_READ,
    title: 'Resolve a legal identifier to CELEX',
    description:
      'Turn a EUR-Lex URL, an ELI URI, an ECLI (e.g. ECLI:EU:C:2020:559) or a bare CELEX into the canonical CELEX number plus EUR-Lex links. ECLIs resolve only for case law in the LexAPI corpus (404 otherwise). resolvedVia: celex, url, ecli-corpus, eli-corpus, eli-cellar (Publications Office register) or eli (derived from the ELI pattern, unverified). verified: false is normal for CELEX and URL inputs, which are not looked up. Cost: 1 credit.',
    inputSchema: {
      identifier: z.string().trim().min(3).max(2000).describe('CELEX, EUR-Lex URL, ELI URI or ECLI.'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.resolve({ identifier: a.identifier });
      return withNotice(res, stripEnvelope(res.body));
    },
  },

  // ── Documents ───────────────────────────────────────────────────────
  {
    name: 'lex_get_document',
    scope: SCOPE_READ,
    title: 'Fetch an EU document by CELEX',
    description:
      'A parsed EU document by CELEX: metadata plus body (articles, recitals, judgment paragraphs, annexes). Large documents return an outline first; articleId returns one article and include returns selected parts. content: null means no published text — textAvailability says why and may point to the latest consolidated version. Consolidated CELEXes (0…-YYYYMMDD) are labelled as not the authentic text, with the base act. Cost: 1 credit from the corpus, 4 via the Publications Office, 5 live (every call is charged).',
    inputSchema: {
      celexNumber: celex(),
      language: lang('Language of the whole document (default en). Falls back to English, labelled languageFallback, when EUR-Lex lacks it.').optional(),
      acceptLanguages: acceptLanguages('Fallback languages to serve when the requested one has no text (e.g. ["fr"] for General Court decisions), or "any".'),
      articleId: oneArticle(),
      include,
      view,
      maxChars: maxChars(40_000),
      offset,
      bypassCorpus: z.boolean().optional().describe('Force a fresh upstream read instead of the stored copy (charged at the live rate).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const body = compact({
        celexNumber: normCelex(a.celexNumber),
        language: a.language,
        acceptLanguages: a.acceptLanguages,
        articleId: a.articleId,
        include: apiInclude(a),
        bypassCorpus: a.bypassCorpus,
      });
      const res = await client.getDocument(body);
      return withNotice(res, noteArticleMiss(a, shapeDocument(res.body.document, res.headers, contentOpts(a))));
    },
  },

  {
    name: 'lex_get_documents_batch',
    scope: SCOPE_READ,
    title: 'Fetch several EU documents',
    description:
      'Fetch up to 50 documents by CELEX in one call (clamped to the plan\'s maxBatchSize, see lex_info). Per-document failures are listed in errors; documents without published text stay in documents with textAvailability. Same per-document cost as lex_get_document (1 / 4 / 5 credits); trimmed items are not charged.',
    inputSchema: {
      celexNumbers: z.array(celex()).min(1).max(50).describe('CELEX numbers.'),
      language: lang().optional(),
      acceptLanguages: acceptLanguages('As in lex_get_document.'),
      articleId: oneArticle('Return only this article of each document.'),
      include,
      view: z.enum(['auto', 'outline', 'full']).optional().describe('Per document. Default: outline, except when articleId or include is given (then those parts are returned).'),
      maxChars: maxChars(60_000).describe('Character budget shared by all documents.'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.getDocumentsBatch(compact({
        celexNumbers: (a.celexNumbers as string[]).map(normCelex),
        language: a.language,
        acceptLanguages: a.acceptLanguages,
        articleId: a.articleId,
        include: apiInclude(a),
      }));
      const b = res.body;
      const docs = Array.isArray(b.documents) ? b.documents : [];
      // The budget is shared: per-document shares never add up past maxChars.
      const per = Math.max(500, Math.floor((a.maxChars ?? 60_000) / Math.max(1, docs.length)));
      const batchView: View = a.view ?? (a.articleId || a.include?.length ? 'auto' : 'outline');
      return withNotice(res, compact({
        requested: b.requested,
        processed: b.processed,
        successful: b.successful,
        failed: b.failed,
        textUnavailable: b.textUnavailable,
        trimmedReason: b.trimmed ? b.trimmedReason : undefined,
        documents: docs.map((d) => shapeDocument(d, {}, contentOpts({ ...a, view: batchView, offset: undefined }, per))),
        errors: b.errors,
      }));
    },
  },

  {
    name: 'lex_get_metadata',
    scope: SCOPE_READ,
    title: 'EU document metadata',
    description:
      'Metadata only for a CELEX — title, type, author, dates, ECLI/ELI, EuroVoc keywords, EUR-Lex link — without the body. Cost: 1 credit from the corpus, 4 via the Publications Office, 5 live.',
    inputSchema: {
      celexNumber: celex(),
      bypassCorpus: z.boolean().optional().describe('Force a fresh upstream read (live rate).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.getMetadata(compact({ celexNumber: normCelex(a.celexNumber), bypassCorpus: a.bypassCorpus }));
      const md = isObj(res.body.metadata) ? res.body.metadata : {};
      return withNotice(res, shapeMetadata(md, res.headers));
    },
  },

  {
    name: 'lex_get_document_by_url',
    scope: SCOPE_READ,
    title: 'Fetch an EU document by EUR-Lex URL',
    description:
      'Same as lex_get_document, for a eur-lex.europa.eu URL the user pasted (the CELEX is extracted from CELEX:… or uri=…). Returns the English text. ELI and ECLI links are resolved by lex_resolve. Cost: 1 / 4 / 5 credits by source.',
    inputSchema: {
      url: z.string().trim().url().describe('A eur-lex.europa.eu URL containing CELEX:<id> or uri=CELEX:<id>.'),
      articleId: oneArticle('As in lex_get_document.'),
      include,
      view,
      maxChars: maxChars(40_000),
      offset,
      bypassCorpus: z.boolean().optional().describe('Force a fresh upstream read (live rate).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.getDocumentByUrl(compact({
        url: a.url,
        articleId: a.articleId,
        include: apiInclude(a),
        bypassCorpus: a.bypassCorpus,
      }));
      return withNotice(res, noteArticleMiss(a, {
        extractedCelex: res.body.extractedCelex,
        ...shapeDocument(res.body.document, res.headers, contentOpts(a)),
      }));
    },
  },

  {
    name: 'lex_legislation_as_of',
    scope: SCOPE_READ,
    title: 'The version of an EU act for a date',
    description:
      'For a known EU regulation, directive or decision and a date: the version the Publications Office lists for that date (the newest consolidated version dated on or before it, else the act as published in the Official Journal) and, with provision, the text of one article, annex or recitals in it. lex_semantic_legislation with asOf is the search by meaning. The version and text are established only when asOfResolved is true; otherwise asOfReason says why and no text is returned. It does not say whether an individual provision applied on the date; act.inForceToday is about today; a retroactive amendment counts from the date of the amending act. Consolidated versions have no legal force; the authentic act is baseCelex as published in the Official Journal. Cost: 1 credit when no text is fetched; when the provision\'s text is fetched, 4 via the Publications Office or 5 live, whatever the answer (1 if the fetch fails or finds no text).',
    inputSchema: {
      document: actCelex().describe('CELEX number of the act, e.g. 32016R0679; a consolidated CELEX is read as its base act. lex_resolve turns a URL or ELI into one.'),
      asOf: isoDate('The date (YYYY-MM-DD, 1952-01-01 to today (UTC)).'),
      provision: z.string().trim().min(1).max(40).optional().describe('One whole article ("art_5", "5", "6a"), an annex by the numeral or letter in its heading ("anx_III"), or recitals ("rct_26", "rct_26-28"; at most 50). Paragraphs and points are not addressable. Omitted: the version only.'),
      language: lang('Language of the text (default en).').optional(),
    },
    strict: true,
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.legislationAsOf(compact({
        document: normCelex(a.document),
        asOf: a.asOf,
        provision: a.provision,
        language: a.language,
      })).catch(endpointSince('2.26.0', 'POST /legislation/as-of', 'lex_semantic_legislation with asOf, and lex_get_document with a consolidated CELEX, do not need it.'));
      return withNotice(res, shapeAsOfLookup(res.body));
    },
  },

  // ── Version history (observation snapshots) ─────────────────────────
  {
    name: 'lex_document_versions',
    scope: SCOPE_READ,
    title: 'Version history of a document',
    description:
      "Every text change LexAPI observed on a document, newest first, with observedFrom (when the version began; absent if not recorded). These are LexAPI's fetch snapshots, NOT the law in force on a date (lex_legislation_as_of gives the version of an EU act for a date). History starts when the document entered the corpus. Cost: 1 credit.",
    inputSchema: {
      celexNumber: celex(),
      language: lang().optional(),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.listVersions(normCelex(a.celexNumber), { language: a.language });
      const b = res.body;
      return withNotice(res, compact({
        celex: b.celex,
        language: b.language,
        currentVersion: b.currentVersion,
        trackedSince: b.trackedSince,
        versions: Array.isArray(b.versions)
          ? b.versions.map((v) => (isObj(v) ? compact({
            version: v.version,
            isCurrent: v.isCurrent || undefined,
            observedFrom: v.observedFrom,
            fetchedAt: v.fetchedAt,
            contentHash: typeof v.contentHash === 'string' ? v.contentHash.slice(0, 12) : undefined,
            title: v.title,
          }) : v))
          : [],
        semantics: SNAPSHOT_SEMANTICS,
      }));
    },
  },

  {
    name: 'lex_get_document_version',
    scope: SCOPE_READ,
    title: 'A document snapshot by version or date',
    description:
      'One observed snapshot: by version number, or the one LexAPI held at the end of a date (YYYY-MM-DD), with observedFrom / observedUntil. LexAPI\'s fetch history, NOT the law in force on that date (lex_legislation_as_of gives the version of an EU act for a date). A date before the document entered the corpus is a 404 (before_tracking); one LexAPI cannot place is a 404 (boundary_unknown) listing the candidate versions, refunded. Cost: 1 credit.',
    inputSchema: {
      celexNumber: celex(),
      version: wholeNumber(1).optional().describe('Snapshot number (from lex_document_versions).'),
      date: isoDate('Return the snapshot current on this date (YYYY-MM-DD, end of day UTC).').optional(),
      language: lang().optional(),
      include,
      view,
      maxChars: maxChars(40_000),
      offset,
    },
    annotations: READ,
    handler: async (a, client) => {
      if ((a.version === undefined) === (a.date === undefined)) {
        throw new Error('Pass exactly one of version or date.');
      }
      const c = normCelex(a.celexNumber);
      const res = a.version !== undefined
        ? await client.getVersion(c, a.version, { language: a.language })
        : await client.getAtDate(c, a.date, { language: a.language });
      const b = res.body;
      const d = isObj(b.document) ? b.document : {};
      const { content, note } = shapeContent(d.parsedContent, contentOpts(a));
      return withNotice(res, compact({
        celex: b.celex,
        language: b.language,
        // The API calls this `asOf`; it is the date the snapshot was looked up
        // for, not an in-force date, so it gets its own name here.
        snapshotDate: b.asOf,
        kind: b.kind,
        dateInFuture: b.dateInFuture === true ? true : undefined,
        warning: res.headers['x-warning'],
        version: d.version,
        isCurrent: d.isCurrent,
        observedFrom: d.observedFrom,
        observedUntil: d.observedUntil,
        fetchedAt: d.fetchedAt,
        title: d.title,
        documentType: d.documentType,
        content,
        note,
        semantics: SNAPSHOT_SEMANTICS,
        inForceLookup: isObj(b.inForceLookup) ? 'lex_legislation_as_of gives the version of this EU act for a date.' : undefined,
      }));
    },
  },

  // ── Semantic search ─────────────────────────────────────────────────
  {
    name: 'lex_semantic_legislation',
    scope: SCOPE_READ,
    title: 'Semantic search over EU legislation',
    description:
      'Find EU legislation articles by meaning. Hits: law_id (CELEX), article_ref, law_title, score, snippet. An article_ref art_N is the articleId for lex_get_document; any other form (anx_N annex, rct_a-b recitals, par_N / j_N text windows) is not an article id, and lex_get_document include reads those parts. Consolidated hits (consolidated: true) are not the authentic text; baseCelex names the authentic act. asOf gives each hit the version listed for a date. For today\'s version, pass today\'s date (UTC) as asOf and use only hits with asOfResolved: true. Without asOf, acts no longer in force are marked inForce: false where their status is known; since-amended or repealed provisions are not marked. Cost: 5 credits; with asOf, plus up to 5 per version fetched live (at most 3 per request; failed fetches free).',
    inputSchema: {
      query: z.string().trim().min(1).max(1000).describe('Natural-language description of the provision you are looking for.'),
      asOf: isoDate('Date (YYYY-MM-DD, 1952-01-01 to today (UTC)). Resolved hits (asOfResolved: true, asOfVersion) carry the version listed for that date, which does not say whether a provision applied then. Unresolved hits keep the indexed text with an asOfReason, explained in asOfCaveat. Omitted: the indexed texts as they are (the act as published, or its latest consolidated version where indexed).').optional(),
      limit: z.number().int().min(1).max(50).default(10).describe('Max hits (plan cap: FREE 10, STARTER 20, higher 50). Merged consolidated/base duplicates can make a page shorter.'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor. Default ≈0.7 server-side; a lower value (e.g. 0.5) returns more hits, 0 disables it.'),
      language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Preferred language of the text (default en); acts without it come back in another language, labelled.'),
      include: z.array(z.literal('text')).optional().describe('["text"] returns the full matched article text instead of a ~600-character snippet.'),
      filters: z.object({
        language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Same as the top-level language, which wins.'),
      }).strict().optional().describe('Only language is read for legislation; any other key is an error here.'),
      maxChars: maxChars(40_000).describe('Character budget for hit texts when include is ["text"].'),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.semanticLegislation(compact({
        query: a.query,
        asOf: a.asOf,
        limit: a.limit,
        min_score: a.min_score,
        language: a.language,
        include: a.include,
        filters: a.filters,
      }));
      return withNotice(res, budgetHitTexts(shapeLegislation(res), a.maxChars ?? 40_000));
    },
  },

  {
    name: 'lex_semantic_case_law',
    scope: SCOPE_READ,
    title: 'Semantic search over EU case law',
    description:
      'Find CJEU / General Court judgments, orders and AG opinions by meaning. Returns cases with celex (the id works with lex_get_document), case number, ECLI, court, date, score and a summary. Cost: 5 credits (15 with hyde, refunded to 5 if it falls back). Leave hyde off unless a short keyword query returns little.',
    inputSchema: {
      query: z.string().trim().min(3).max(1000).describe('Natural-language question or description of the legal issue.'),
      limit: z.number().int().min(1).max(100).default(10).describe('Max cases (plan cap: FREE 10, STARTER 20, PROFESSIONAL 50, higher 100). One result per case.'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor. Default ≈0.7 server-side; a lower value (e.g. 0.5) returns more hits, 0 disables it.'),
      language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Preferred language (default en).'),
      hyde: z.boolean().optional().describe('LLM rewriting of a terse keyword query for better recall (+1–3 s; 15 credits).'),
      include: z.array(z.literal('text')).optional().describe('["text"] returns each judgment\'s full text (large; bounded by maxChars).'),
      filters: z.object({
        court: z.string().optional().describe('Court name as indexed, e.g. "Court of Justice", "General Court".'),
        date_from: isoDate('Decided on or after (YYYY-MM-DD).').optional(),
        date_to: isoDate('Decided on or before (YYYY-MM-DD).').optional(),
        case_number: z.string().optional().describe('Exact case number, e.g. "C-311/18" (direct lookup).'),
        ecli: z.string().optional().describe('Exact ECLI (direct lookup).'),
        language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Same as the top-level language, which wins.'),
      }).strict().optional().describe('Optional filters. Keys other than these are an error (date_from, not dateFrom).'),
      maxChars: maxChars(40_000).describe('Character budget for hit texts when include is ["text"].'),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.semanticCaseLaw(compact({
        query: a.query,
        limit: a.limit,
        min_score: a.min_score,
        language: a.language,
        hyde: a.hyde,
        include: a.include,
        filters: a.filters,
      }));
      return withNotice(res, budgetHitTexts(shapeCaseLaw(res), a.maxChars ?? 40_000));
    },
  },

  // ── National law ─────────────────────────────────────────────────
  // Member-state legislation and case law, alongside the EU_LAW corpus
  // above. A country can be registered on LexAPI before it is available to
  // customers; an unavailable country answers like an unmatched path
  // (404), never a silent empty result. Attribution (source, licence) is
  // kept on every result — it is required, not optional, context.
  {
    name: 'lex_national_coverage',
    scope: SCOPE_READ,
    title: 'National-law coverage',
    description:
      "Countries with national-law coverage: live status, legislation/case-law coverage (counts, dates, courts), semantic-search availability, citation-graph measurements (citationGraph: methods, rates, floors; null = not measured), and sources with licence/attribution. The other national tools serve only the countries listed as live here. Free.",
    inputSchema: {},
    annotations: READ,
    handler: async (_a, client) => {
      const res = await client.nationalCoverage();
      return compact(res.body);
    },
  },

  {
    name: 'lex_list_national_documents',
    scope: SCOPE_READ,
    title: 'Browse national documents',
    description:
      'Browse a country\'s national documents by title/type, newest-first by document date. documentKind ("act" | "decision") tells legislation from case law. Cost: 3 credits per call. Paging: page reaches only the first 1,000 rows; cursor (the previous nextCursor, without page) reaches any depth.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      q: composed(3, 200).optional().describe('Title search, 3–200 characters.'),
      documentType: z.string().trim().min(1).max(200).optional().describe('Document type as stored for this country.'),
      page: wholeNumber(1).optional().describe('1-based page, first 1,000 rows only. Omit when paging with cursor.'),
      cursor: z.string().trim().min(1).optional().describe('Opaque cursor from a previous call\'s nextCursor — pages past the first 1,000 rows. Not combined with page.'),
      limit: z.number().int().min(1).max(100).default(20).describe('Rows per page.'),
      includeRepealed: z.boolean().optional().describe('Also list repealed/superseded acts.'),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.listNationalDocuments(a.jurisdiction, compact({
        q: a.q,
        type: a.documentType,
        page: a.cursor ? undefined : a.page,
        cursor: a.cursor,
        limit: a.limit,
        includeRepealed: a.includeRepealed,
      }));
      const b = res.body;
      const results = Array.isArray(b.results) ? b.results.map(shapeNationalSearchResult) : [];
      // nextCursor is meaningfully `null` ("no more pages") — compact()
      // would otherwise drop it indistinguishably from "absent", the same
      // pitfall `content: null` has elsewhere.
      const shaped: Record<string, unknown> = compact({
        jurisdiction: b.jurisdiction,
        total: b.total,
        totalExact: b.totalExact,
        page: b.page,
        limit: b.limit,
        includeRepealed: b.includeRepealed,
        hasMore: b.hasMore,
        results,
      });
      if (b.hasMore !== undefined) shaped.nextCursor = b.nextCursor ?? null;
      return withAllowance(res, withNotice(res, shaped));
    },
  },

  {
    name: 'lex_get_national_document',
    scope: SCOPE_READ,
    title: 'Fetch a national document',
    description:
      'A national document by id, e.g. "AT-NOR-12345". Same fields in every country: documentKind ("act" | "decision"); decisions add court, chamber, caseNumbers, citedNorms; articles {number, title, section, text, inForceFrom, inForceTo} (text: null = no text for that unit). Large documents return an outline first; view "full" with offset returns the text. content: null = the source publishes no machine-readable text (textAvailability says why). A document its source withdrew returns a distinct error (410) and nothing of it is served. attribution must be kept with republished content (Terms). Cost: 1 credit.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      id: nationalId().describe('National document id, e.g. "AT-NOR-12345".'),
      language: lang('Not needed: documents are held in the country\'s own language, and any other value is a 404.').optional(),
      view,
      maxChars: maxChars(40_000),
      offset,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.getNationalDocument(a.jurisdiction, a.id, compact({ language: a.language }))
        .catch(explain402(NATIONAL_READ_402));
      const shaped = shapeNationalDocument(res.body.document, contentOpts(a));
      return withAllowance(res, withNotice(res, shaped));
    },
  },

  {
    name: 'lex_national_semantic_case_law',
    scope: SCOPE_READ,
    title: 'Semantic search over national case law',
    description:
      'Find one country\'s case law by meaning. Hits carry documentKind, ecli, dateOfDocument, and court/caseNumbers where indexed. partial: true (partialReason SEARCH_INCOMPLETE) means this one search did not finish: better matches may exist, and hint gives the next step. It is not a statement about which documents LexAPI holds, so it does not indicate a coverage gap. Each hit\'s attribution must be kept with republished content (Terms). Cost: 5 credits.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      query: z.string().trim().min(3).max(1000).describe('Natural-language question or description of the legal issue.'),
      limit: z.number().int().min(1).max(100).default(10).describe('Max cases (plan cap, same as lex_semantic_case_law).'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor (default ≈0.7).'),
      language: nationalLanguage,
      include: z.array(z.literal('text')).optional().describe('["text"] returns full judgment text, bounded by maxChars.'),
      filters: z.object({
        court: z.string().optional().describe('Court name as indexed for the country (courts: lex_national_coverage).'),
        date_from: isoDate('Decided on or after (YYYY-MM-DD).').optional(),
        date_to: isoDate('Decided on or before (YYYY-MM-DD).').optional(),
        ecli: z.string().optional().describe('Exact ECLI.'),
      }).strict().optional().describe('Optional filters; no case_number nationally.'),
      maxChars: maxChars(40_000),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.nationalSemanticCaseLaw(a.jurisdiction, compact({
        query: a.query,
        limit: a.limit,
        min_score: a.min_score,
        language: a.language,
        include: a.include,
        filters: a.filters,
      }));
      return withAllowance(res, withNotice(res, budgetHitTexts(shapeNationalCaseLaw(res), a.maxChars ?? 40_000, 'lex_get_national_document')));
    },
  },

  {
    name: 'lex_national_semantic_legislation',
    scope: SCOPE_READ,
    title: 'Semantic search over national legislation',
    description:
      'Find one country\'s legislation articles by meaning. Hits are today\'s indexed wording; in_force (omitted when unknown) says whether the provision is in force today, with valid_from / valid_to where indexed. asOf labels each hit for a date and never returns earlier wording: asOfResolved: true (asOfVersion) only when the publisher\'s dates, as of LexAPI\'s last recorded read of the act (asOfVersion.checkedAt), show that today\'s wording already applied then; otherwise asOfReason, and the hit keeps today\'s text under asOfLabel, not established as the text for the date. asOfVersion.validFrom / validTo are the publisher\'s dates for today\'s wording (validTo absent or null: no end recorded). Hits resolve only in countries where LexAPI holds per-provision dates (Austria and Spain at present); others answer asof_not_available. partial: true (SEARCH_INCOMPLETE): this one search did not finish, better matches may exist (see hint); it does not indicate a coverage gap. Each hit\'s attribution must be kept with republished content (Terms). asOf adds no cost. Cost: 5 credits.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      query: z.string().trim().min(3).max(1000).describe('Natural-language description of the provision you are looking for.'),
      asOf: isoDate('Label each hit for this date (YYYY-MM-DD, 1800-01-01 to today (UTC)). The text stays today\'s: a wording replaced since that date, or a provision LexAPI no longer holds, cannot be found.').optional(),
      limit: z.number().int().min(1).max(50).default(10).describe('Max hits (plan cap, same as lex_semantic_legislation).'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor (default ≈0.7).'),
      language: nationalLanguage,
      include: z.array(z.literal('text')).optional().describe('["text"] returns full article text instead of a snippet.'),
      filters: z.object({
        id: z.string().trim().min(1).optional().describe('A specific national document id.'),
        inForce: z.boolean().optional().describe('In force today (true) or not (false).'),
        documentType: z.string().trim().min(1).optional().describe('The source\'s type label.'),
      }).strict().optional().describe('Optional filters.'),
      maxChars: maxChars(40_000),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.nationalSemanticLegislation(a.jurisdiction, compact({
        query: a.query,
        asOf: a.asOf,
        limit: a.limit,
        min_score: a.min_score,
        language: a.language,
        include: a.include,
        filters: a.filters,
      }));
      return withAllowance(res, withNotice(res, budgetHitTexts(shapeNationalLegislation(res, a.asOf), a.maxChars ?? 40_000, 'lex_get_national_document')));
    },
  },

  // ── Citation graph ──────────────────────────────────────────────────
  {
    name: 'lex_cited_by',
    scope: SCOPE_READ,
    title: 'Documents citing a CELEX',
    description:
      'Inbound citations: documents that cite, amend, correct, repeal, implement, transpose or are based on this act, with the edge type and its provenance. For legislation, amendment / corrigendum / repeal edges are refreshed on read from the Publications Office when stale; relationSync.status "pending" or "skipped" means the stored edges were served and may be incomplete. Other edge types cover only documents LexAPI has extracted. totalEdges is the full count for paging with offset. Cost: 1 credit.',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      ...graphFilters,
      limit: z.number().int().min(1).max(500).default(50).describe('Edges per page.'),
      offset: edgeOffset,
      includeNational,
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const { celexNumber, ...q } = a;
      const res = await client.citedBy(normCelex(celexNumber), q);
      return withNotice(res, shapeCitedBy(res));
    },
  },

  {
    name: 'lex_cites',
    scope: SCOPE_READ,
    title: 'Documents a CELEX cites',
    description:
      'Outbound citations: what this document references, amends, repeals, implements, transposes or is based on, with the edge type and its provenance. Only populated for documents whose citations were extracted (lex_extract_citations). Cost: 1 credit.',
    readOnlyDescription:
      'Outbound citations: what this document references, amends, repeals, implements, transposes or is based on, with the edge type and its provenance. Only populated for documents whose citations were extracted. Cost: 1 credit.',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      ...graphFilters,
      unresolved,
      limit: z.number().int().min(1).max(500).default(50).describe('Edges per page.'),
      offset: edgeOffset,
      includeNational,
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const { celexNumber, ...q } = a;
      const res = await client.cites(normCelex(celexNumber), q);
      return withNotice(res, shapeCites(res));
    },
  },

  {
    name: 'lex_citation_network',
    scope: SCOPE_READ,
    title: 'Citation neighbourhood of a CELEX',
    description:
      'Both directions at once — documents this one cites and documents citing it — deduplicated, with edge types and provenance per neighbour; paging.citesTotal / citedByTotal give the full counts. Cost: 20 credits, refunded on a partial (timeout) answer (lex_cited_by / lex_cites return one direction for 1 credit).',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      ...graphFilters,
      unresolved,
      limit: z.number().int().min(1).max(500).default(50).describe('Edges per direction.'),
      offset: edgeOffset,
      includeNational,
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const { celexNumber, ...q } = a;
      const res = await client.citationNetwork(normCelex(celexNumber), q);
      return withNotice(res, shapeNetwork(res));
    },
  },

  {
    name: 'lex_citation_path',
    scope: SCOPE_READ,
    title: 'Citation path between two documents',
    description:
      'Shortest chain of outbound citations from one document to another (e.g. how a judgment reaches a directive), optionally over filtered edges only. found: false is a normal answer, not an error. Cost: 20 credits.',
    inputSchema: {
      from: celexOrNationalId('Start identifier'),
      to: celexOrNationalId('Target identifier'),
      maxDepth: z.number().int().min(1).max(8).default(3).describe('Max hops.'),
      ...graphFilters,
      includeNational,
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.citationPath(normCelex(a.from), normCelex(a.to), {
        maxDepth: a.maxDepth,
        includeNational: a.includeNational,
        citationType: a.citationType,
        provenance: a.provenance,
        jurisdictions: a.jurisdictions,
        resolution: a.resolution,
        language: a.language,
      });
      const b = stripEnvelope(res.body);
      if (Array.isArray(b.path)) {
        b.path = b.path.map((n) => (isObj(n) ? compact({ ...nodeFields(n), title: n.title }) : n));
      }
      return withNotice(res, compact(b));
    },
  },

  {
    name: 'lex_related',
    scope: SCOPE_READ,
    title: 'Documents related by shared citations',
    description:
      'Documents that cite the most of the same acts as this one (bibliographic coupling) — "what else deals with this"; the edge filters narrow which shared citations count. Needs the seed\'s outbound citations (lex_extract_citations). Cost: 20 credits.',
    readOnlyDescription:
      'Documents that cite the most of the same acts as this one (bibliographic coupling) — "what else deals with this"; the edge filters narrow which shared citations count. Needs the seed\'s outbound citations to be in the graph. Cost: 20 credits.',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      limit: z.number().int().min(1).max(50).default(10).describe('Max related documents.'),
      ...graphFilters,
      includeNational,
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.related(normCelex(a.celexNumber), {
        limit: a.limit,
        includeNational: a.includeNational,
        citationType: a.citationType,
        provenance: a.provenance,
        jurisdictions: a.jurisdictions,
        resolution: a.resolution,
        language: a.language,
      });
      const b = stripEnvelope(res.body, ['method']);
      if (Array.isArray(b.related)) {
        b.related = b.related.map((r) => (isObj(r) ? compact({
          ...nodeFields(r),
          title: r.title,
          sharedCount: r.sharedCount,
          sharedTargets: Array.isArray(r.sharedTargets) ? (r.sharedTargets as unknown[]).slice(0, 10) : undefined,
        }) : r));
      }
      return withNotice(res, compact(b));
    },
  },

  {
    name: 'lex_citation_stats',
    scope: SCOPE_READ,
    title: 'Citation graph statistics',
    description: 'Totals for the whole LexAPI citation graph plus the 10 most-cited and 10 most-citing documents. includeNational also adds byJurisdiction, byProvenance and transposition (notified measures, and how many LexAPI holds). Cost: 20 credits.',
    inputSchema: {
      includeNational,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.citationStats({ includeNational: a.includeNational });
      return withNotice(res, stripEnvelope(res.body));
    },
  },

  {
    name: 'lex_transposition',
    scope: SCOPE_READ,
    title: 'Notified national measures for an EU act',
    description:
      'The measures member states (and the UK) notified to the Commission for an EU act (CELEX sector 3, e.g. a directive), by country, from the Publications Office\'s Cellar records. A notification is not a finding that the measure transposes the act, or transposes it completely; the result\'s note states this. Every plan. On BUSINESS+, for live countries only, it also shows which measures LexAPI holds (id, resolved) and adds relations recorded by the national source (provenance "source"). termsRequired: true = the national-source terms are not yet accepted in the dashboard. source.cellar.attribution is the attribution for the Cellar data and must be kept with republished content (Terms). Output is bounded (limit, ~40,000 characters); more gives the next offset. Cost: 5 credits per call or page.',
    inputSchema: {
      celexNumber: celex('CELEX number of the EU act'),
      jurisdictions: codeList('Only these countries, e.g. ["es","cz"] (EL = Greece, UK = United Kingdom); default all 28.').optional(),
      resolvedOnly: z.boolean().optional().describe('Only measures resolved to a document LexAPI holds (BUSINESS+, live countries).'),
      limit: z.number().int().min(1).max(200).default(50).describe('Measures shown, across countries.'),
      offset: wholeNumber(0).default(0).describe('Skip this many measures (value given in the previous result\'s more).'),
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.transposition(normCelex(a.celexNumber), {
        jurisdictions: a.jurisdictions,
        resolvedOnly: a.resolvedOnly,
        language: a.language,
      });
      return withNotice(res, shapeTransposition(res, a.limit ?? 50, a.offset ?? 0));
    },
  },

  {
    name: 'lex_counterparts',
    scope: SCOPE_READ,
    title: 'Counterparts of a national act in other countries',
    description:
      'A national document\'s counterparts in the other live countries, through the EU acts it is linked to (via): by a link the national source records or by its notification to the Commission as a measure. Ranked: 1 = recorded by the national source; 2 = a notified measure LexAPI holds; 3 = a notified Cellar record LexAPI does not hold (no id). An EU act (CELEX sector 3) as id groups its measures the same way. Only live countries are returned (see lex_national_coverage). A notification is not a finding that the measure transposes the act. BUSINESS+ only; the national-law allowance does not apply. Output is bounded (limit per act, up to 25 acts, ~40,000 characters); more gives the next offset, and jurisdictions narrows the lookup. Cost: 20 credits per call or page.',
    inputSchema: {
      id: celexOrNationalId('National document id or EU act CELEX'),
      jurisdictions: codeList('Only these live countries, e.g. ["si","es"]; default every live one.').optional(),
      limit: z.number().int().min(1).max(50).default(10).describe('Counterparts shown per EU act.'),
      offset: wholeNumber(0).default(0).describe('Skip this many EU acts (value given in more).'),
      language: titleLanguage,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.counterparts(normCelex(a.id), { jurisdictions: a.jurisdictions, language: a.language });
      return withNotice(res, shapeCounterparts(res, a.limit ?? 10, a.offset ?? 0, 25));
    },
  },

  {
    name: 'lex_extract_citations',
    scope: SCOPE_READ,
    title: 'Extract a document\'s citations',
    description:
      'Writes to LexAPI\'s shared citation graph: reads a document\'s EUR-Lex notice and adds its outbound citations to the graph, so lex_cites / lex_related work for it. Idempotent: returns alreadyExtracted when done before. Cost: 5 credits (1 when already extracted).',
    inputSchema: { celexNumber: celex() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    // Writes to the shared citation graph and spends credits: hidden in read-only mode like the other writes.
    write: true,
    handler: async (a, client) => {
      const res = await client.extractCitations({ celexNumber: normCelex(a.celexNumber) });
      const b = stripEnvelope(res.body);
      if (Array.isArray(b.citations)) {
        const all = b.citations as unknown[];
        b.citations = all.slice(0, 100).map((c) => (isObj(c) ? compact({ celex: c.targetCelex, type: c.citationType }) : c));
        if (all.length > 100) b.note = `${all.length - 100} more citations stored; read them with lex_cites.`;
      }
      return withNotice(res, compact(b));
    },
  },

  // ── Export ──────────────────────────────────────────────────────────
  {
    name: 'lex_export',
    scope: SCOPE_READ,
    title: 'Export corpus rows',
    description:
      'Rows from the LexAPI corpus matching filters — e.g. regulations dated 2024 or documents whose text changed since a date. BUSINESS+ only. An export that fails part-way is reported as incomplete. Cost: 1 credit per row returned, at least 1 per call. Bulk export for ML training needs a separate licence (Terms §6).',
    inputSchema: {
      documentType: z.array(z.string().min(1)).min(1).optional().describe('Stored document-type labels, matched exactly but ignoring case, e.g. ["Regulation","Directive"]: "regulation" matches Regulation, not Implementing regulation (use documentTypeCode for the family).'),
      documentTypeCode: z.array(z.string().min(1)).min(1).optional().describe('Type families by documentTypeCode, e.g. ["regulation"] — includes implementing and delegated regulations. Combined with documentType, both must match.'),
      author: z.array(z.string().min(1)).min(1).optional().describe('Stored author values, matched whole and ignoring case (a joint act\'s "European Parliament, Council of the European Union" is one value).'),
      subdomain: z.array(z.enum(['treaties', 'international', 'legislation', 'internal', 'preparatory', 'case-law', 'national-transposition', 'national-case-law', 'questions', 'consolidated'])).min(1).optional()
        .describe('EUR-Lex sub-collection(s). The national-* values are EUR-Lex\'s own collections; member-state law is in the lex_national_* tools.'),
      language: lang().optional(),
      dateFrom: isoDate('Document date from (inclusive, YYYY-MM-DD).').optional(),
      dateTo: isoDate('Document date to (inclusive, YYYY-MM-DD).').optional(),
      changedSince: since('Only rows whose text changed at or after this time — the cheapest incremental sync.').optional(),
      fetchedSince: since('Only rows written to at or after this time (any update, including metadata-only); changedSince covers text changes only.').optional(),
      includeContent: z.boolean().default(false).describe('Include each row\'s parsed body (bounded by maxChars).'),
      includeStubs: z.boolean().optional().describe('Also rows whose text EUR-Lex does not publish.'),
      limit: z.number().int().min(1).max(200).default(20).describe('Rows (1 credit each; at least 1 credit per call).'),
      maxChars: maxChars(40_000),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.exportCorpus({
        documentType: a.documentType,
        documentTypeCode: a.documentTypeCode,
        author: a.author,
        subdomain: a.subdomain,
        language: a.language,
        dateFrom: a.dateFrom,
        dateTo: a.dateTo,
        changedSince: a.changedSince,
        fetchedSince: a.fetchedSince,
        includeContent: a.includeContent ? 'true' : 'false',
        includeStubs: a.includeStubs ? 'true' : undefined,
        limit: a.limit,
      }).catch(explain402('lex_export is admitted for 1 credit and then reserves 1 credit per matching row, up to limit, before any row is returned; once the rows have been counted the 1-credit admission is kept. A smaller limit needs fewer credits.'));
      const lines = Array.isArray(res.body.lines) ? res.body.lines : [];
      let meta: unknown;
      let done: unknown;
      let serverError: unknown;
      const rows: unknown[] = [];
      for (const l of lines) {
        if (isObj(l) && '_meta' in l) meta = l._meta;
        else if (isObj(l) && '_done' in l) done = l._done;
        // A line whose only key is `_error` is a failure signal, never a row.
        else if (isObj(l) && Object.keys(l).length === 1 && '_error' in l) serverError = l._error;
        else rows.push(l);
      }
      // An export is complete only with a `_done` trailer that does not
      // say `complete: false`, and no `_error` line. Anything else is a
      // partial export that must not be presented as the result.
      if (done === undefined || (isObj(done) && done.complete === false) || serverError !== undefined) {
        const why = serverError !== undefined
          ? `the server reported an error mid-stream (${isObj(serverError) ? `${String(serverError.code ?? 'UNKNOWN')}: ${String(serverError.message ?? '')}` : String(serverError)})`
          : done === undefined
            ? 'the stream ended without its completion trailer'
            : 'its completion trailer says complete: false';
        throw new Error(`lex_export is incomplete: ${why} after ${rows.length} row(s). The rows received are not the whole result; a retry with a smaller limit or narrower filters can complete it. Credits reserved for rows that were not written are refunded.`);
      }
      const per = Math.max(500, Math.floor((a.maxChars ?? 40_000) / Math.max(1, rows.length)));
      return compact({
        totalMatching: isObj(meta) ? meta.totalMatching : res.headers['x-export-total'],
        returned: rows.length,
        truncated: isObj(done) ? done.truncated : undefined,
        // limit | max_rows | credits (the pool could not pay for rows added since the
        // count) | recovered (the server's recovery sweep took the export's billing record mid-stream)
        truncatedBy: isObj(done) ? done.truncatedBy : undefined,
        skippedStubs: isObj(done) ? done.skippedStubs : undefined,
        // Only credit plans get a settled charge on the trailer.
        billing: isObj(done) && isObj(done.credits)
          ? '1 credit per row returned, at least 1; credits reserved for rows not returned are refunded.'
          : undefined,
        rows: rows.map((r) => {
          if (!isObj(r)) return r;
          const shaped = shapeMetadata(r);
          if (a.includeContent && r.parsedContent) {
            const { content, note } = shapeContent(r.parsedContent, { view: 'auto', maxChars: per });
            return compact({ ...shaped, content, note });
          }
          return compact({ ...shaped, contentHash: undefined, lastSeenAt: r.lastSeenAt });
        }),
      });
    },
  },

  // ── Webhooks (account state) ────────────────────────────────────────
  {
    name: 'lex_list_webhooks',
    scope: SCOPE_WEBHOOKS,
    title: 'List webhooks',
    description: 'The account\'s webhooks with status, criteria, watch list and delivery counters. Free.',
    inputSchema: {},
    annotations: READ,
    handler: async (_a, client) => {
      const res = await client.listWebhooks();
      const list = Array.isArray(res.body.webhooks) ? res.body.webhooks : [];
      return { count: list.length, webhooks: list.map((w) => (isObj(w) ? compact(w) : w)) };
    },
  },

  {
    name: 'lex_get_webhook',
    scope: SCOPE_WEBHOOKS,
    title: 'Webhook details and deliveries',
    description: 'One webhook with its recent delivery attempts (status, HTTP response, attempts). Pass deliveriesOffset/deliveriesLimit to page through older deliveries. Free.',
    inputSchema: {
      id: webhookId,
      deliveriesLimit: z.number().int().min(1).max(100).optional().describe('Deliveries per page.'),
      deliveriesOffset: wholeNumber(0).optional().describe('Skip this many deliveries (newest first).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.getWebhook(a.id);
      const w = isObj(res.body.webhook) ? { ...res.body.webhook } : {};
      let deliveries = Array.isArray(w.recentDeliveries) ? w.recentDeliveries : [];
      let total: unknown;
      if (a.deliveriesLimit !== undefined || a.deliveriesOffset !== undefined) {
        const d = await client.webhookDeliveries(a.id, { limit: a.deliveriesLimit, offset: a.deliveriesOffset });
        deliveries = Array.isArray(d.body.deliveries) ? d.body.deliveries : [];
        total = d.body.total;
      }
      delete w.recentDeliveries;
      return compact({
        webhook: compact(w),
        deliveriesTotal: total,
        deliveries: deliveries.map(shapeDelivery),
      });
    },
  },

  {
    name: 'lex_create_webhook',
    scope: SCOPE_WEBHOOKS,
    title: 'Create a webhook',
    description:
      'Subscribe a URL (must be a public https URL) to (a) new EUR-Lex documents matching searchCriteria and/or (b) changes to watched acts (watchCelex: amendments, corrigenda, repeals, new consolidated versions). Checked hourly; deliveries are free and HMAC-signed. The signing secret is returned only in this response. The number of webhooks is limited by the plan (maxWebhooks in lex_info). Free.',
    withoutReadDescription:
      'Subscribe a URL (must be a public https URL) to (a) new EUR-Lex documents matching searchCriteria and/or (b) changes to watched acts (watchCelex: amendments, corrigenda, repeals, new consolidated versions). Checked hourly; deliveries are free and HMAC-signed. The signing secret is returned only in this response. The number of webhooks is limited by the plan. Free.',
    inputSchema: {
      name: z.string().trim().min(1).max(200).describe('Label.'),
      url: webhookUrl('Must be a public https URL (port 443 or 8443, a public domain name or address); it receives the POSTs.'),
      searchCriteria: webhookCriteria(true).optional().describe('Filters for documents.new, in the lex_search vocabulary.'),
      watchCelex: z.array(celex('Base-act CELEX')).max(5000).optional().describe('Base acts to watch (not consolidated versions or corrigenda).'),
      secret: z.string().min(16).max(256).optional().describe('Own signing secret; generated when omitted.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    write: true,
    handler: async (a, client) => {
      if (!a.searchCriteria && !a.watchCelex?.length) throw new Error('Pass searchCriteria, watchCelex, or both.');
      const res = await client.createWebhook(compact({
        name: a.name,
        url: a.url,
        searchCriteria: a.searchCriteria,
        watchCelex: a.watchCelex?.map(normCelex),
        secret: a.secret,
      }));
      return {
        ...stripEnvelope(res.body),
        important: 'The webhook secret above is shown only in this response; it verifies X-Webhook-Signature.',
      };
    },
  },

  {
    name: 'lex_update_webhook',
    scope: SCOPE_WEBHOOKS,
    title: 'Update a webhook',
    description:
      'Change a webhook\'s name, URL, searchCriteria, watch list or status; fields left out are unchanged. status ACTIVE re-enables a PAUSED or FAILED webhook and re-queues its recent failed deliveries; PAUSED stops deliveries. Free.',
    inputSchema: {
      id: webhookId,
      name: z.string().trim().min(1).max(200).optional().describe('New label.'),
      url: webhookUrl('Must be a public https URL.').optional().describe('Must be a public https URL.'),
      searchCriteria: webhookCriteria(false).nullable().optional().describe('Replaces the stored criteria as a whole; null removes them. Same fields as searchCriteria on lex_create_webhook, described there.'),
      watchCelex: z.array(celex('Base-act CELEX')).max(5000).optional().describe('Replaces the whole watch list; [] empties it.'),
      status: z.enum(['ACTIVE', 'PAUSED']).optional().describe('ACTIVE re-enables, PAUSED stops deliveries.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    write: true,
    handler: async (a, client) => {
      const { id, ...rest } = a;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
      if (Array.isArray(body.watchCelex)) body.watchCelex = (body.watchCelex as string[]).map(normCelex);
      if (!Object.keys(body).length) throw new Error('Nothing to update: pass at least one field.');
      const res = await client.updateWebhook(id, body);
      return stripEnvelope(res.body);
    },
  },

  {
    name: 'lex_delete_webhook',
    scope: SCOPE_WEBHOOKS,
    title: 'Delete a webhook',
    description: 'Permanently delete a webhook and its delivery history. Cannot be undone. Free.',
    inputSchema: { id: webhookId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    write: true,
    handler: async (a, client) => {
      await client.deleteWebhook(a.id);
      return { deleted: a.id };
    },
  },

  {
    name: 'lex_test_webhook',
    scope: SCOPE_WEBHOOKS,
    title: 'Send a test delivery',
    description: 'POST a signed webhook.test payload to the webhook URL now and report the endpoint\'s response, showing whether the endpoint is reachable and whether it accepts the signed payload. Free.',
    inputSchema: { id: webhookId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    write: true,
    handler: async (a, client) => {
      const res = await client.testWebhook(a.id);
      return stripEnvelope(res.body);
    },
  },
];

function shapeDelivery(d: unknown) {
  if (!isObj(d)) return d;
  const p = isObj(d.payload) ? d.payload : {};
  const data = isObj(p.data) ? p.data : {};
  return compact({
    id: d.id,
    status: d.status,
    event: p.event,
    documents: typeof data.count === 'number' ? data.count : undefined,
    responseStatus: d.responseStatus,
    errorMessage: d.errorMessage,
    attemptCount: d.attemptCount,
    nextRetryAt: d.nextRetryAt,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
  });
}

/** Bound `text` across semantic hits to a total budget (only present with include: ['text']). */
/** `reader`: the tool that reads a hit's whole document. */
function budgetHitTexts<T extends Record<string, unknown>>(shaped: T, budget: number, reader = 'lex_get_document'): T {
  const results = Array.isArray(shaped.results) ? shaped.results as Record<string, unknown>[] : [];
  const withText = results.filter((r) => typeof r.text === 'string');
  if (!withText.length) return shaped;
  const per = Math.max(1000, Math.floor(budget / withText.length));
  let cut = 0;
  for (const r of withText) {
    const t = r.text as string;
    if (t.length > per) {
      r.text = `${t.slice(0, per)} …[truncated: ${t.length - per} more characters]`;
      cut++;
    }
  }
  return cut
    ? { ...shaped, note: `${cut} hit text(s) truncated to ${per} characters (maxChars=${budget}). Read a full document with ${reader}.` }
    : shaped;
}

export interface SelectToolsOptions {
  readOnly?: boolean;
  /**
   * The tool scopes of an OAuth connection: only tools whose scope is in the
   * set are returned. Leave undefined for an API key (scopes do not apply).
   */
  scopes?: ReadonlySet<ToolScope>;
}

/** The schema a tool's arguments are validated with. */
export function inputSchemaOf(tool: ToolDef) {
  return tool.strict ? z.strictObject(tool.inputSchema) : z.object(tool.inputSchema);
}

export function selectTools(opts: SelectToolsOptions = {}): ToolDef[] {
  const { scopes } = opts;
  const permitted = scopes
    ? tools.filter((t) => scopes.has(t.scope))
      .map((t) => (t.withoutReadDescription && !scopes.has(SCOPE_READ) ? { ...t, description: t.withoutReadDescription } : t))
    : tools;
  if (!opts.readOnly) return permitted;
  return permitted.filter((t) => !t.write)
    .map((t) => (t.readOnlyDescription ? { ...t, description: t.readOnlyDescription } : t));
}
