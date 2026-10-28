import { z } from 'zod';

import { webhookUrlProblem } from './webhookUrl.js';

import type { Json, LexAPIClient, LexResponse } from './client.js';
import {
  compact,
  creditNotice,
  isObj,
  nationalAllowanceOf,
  shapeCaseLaw,
  shapeCitedBy,
  shapeCites,
  shapeContent,
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
  stripEnvelope,
  type View,
} from './shape.js';

// ── Shared vocabularies (mirroring openapi.yaml / GET /info) ─────────
export const LANGUAGES = [
  'en', 'fr', 'de', 'es', 'it', 'pl', 'nl', 'pt', 'ro', 'bg', 'cs', 'da',
  'el', 'et', 'fi', 'ga', 'hr', 'hu', 'lt', 'lv', 'mt', 'sk', 'sl', 'sv',
] as const;

/** Languages the semantic index holds (server/controllers/semanticController.js). */
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
  'reference', 'amendment', 'repeal', 'corrigendum', 'implementation', 'legal-basis', 'proposal',
] as const;

const CONTENT_PARTS = ['metadata', 'fullText', 'articles', 'recitals', 'paragraphs', 'sections', 'tables', 'annexes'] as const;

// Mirrors the API's isValidCelexToken (corrigenda `32013R0952R(04)` and
// consolidated `02016R0679-20180524` included), case-insensitive; an
// optional `CELEX:` prefix is stripped before sending.
const CELEX_RE = /^(?:CELEX:)?[0-9A-Za-z][0-9A-Za-z()._-]{4,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const celex = (what = 'CELEX number') =>
  z.string().trim().regex(CELEX_RE, `${what} must look like 32016R0679, 62018CJ0311, 02016R0679-20180524 or 32013R0952R(04)`)
    .describe(`${what}, e.g. 32016R0679.`);

// National-corpus ids (e.g. `AT-NOR-10001597`, `SI-JUD-UPRS-2025-I.U.727.2022.`):
// a two-letter jurisdiction prefix, same as middleware/jurisdiction.js's
// nationalIdParamGuard (`/^([A-Z]{2})-/`) uses to recognise them on the
// citation graph. `includeNational`-aware citation tools accept either
// shape; document reads stay celex()-only (lex_get_national_document /
// lex_list_national_documents cover national documents directly).
const NATIONAL_ID_RE = /^[A-Za-z]{2}-[0-9A-Za-z()./_-]+$/;
const celexOrNationalId = (what = 'identifier') =>
  z.string().trim()
    .refine((v) => CELEX_RE.test(v) || NATIONAL_ID_RE.test(v),
      `${what} must be a CELEX number (e.g. 32016R0679) or a national document id (e.g. AT-NOR-12345)`)
    .describe(`${what}: a CELEX number, or (with includeNational) a national document id, e.g. "AT-NOR-12345".`);
// National law (lex-api PR #306, launching 2026-11-03): jurisdiction codes
// are not enumerated here — the server is the single source of truth for
// which are registered and which are LIVE (lex_national_coverage), and the
// set grows over time. A two-letter code that isn't live 404s like any
// unmatched path, same as EU_LAW.
const jurisdiction = () => z.string().trim().regex(/^[A-Za-z]{2}$/, 'a two-letter country code, e.g. "at"')
  .transform((v) => v.toLowerCase())
  .describe('ISO 3166-1 alpha-2 country code, e.g. "at". Check lex_national_coverage first — not yet live 404s.');

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
// The export API's own checks (lex-api exportController parseIsoDate /
// parseIsoTimestamp), mirrored exactly so the schema accepts what the server
// accepts and nothing else: a calendar-valid YYYY-MM-DD; a date-time needs a
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
const isoDate = (d: string) =>
  z.string().regex(DATE_RE, 'use YYYY-MM-DD').refine(isApiDate, 'not a calendar date').describe(d);
/** An ISO 8601 date, or a date-time WITH a timezone (the API rejects one without). */
const since = (d: string) =>
  z.string().regex(ISO_TS_RE, 'use YYYY-MM-DD or an ISO 8601 date-time with a timezone (Z or ±HH:MM)')
    .refine(isApiTimestamp, 'not a valid date/time')
    .describe(`${d} ISO 8601: a date (YYYY-MM-DD, midnight UTC) or a date-time with a timezone.`);
// One value or a list; the allowed values are listed once, in the description
// (an enum inside a string|array union would print them twice).
const oneOrMany = <T extends readonly [string, ...string[]]>(values: T, d: string) => {
  const set = new Set<string>(values);
  return z.union([z.string(), z.array(z.string()).min(1)])
    .refine((v) => (Array.isArray(v) ? v : [v]).every((x) => set.has(x)), `allowed: ${values.join(', ')}`)
    .describe(`${d} One or a list of: ${values.join(', ')}.`);
};

const view = z.enum(['auto', 'outline', 'full']).default('auto').describe(
  'auto: the body if it fits maxChars, else an outline. full: body up to maxChars, then offset to continue.',
);
const maxChars = (def: number) => z.number().int().min(2000).max(200_000).default(def)
  .describe(`Text budget in characters (default ${def}).`);
const offset = z.number().int().min(0).optional()
  .describe('Continue after a truncated response (value given in its note).');
const include = z.array(z.enum(CONTENT_PARTS)).min(1).optional().describe(
  'Only these parts. "paragraphs" = judgment grounds / text of documents without articles.',
);

export function normCelex(v: string): string {
  return v.trim().replace(/^CELEX:/i, '').toUpperCase();
}

// ── Tool plumbing ─────────────────────────────────────────────────────
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Not read-only (webhooks, citation extraction). Hidden when LEXAPI_MCP_READ_ONLY is set. */
  write?: boolean;
  handler: (args: any, client: LexAPIClient) => Promise<unknown>;
}

const READ: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

/** Attach the low-credit notice (if any) to a shaped result. */
function withNotice(res: LexResponse<Json>, shaped: Record<string, unknown>): Record<string, unknown> {
  const notice = creditNotice(res.body);
  return notice ? { ...shaped, notice } : shaped;
}

/** Attach the national-law allowance (FREE/STARTER/PROFESSIONAL only — lex-api PR #306), when the response carried it. */
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
    note: `No article matched articleId "${a.articleId}". Call again without articleId to see the outline (article ids, or paragraphs for documents without articles).`,
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
    title: 'LexAPI account & capabilities',
    description:
      "The caller's LexAPI plan, credit balance (remaining, reset date) and limits, plus the accepted values for search filters. Free (0 credits). Use it when the user asks about their plan or credits, or to check the connection.",
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

  // ── Search ──────────────────────────────────────────────────────────
  {
    name: 'lex_search',
    title: 'Search EUR-Lex',
    description:
      'Structured EUR-Lex search: keywords plus filters (dates, type, author, procedure, collection) → CELEX numbers, titles, dates; read a hit with lex_get_document. Matching is literal: use 1–3 distinctive terms; for concept questions use lex_semantic_legislation / lex_semantic_case_law. Cost: 3 credits per result page (~10 results; unfetched pages refunded).',
    inputSchema: {
      query: z.string().max(1000).optional().describe('Search text. Quotes force an exact phrase. "*" = no text constraint (filter-only search).'),
      textScope: z.enum(['title', 'text', 'title-text', 'any']).optional().describe('Where the text must match (API default title-text).'),
      dateFrom: isoDate('Document date from (inclusive).').optional(),
      dateTo: isoDate('Document date to (inclusive).').optional(),
      year: z.union([z.number().int().min(1950).max(2100), z.array(z.number().int().min(1950).max(2100)).min(1)]).optional().describe('Document year(s).'),
      month: z.union([z.number().int().min(1).max(12), z.array(z.number().int().min(1).max(12)).min(1)]).optional().describe('Month(s) 1–12, combined with year.'),
      documentType: oneOrMany(DOCUMENT_TYPES, 'Document type(s). Several types fan out into one EUR-Lex query each.').optional(),
      author: oneOrMany(AUTHORS, 'Issuing institution(s).').optional(),
      procedure: oneOrMany(PROCEDURES, 'Legislative procedure(s).').optional(),
      domain: z.enum(['EU_LAW', 'NATIONAL_LAW', 'ALL']).optional().describe('EUR-Lex collection.'),
      subdomain: oneOrMany(SUBDOMAINS, 'Sub-collection(s), e.g. "case-law", "legislation", "consolidated".').optional(),
      language: lang('Result language (default en).').optional(),
      maxPages: z.number().int().min(1).max(100).default(1).describe('Result pages to fetch (3 credits each; clamped to the plan: FREE 1, STARTER 5, PROFESSIONAL 20, higher 100). Raise it when a tight date filter reports postFilteredBy "date".'),
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
    title: 'Recently published EU documents',
    description:
      'Documents published on EUR-Lex in the last N days (default 7), newest first, optionally filtered. Use for "what was published this week". Cost: 3 credits per 10 results of limit (clamped to the plan); an unfiltered request is answered from the Publications Office in one query for 3 credits.',
    inputSchema: {
      days: z.number().int().min(1).max(366).default(7).describe('Look-back window in days.'),
      documentType: z.enum(DOCUMENT_TYPES).optional(),
      author: z.enum(AUTHORS).optional(),
      domain: z.enum(['EU_LAW', 'NATIONAL_LAW', 'ALL']).optional(),
      subdomain: z.enum(SUBDOMAINS).optional(),
      language: lang('Keep documents available in this language (default en).').optional(),
      limit: z.number().int().min(1).max(500).default(20).describe('Max results (each 10 cost 3 credits when filtered).'),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.recentDocuments(a);
      return withNotice(res, shapeRecent(res));
    },
  },

  {
    name: 'lex_resolve',
    title: 'Resolve a legal identifier to CELEX',
    description:
      'Turn a pasted EUR-Lex URL, an ELI URI, an ECLI (e.g. ECLI:EU:C:2020:559) or a bare CELEX into the canonical CELEX number plus EUR-Lex links. Cost: 1 credit. ECLIs resolve only for case law already in the LexAPI corpus (404 otherwise).',
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
    title: 'Fetch an EU document by CELEX',
    description:
      'A parsed EU document by CELEX: metadata plus body (articles, recitals, judgment paragraphs, annexes). Large documents return an outline first; then read an article with articleId or parts with include. content: null means no published text — textAvailability says why and may point to the latest consolidated version. Consolidated CELEXes (0…-YYYYMMDD) are labelled: not the authentic text, cite the base act. Cost: 1 credit from the corpus, 4 via the Publications Office, 5 live (every call is charged).',
    inputSchema: {
      celexNumber: celex(),
      language: lang('Language of the whole document (default en). Falls back to English, labelled languageFallback, when EUR-Lex lacks it.').optional(),
      acceptLanguages: z.union([z.array(lang()).min(1), z.literal('any')]).optional().describe('Fallback languages to serve when the requested one has no text (e.g. ["fr"] for General Court decisions), or "any".'),
      articleId: z.string().trim().min(1).max(40).optional().describe('Return only this article: "17", "art_17", "Article 17", "6a".'),
      include,
      view,
      maxChars: maxChars(40_000),
      offset,
      bypassCorpus: z.boolean().optional().describe('Force a fresh upstream read (charged at the live rate). Only when the stored copy is suspected stale.'),
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
    title: 'Fetch several EU documents',
    description:
      'Fetch up to 50 documents by CELEX in one call (batch size is clamped to the plan: FREE 1, STARTER 5, PROFESSIONAL 20, higher 50). Per-document failures are listed in errors; documents without published text stay in documents with textAvailability. Same per-document cost as lex_get_document (1 / 4 / 5 credits); trimmed items are not charged.',
    inputSchema: {
      celexNumbers: z.array(celex()).min(1).max(50).describe('CELEX numbers.'),
      language: lang().optional(),
      acceptLanguages: z.union([z.array(lang()).min(1), z.literal('any')]).optional(),
      articleId: z.string().trim().min(1).max(40).optional().describe('Return only this article of each document.'),
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
    title: 'EU document metadata',
    description:
      'Metadata only for a CELEX — title, type, author, dates, ECLI/ELI, EuroVoc keywords, EUR-Lex link — without the body. Use to identify a document cheaply before deciding to read it. Cost: 1 credit from the corpus, 4 via the Publications Office, 5 live.',
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
    title: 'Fetch an EU document by EUR-Lex URL',
    description:
      'Same as lex_get_document, for a eur-lex.europa.eu URL the user pasted (the CELEX is extracted from CELEX:… or uri=…). Always English. For ELI/ECLI links use lex_resolve first. Cost: 1 / 4 / 5 credits by source.',
    inputSchema: {
      url: z.string().trim().url().describe('A eur-lex.europa.eu URL containing CELEX:<id> or uri=CELEX:<id>.'),
      articleId: z.string().trim().min(1).max(40).optional(),
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

  // ── Version history (observation snapshots) ─────────────────────────
  {
    name: 'lex_document_versions',
    title: 'Version history of a document',
    description:
      "Every text change LexAPI observed on a document, newest first. These are snapshots of the document as LexAPI fetched it — NOT the law in force on a date (for that use lex_semantic_legislation with asOf, or a consolidated CELEX). History starts when the document entered the corpus. Cost: 1 credit.",
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
            fetchedAt: v.fetchedAt,
            contentHash: typeof v.contentHash === 'string' ? v.contentHash.slice(0, 12) : undefined,
            title: v.title,
          }) : v))
          : [],
        semantics: 'Observation snapshots (as fetched by LexAPI), not legal in-force reconstructions.',
      }));
    },
  },

  {
    name: 'lex_get_document_version',
    title: 'A document snapshot by version or date',
    description:
      'The text of one observed snapshot — by version number, or the snapshot LexAPI held on a date (YYYY-MM-DD). This is what LexAPI had fetched then, NOT the law in force on that date; dates before the document entered the corpus return 404. Cost: 1 credit.',
    inputSchema: {
      celexNumber: celex(),
      version: z.number().int().min(1).optional().describe('Snapshot number (from lex_document_versions).'),
      date: isoDate('Return the snapshot current on this date (end of day UTC).').optional(),
      language: lang().optional(),
      include: z.array(z.enum(CONTENT_PARTS)).min(1).optional(),
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
        asOf: b.asOf,
        version: d.version,
        isCurrent: d.isCurrent,
        fetchedAt: d.fetchedAt,
        title: d.title,
        documentType: d.documentType,
        content,
        note,
        semantics: 'Observation snapshot (as fetched by LexAPI), not a legal in-force reconstruction.',
      }));
    },
  },

  // ── Semantic search ─────────────────────────────────────────────────
  {
    name: 'lex_semantic_legislation',
    title: 'Semantic search over EU legislation',
    description:
      'Find EU legislation articles by meaning. Hits: law_id (CELEX), article_ref (use as articleId in lex_get_document), law_title, score, snippet. Consolidated hits (consolidated: true) are not authentic: quote them, cite baseCelex. asOf gives the text in force on a past date. Cost: 5 credits; with asOf, plus up to 5 per in-force version fetched live (default max 3 per call; failed fetches free).',
    inputSchema: {
      query: z.string().trim().min(1).max(1000).describe('Natural-language description of the provision you are looking for.'),
      asOf: isoDate('The law as in force on this date (YYYY-MM-DD, 1952-01-01 to today) — use for questions about a past date. Hits then carry the version in force (asOfResolved: true, asOfVersion). Unresolved hits keep the CURRENT text with an asOfReason; follow asOfCaveat. Omit for current law.').optional(),
      limit: z.number().int().min(1).max(50).default(10).describe('Max hits (plan cap: FREE 10, STARTER 20, higher 50). Merged consolidated/base duplicates can make a page shorter.'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor. Default ≈0.7 server-side; lower (0.5) when you got fewer hits than limit, 0 disables it.'),
      language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Preferred language of the text (default en); acts without it come back in another language, labelled.'),
      include: z.array(z.literal('text')).optional().describe('["text"] returns the full matched article text instead of a ~600-character snippet.'),
      filters: z.record(z.string(), z.unknown()).optional().describe('Pass-through to the semantic index. Today only "language" is honoured for legislation; other keys are ignored.'),
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
    title: 'Semantic search over EU case law',
    description:
      'Find CJEU / General Court judgments, orders and AG opinions by meaning. Returns cases with celex (feed to lex_get_document), case number, ECLI, court, date, score and a summary. For short keyword-style queries set hyde: true (better recall, 15 credits instead of 5, +1–3 s; refunded to 5 if it falls back). Cost: 5 credits.',
    inputSchema: {
      query: z.string().trim().min(3).max(1000).describe('Natural-language question or description of the legal issue.'),
      limit: z.number().int().min(1).max(100).default(10).describe('Max cases (plan cap: FREE 10, STARTER 20, PROFESSIONAL 50, higher 100). One result per case.'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor. Default ≈0.7 server-side; lower (0.5) when you got fewer hits than limit, 0 disables it.'),
      language: z.enum(SEMANTIC_LANGUAGES).optional().describe('Preferred language (default en).'),
      hyde: z.boolean().optional().describe('LLM query rewriting for terse queries (15 credits).'),
      include: z.array(z.literal('text')).optional().describe('["text"] returns each judgment\'s full text (large; bounded by maxChars).'),
      filters: z.object({
        court: z.string().optional().describe('Court name as indexed, e.g. "Court of Justice", "General Court".'),
        date_from: isoDate('Decided on or after (YYYY-MM-DD).').optional(),
        date_to: isoDate('Decided on or before (YYYY-MM-DD).').optional(),
        case_number: z.string().optional().describe('Exact case number, e.g. "C-311/18" (direct lookup).'),
        ecli: z.string().optional().describe('Exact ECLI (direct lookup).'),
      }).catchall(z.unknown()).optional().describe('Optional filters passed to the semantic index.'),
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

  // ── National law (lex-api PR #306; launching 2026-11-03) ────────────
  // Member-state legislation and case law, alongside the EU_LAW corpus
  // above. A country can be registered on LexAPI before it is available to
  // customers, so every tool below except lex_national_coverage says to
  // call it first; an unavailable country answers like an unmatched path
  // (404), never a silent empty result. Attribution (source, licence) is
  // kept on every result — it is required, not optional, context.
  {
    name: 'lex_national_coverage',
    title: 'National-law coverage',
    description:
      "Countries with national-law coverage: live status, legislation/case-law coverage (counts, dates, courts), semantic-search availability, and sources with licence/attribution. Call this before any other national tool. Free.",
    inputSchema: {},
    annotations: READ,
    handler: async (_a, client) => {
      const res = await client.nationalCoverage();
      return compact(res.body);
    },
  },

  {
    name: 'lex_list_national_documents',
    title: 'Browse national documents',
    description:
      'Browse a country\'s national documents by title/type. Not yet live 404s — check lex_national_coverage first. Cost: 3 credits flat, not per page. Counts against the national-law allowance on lower plans (see allowance in the response).',
    inputSchema: {
      jurisdiction: jurisdiction(),
      q: z.string().trim().min(1).max(200).optional().describe('Title search.'),
      documentType: z.string().trim().min(1).max(100).optional().describe('Document type as stored for this country.'),
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(20),
      includeRepealed: z.boolean().optional().describe('Also list repealed/superseded acts.'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.listNationalDocuments(a.jurisdiction, compact({
        q: a.q,
        type: a.documentType,
        page: a.page,
        limit: a.limit,
        includeRepealed: a.includeRepealed,
      }));
      const b = res.body;
      const results = Array.isArray(b.results) ? b.results.map(shapeNationalSearchResult) : [];
      return withAllowance(res, withNotice(res, compact({
        jurisdiction: b.jurisdiction,
        total: b.total,
        page: b.page,
        limit: b.limit,
        includeRepealed: b.includeRepealed,
        results,
      })));
    },
  },

  {
    name: 'lex_get_national_document',
    title: 'Fetch a national document',
    description:
      'A national document by id, e.g. "AT-NOR-12345". content: null means no text; see textAvailability. Corpus-only, never a live fetch. Not yet live 404s — check lex_national_coverage first. Cost: 5 reserved, settles at 1 (an unknown id too) — a pool with fewer than 5 available 402s even though it only spends 1. Counts against the national-law allowance on lower plans (see allowance). attribution names the source/licence — show it to the user.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      id: z.string().trim().min(1).max(200).describe('National document id, e.g. "AT-NOR-12345".'),
      language: lang().optional(),
      view,
      maxChars: maxChars(40_000),
      offset,
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.getNationalDocument(a.jurisdiction, a.id, compact({ language: a.language }));
      const shaped = shapeNationalDocument(res.body.document, contentOpts(a));
      return withAllowance(res, withNotice(res, shaped));
    },
  },

  {
    name: 'lex_national_semantic_case_law',
    title: 'Semantic search over national case law',
    description:
      'Find one country\'s case law by meaning. hyde is accepted for schema compatibility but is a no-op nationally (no rewrite, no extra cost). Not yet live errors — check lex_national_coverage first. Cost: flat 5 credits, never 15; counts against the national-law allowance on lower plans (see allowance). Each hit\'s attribution names the source/licence — show it to the user.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      query: z.string().trim().min(3).max(1000).describe('Natural-language question or description of the legal issue.'),
      limit: z.number().int().min(1).max(100).default(10).describe('Max cases (plan cap, same as lex_semantic_case_law).'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor (default ≈0.7).'),
      language: lang('Optional — omit, or the country\'s own language (e.g. "de" for AT, from lex_national_coverage); any other value is a 400.').optional(),
      hyde: z.boolean().optional().describe('No-op here; never adds cost or latency.'),
      include: z.array(z.literal('text')).optional().describe('["text"] returns full judgment text, bounded by maxChars.'),
      filters: z.object({
        court: z.string().optional(),
        date_from: isoDate('From.').optional(),
        date_to: isoDate('To.').optional(),
        ecli: z.string().optional(),
      }).strict().optional().describe('No case_number nationally.'),
      maxChars: maxChars(40_000),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.nationalSemanticCaseLaw(a.jurisdiction, compact({
        query: a.query,
        limit: a.limit,
        min_score: a.min_score,
        language: a.language,
        hyde: a.hyde,
        include: a.include,
        filters: a.filters,
      }));
      return withAllowance(res, withNotice(res, budgetHitTexts(shapeNationalCaseLaw(res), a.maxChars ?? 40_000)));
    },
  },

  {
    name: 'lex_national_semantic_legislation',
    title: 'Semantic search over national legislation',
    description:
      'Find one country\'s legislation articles by meaning. No asOf — current text only. Not yet live errors — check lex_national_coverage first. Cost: flat 5 credits; counts against the national-law allowance on lower plans (see allowance). Each hit\'s attribution names the source/licence — show it to the user.',
    inputSchema: {
      jurisdiction: jurisdiction(),
      query: z.string().trim().min(3).max(1000).describe('Natural-language description of the provision you are looking for.'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max hits (plan cap, same as lex_semantic_legislation).'),
      min_score: z.number().min(0).max(1).optional().describe('Similarity floor (default ≈0.7).'),
      language: lang('Optional — omit, or the country\'s own language (e.g. "de" for AT, from lex_national_coverage); any other value is a 400.').optional(),
      include: z.array(z.literal('text')).optional().describe('["text"] returns full article text instead of a snippet.'),
      filters: z.object({
        id: z.string().trim().min(1).optional().describe('A specific national document id.'),
        inForce: z.boolean().optional().describe('As of today.'),
        documentType: z.string().trim().min(1).optional(),
      }).strict().optional(),
      maxChars: maxChars(40_000),
    },
    annotations: { ...READ, idempotentHint: false },
    handler: async (a, client) => {
      const res = await client.nationalSemanticLegislation(a.jurisdiction, compact({
        query: a.query,
        limit: a.limit,
        min_score: a.min_score,
        language: a.language,
        include: a.include,
        filters: a.filters,
      }));
      return withAllowance(res, withNotice(res, budgetHitTexts(shapeNationalLegislation(res), a.maxChars ?? 40_000)));
    },
  },

  // ── Citation graph ──────────────────────────────────────────────────
  {
    name: 'lex_cited_by',
    title: 'Documents citing a CELEX',
    description:
      'Inbound citations: documents that cite, amend, correct, repeal, implement or are based on this act, with the edge type. For legislation, amendment / corrigendum / repeal edges are read from the Publications Office (Cellar) and refreshed on read when older than 7 days; if that refresh does not finish in ~2.5 s, relationSync.status is "pending" (or "skipped") and the stored edges are served — check relationSync before calling the list complete. Other edge types cover only documents LexAPI has extracted. includeNational adds national neighbours (BUSINESS+ only; also accepts a national id, e.g. "AT-NOR-12345"). Cost: 1 credit.',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      citationType: z.enum(CITATION_TYPES).optional().describe('Only this edge type (e.g. "amendment" for the amending acts).'),
      limit: z.number().int().min(1).max(500).default(50).describe('Edges per page.'),
      offset: z.number().int().min(0).default(0).describe('Paging offset, in edges.'),
      includeNational: z.boolean().optional().describe('Also include national neighbours of live countries (BUSINESS+ only).'),
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
    title: 'Documents a CELEX cites',
    description:
      'Outbound citations: what this document references, amends, repeals, implements or is based on, with the edge type. Only populated for documents whose citations were extracted (lex_extract_citations). includeNational adds national neighbours (BUSINESS+ only; also accepts a national id, e.g. "AT-NOR-12345"). Cost: 1 credit.',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      citationType: z.enum(CITATION_TYPES).optional(),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      includeNational: z.boolean().optional().describe('Also include national neighbours of live countries (BUSINESS+ only).'),
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
    title: 'Citation neighbourhood of a CELEX',
    description:
      'Both directions at once — documents this one cites and documents citing it — deduplicated, with edge types per neighbour; paging.citesTotal / citedByTotal give the full counts. includeNational adds national neighbours (BUSINESS+ only; also accepts a national id). Cost: 20 credits (prefer lex_cited_by / lex_cites at 1 credit when one direction is enough).',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      citationType: z.enum(CITATION_TYPES).optional(),
      limit: z.number().int().min(1).max(500).default(50).describe('Edges per direction.'),
      offset: z.number().int().min(0).default(0),
      includeNational: z.boolean().optional().describe('Also include national neighbours of live countries (BUSINESS+ only).'),
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
    title: 'Citation path between two documents',
    description:
      'Shortest chain of outbound citations from one document to another (e.g. how a judgment reaches a directive). found: false is a normal answer, not an error. includeNational follows national documents too (BUSINESS+ only; from/to also accept a national id). Cost: 20 credits.',
    inputSchema: {
      from: celexOrNationalId('Start identifier'),
      to: celexOrNationalId('Target identifier'),
      maxDepth: z.number().int().min(1).max(8).default(3).describe('Max hops.'),
      includeNational: z.boolean().optional().describe('Also follow national documents of live countries (BUSINESS+ only).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.citationPath(normCelex(a.from), normCelex(a.to), { maxDepth: a.maxDepth, includeNational: a.includeNational });
      const b = stripEnvelope(res.body);
      if (Array.isArray(b.path)) {
        b.path = b.path.map((n) => (isObj(n) ? compact({ celex: n.celexNumber, title: n.title }) : n));
      }
      return withNotice(res, compact(b));
    },
  },

  {
    name: 'lex_related',
    title: 'Documents related by shared citations',
    description:
      'Documents that cite the most of the same acts as this one (bibliographic coupling) — "what else deals with this". Needs the seed\'s outbound citations (lex_extract_citations). includeNational considers national documents too (BUSINESS+ only; also accepts a national id). Cost: 20 credits.',
    inputSchema: {
      celexNumber: celexOrNationalId(),
      limit: z.number().int().min(1).max(50).default(10),
      includeNational: z.boolean().optional().describe('Also consider national documents of live countries (BUSINESS+ only).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.related(normCelex(a.celexNumber), { limit: a.limit, includeNational: a.includeNational });
      const b = stripEnvelope(res.body, ['method']);
      if (Array.isArray(b.related)) {
        b.related = b.related.map((r) => (isObj(r) ? compact({
          celex: r.celexNumber,
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
    title: 'Citation graph statistics',
    description: 'Totals for the whole LexAPI citation graph plus the 10 most-cited and 10 most-citing documents. includeNational counts national documents too (BUSINESS+ only). Cost: 20 credits.',
    inputSchema: {
      includeNational: z.boolean().optional().describe('Also count national documents of live countries (BUSINESS+ only).'),
    },
    annotations: READ,
    handler: async (a, client) => {
      const res = await client.citationStats({ includeNational: a.includeNational });
      return withNotice(res, stripEnvelope(res.body));
    },
  },

  {
    name: 'lex_extract_citations',
    title: 'Extract a document\'s citations',
    description:
      'Read a document\'s EUR-Lex notice and add its outbound citations to the graph, so lex_cites / lex_related work for it. Idempotent: returns alreadyExtracted when done before. Cost: 5 credits (1 when already extracted).',
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
    title: 'Export corpus rows',
    description:
      'Rows from the LexAPI corpus matching filters — e.g. regulations dated 2024 or documents whose text changed since a date. BUSINESS plans and above (403 otherwise). Cost: 1 credit per row returned, at least 1 per call. The call is admitted for 1 credit, the matching rows are counted, and the rest of 1 credit per row it can return (up to limit) is reserved; if the pool cannot cover that, LexAPI answers 402 before returning anything (retry with a smaller limit). Reserved credits for rows not returned are refunded. Keep limit small. An export that fails part-way is reported as incomplete, never as a result. Bulk export for ML training needs a separate licence (Terms §6).',
    inputSchema: {
      documentType: z.array(z.string().min(1)).min(1).optional().describe('Stored document-type labels, matched exactly but ignoring case, e.g. ["Regulation","Directive"]: "regulation" matches Regulation, not Implementing regulation (use documentTypeCode for the family).'),
      documentTypeCode: z.array(z.string().min(1)).min(1).optional().describe('Type families by documentTypeCode, e.g. ["regulation"] — includes implementing and delegated regulations. Combined with documentType, both must match.'),
      author: z.array(z.string().min(1)).min(1).optional().describe('Stored author values, matched whole and ignoring case (a joint act\'s "European Parliament, Council of the European Union" is one value).'),
      subdomain: z.array(z.enum(['treaties', 'international', 'legislation', 'internal', 'preparatory', 'case-law', 'national-transposition', 'national-case-law', 'questions', 'consolidated'])).min(1).optional(),
      language: lang().optional(),
      dateFrom: isoDate('Document date from (inclusive, YYYY-MM-DD).').optional(),
      dateTo: isoDate('Document date to (inclusive, YYYY-MM-DD).').optional(),
      changedSince: since('Only rows whose text changed at or after this time — the cheapest incremental sync.').optional(),
      fetchedSince: since('Only rows written to at or after this time (any update, including metadata-only). Prefer changedSince for syncing text.').optional(),
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
      });
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
      // SDK contract §1.8: complete only with a `_done` trailer that does not
      // say `complete: false`, and no `_error` line. Anything else is a
      // partial export that must not be presented as the result.
      if (done === undefined || (isObj(done) && done.complete === false) || serverError !== undefined) {
        const why = serverError !== undefined
          ? `the server reported an error mid-stream (${isObj(serverError) ? `${String(serverError.code ?? 'UNKNOWN')}: ${String(serverError.message ?? '')}` : String(serverError)})`
          : done === undefined
            ? 'the stream ended without its completion trailer'
            : 'its completion trailer says complete: false';
        throw new Error(`lex_export is incomplete: ${why} after ${rows.length} row(s). The rows received are not the whole result — do not treat them as complete; retry the export (a smaller limit or narrower filters helps).`);
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
    title: 'Webhook details and deliveries',
    description: 'One webhook with its recent delivery attempts (status, HTTP response, attempts). Pass deliveriesOffset/deliveriesLimit to page through older deliveries. Free.',
    inputSchema: {
      id: z.string().trim().min(1).max(64).describe('Webhook id.'),
      deliveriesLimit: z.number().int().min(1).max(100).optional(),
      deliveriesOffset: z.number().int().min(0).optional(),
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
    title: 'Create a webhook',
    description:
      'Subscribe a URL (must be a public https URL) to (a) new EUR-Lex documents matching searchCriteria and/or (b) changes to watched acts (watchCelex: amendments, corrigenda, repeals, new consolidated versions). Checked hourly; deliveries are free and HMAC-signed. The signing secret is returned ONLY in this response — tell the user to store it. Plan limits apply (FREE has no webhooks). Confirm the URL and criteria with the user first. Free.',
    inputSchema: {
      name: z.string().trim().min(1).max(200).describe('Label.'),
      url: webhookUrl('Must be a public https URL (port 443 or 8443, a public domain name or address); it receives the POSTs.'),
      searchCriteria: z.object({
        query: z.string().optional().describe('Words that must all appear in the title (whole words; 4+ characters match word starts; trailing * for prefixes).'),
        documentType: z.union([z.string(), z.array(z.string())]).optional(),
        author: z.union([z.string(), z.array(z.string())]).optional(),
        subdomain: z.union([z.string(), z.array(z.string())]).optional().describe('Replaces the default (EU law, no consolidated texts); "consolidated" = consolidated texts only.'),
        dateFrom: isoDate('Lower bound on the document date.').optional(),
        dateTo: isoDate('Upper bound on the document date.').optional(),
        year: z.union([z.number().int().min(1950).max(2100), z.array(z.number().int().min(1950).max(2100))]).optional(),
        textScope: z.enum(['title', 'title-text', 'any']).optional(),
        domain: z.enum(['EU_LAW', 'ALL']).optional(),
        language: z.string().optional(),
      }).strict().optional().describe('Filters for documents.new, in the lex_search vocabulary.'),
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
        important: 'The webhook secret above is shown only once: the user must store it now to verify X-Webhook-Signature.',
      };
    },
  },

  {
    name: 'lex_update_webhook',
    title: 'Update a webhook',
    description:
      'Change a webhook\'s name, URL, searchCriteria (null removes them), watch list (replaces the whole list) or status. status ACTIVE re-enables a PAUSED or FAILED webhook and re-queues its recent failed deliveries; PAUSED stops deliveries. Free.',
    inputSchema: {
      id: z.string().trim().min(1).max(64),
      name: z.string().trim().min(1).max(200).optional(),
      url: webhookUrl('Must be a public https URL.').optional().describe('Must be a public https URL.'),
      searchCriteria: z.union([z.record(z.string(), z.unknown()), z.null()]).optional().describe('New criteria (same shape as lex_create_webhook), or null to remove.'),
      watchCelex: z.array(celex('Base-act CELEX')).max(5000).optional(),
      status: z.enum(['ACTIVE', 'PAUSED']).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Delete a webhook',
    description: 'Permanently delete a webhook and its delivery history. Cannot be undone — confirm with the user first. Free.',
    inputSchema: { id: z.string().trim().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    write: true,
    handler: async (a, client) => {
      await client.deleteWebhook(a.id);
      return { deleted: a.id };
    },
  },

  {
    name: 'lex_test_webhook',
    title: 'Send a test delivery',
    description: 'POST a signed webhook.test payload to the webhook URL now and report the endpoint\'s response. Use to check an endpoint is reachable and verifies signatures. Free.',
    inputSchema: { id: z.string().trim().min(1).max(64) },
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
function budgetHitTexts<T extends Record<string, unknown>>(shaped: T, budget: number): T {
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
    ? { ...shaped, note: `${cut} hit text(s) truncated to ${per} characters (maxChars=${budget}). Read a full document with lex_get_document.` }
    : shaped;
}

export function selectTools(opts: { readOnly?: boolean } = {}): ToolDef[] {
  return opts.readOnly ? tools.filter((t) => !t.write) : tools;
}
