// Response shaping: turn LexAPI responses into compact, model-friendly
// objects. Principles:
//   - drop what a model can't use (subscription/usage envelopes, legacy
//     duplicate fields, opaque upstream metadata, snapshot-scoped ids);
//   - keep every field that changes how an answer must be read or cited
//     (textAvailability, language fallback, consolidated labels, asOf
//     resolution, partial/truncated flags, hints);
//   - bound document bodies by a character budget, with an explicit note
//     saying what was left out and how to get it.

import type { Json, LexResponse } from './client.js';

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Remove undefined / null / '' / empty-array / empty-object values (one level deep per call site). */
export function compact<T extends Obj>(o: T): Partial<T> {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (isObj(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function round3(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 1000) / 1000;
}

export function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Low-credit notice ──────────────────────────────────────────────
/**
 * The core API router attaches `credits` to v2 responses. Surfacing it on
 * every call would cost tokens for nothing; a notice only when the pool is
 * nearly empty lets the model warn the user before calls start to 402.
 */
export function creditNotice(body: unknown): string | undefined {
  if (!isObj(body) || !isObj(body.credits)) return undefined;
  const c = body.credits;
  const remaining = num(c.remaining);
  const limit = num(c.limit);
  if (remaining === undefined || limit === undefined || limit <= 0) return undefined;
  if (remaining > 100 && remaining / limit > 0.1) return undefined;
  const reset = str(c.resetsAt);
  return `LexAPI credit pool is low: ${remaining} of ${limit} credits left${reset ? ` (resets ${reset})` : ''}.`;
}

// ── National-law allowance ──────────────────────────────────────────
/**
 * FREE/STARTER/PROFESSIONAL accounts get a monthly allowance of national
 * calls, separate from the credit pool; BUSINESS and higher have no
 * separate limit, so the `X-National-*` headers are simply absent for them.
 * Surfaced on every national tool response (except lex_national_coverage,
 * which does not count against it) so the model can warn the user before
 * calls start to 402 `NATIONAL_ALLOWANCE_EXHAUSTED`.
 */
export function nationalAllowanceOf(headers: LexResponse['headers']): Obj | undefined {
  const limit = num(Number(headers['x-national-limit']));
  const remaining = num(Number(headers['x-national-remaining']));
  const resetsAt = str(headers['x-national-reset']);
  const out = compact({ limit, remaining, resetsAt });
  return Object.keys(out).length ? out : undefined;
}

// ── Consolidated texts ─────────────────────────────────────────────
const CONSOLIDATED_RE = /^0([0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]{2}\))?)-([0-9]{4})([0-9]{2})([0-9]{2})$/;

/** `02016R0679-20160504` → { base: '32016R0679', date: '2016-05-04' }; null otherwise. */
export function consolidatedBaseOf(celex: unknown): { base: string; date: string } | null {
  if (typeof celex !== 'string') return null;
  const m = CONSOLIDATED_RE.exec(celex.toUpperCase().trim());
  return m ? { base: `3${m[1]}`, date: `${m[2]}-${m[3]}-${m[4]}` } : null;
}

export function consolidatedLabel(celex: unknown): Obj | undefined {
  const c = consolidatedBaseOf(celex);
  if (!c) return undefined;
  return {
    consolidated: true,
    consolidatedAsOf: c.date,
    baseCelex: c.base,
    consolidatedNote: `Consolidated text (the act with its amendments integrated, as of ${c.date}) — a documentation tool, not the authentic text. The authentic act is ${c.base} as published in the Official Journal, together with its amending acts.`,
  };
}

// ── In-force label ─────────────────────────────────────────────────
// Whether an act is in force today, on EU legislation (API 2.19.0). All
// four fields are absent when the status is unknown; nothing is derived here.
export const IN_FORCE_KEYS = ['inForce', 'notInForceReason', 'endOfValidity', 'entryIntoForce'] as const;

/** The in-force fields an API object carries, as they are ({} when it has none). */
export function inForceFields(o: Obj): Obj {
  const out: Obj = {};
  for (const k of IN_FORCE_KEYS) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

// ── Document metadata ──────────────────────────────────────────────
const META_KEYS = [
  'title', 'titleLanguage', 'documentType', 'documentTypeCode', 'author',
  'dateOfDocumentISO', 'dateOfEffectISO', 'dateOfPublicationISO', 'dateType',
  'ecli', 'eli', 'caseNumber', 'parties', 'subject',
  'language', 'languageRequested', 'languageFallback', 'version', 'fetchedAt',
  'latestConsolidated', 'upcomingConsolidated', 'newestConsolidated',
  ...IN_FORCE_KEYS,
] as const;

export function shapeMetadata(doc: Obj, headers: LexResponse['headers'] = {}): Obj {
  const out: Obj = { celex: str(doc.celex) ?? str(doc.celexNumber) };
  for (const k of META_KEYS) out[k] = doc[k];
  // Legacy DD/MM/YYYY strings only when no ISO twin exists.
  if (!doc.dateOfDocumentISO && doc.dateOfDocument) out.dateOfDocument = doc.dateOfDocument;
  if (Array.isArray(doc.keywords)) out.keywords = (doc.keywords as unknown[]).slice(0, 20);
  const urls = isObj(doc.urls) ? doc.urls : undefined;
  if (urls) out.url = urls.html ?? urls.metadata;
  // The publisher's URL of the text (provenance), when it is not that link.
  const sourceUrl = sourceUrlOf(doc.provenance);
  if (sourceUrl && sourceUrl !== out.url) out.sourceUrl = sourceUrl;
  if (headers['x-source']) out.source = headers['x-source'];
  // A text-availability block that just says "available" is noise; any
  // other state (no text, why, which languages, consolidated pointers) is
  // essential and passed through verbatim — null vs [] languages differ.
  const ta = doc.textAvailability;
  if (isObj(ta) && !(ta.available === true && Object.keys(ta).length === 1)) out.textAvailability = ta;
  Object.assign(out, consolidatedLabel(out.celex) ?? {});
  return compact(out);
}

// ── Document content with a character budget ───────────────────────
export type View = 'auto' | 'outline' | 'full';

export interface ContentOptions {
  /** Default 'auto'. 'outline' only when the caller asked for it explicitly. */
  view?: View;
  maxChars: number;
  /** Parts the caller asked for explicitly (API `include`); undefined = all. */
  include?: string[];
  /** Skip this many items (across parts, in order) — paging after truncation. In outline view: articles. */
  offset?: number;
  /**
   * The calling tool has no `articleId` / `include` parameters (the national
   * document tool): the outline's reading hint then points at view "full" +
   * offset, the only way that tool reads on.
   */
  noPartSelection?: boolean;
}

const PART_ORDER = ['articles', 'recitals', 'paragraphs', 'annexes', 'tables', 'sections', 'fullText'] as const;
type Part = (typeof PART_ORDER)[number];

interface Item { part: Part; value: unknown; label: string }

/** Split a long string into pieces of at most `max` chars, preferring line / word boundaries. */
function splitText(t: string, max: number): string[] {
  if (t.length <= max) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Body items in reading order. Any item whose text is longer than `chunk`
 * is split into consecutive pieces (labelled "part j/k"), so `offset` can
 * page through a giant annex or a fullText without blank lines.
 */
function itemsOf(content: Obj, parts: readonly Part[], chunk: number): Item[] {
  const items: Item[] = [];
  for (const part of parts) {
    const v = content[part];
    if (part === 'fullText') {
      if (typeof v === 'string' && v.trim()) {
        v.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).forEach((block, i) => {
          const pieces = splitText(block, chunk);
          pieces.forEach((piece, j) => items.push({
            part,
            value: piece,
            label: `fullText block ${i + 1}${pieces.length > 1 ? ` part ${j + 1}/${pieces.length}` : ''}`,
          }));
        });
      }
      continue;
    }
    if (!Array.isArray(v)) continue;
    v.forEach((entry, i) => {
      const e = isObj(entry) ? entry : {};
      const label = part === 'articles' ? String(e.id ?? e.number ?? `article #${i + 1}`)
        : part === 'recitals' || part === 'paragraphs' ? `${part.slice(0, -1)} ${e.number ?? i + 1}`
          : part === 'annexes' ? `annex: ${truncate(str(e.title), 60) ?? `#${i + 1}`}`
            : `${part.slice(0, -1)} #${i + 1}`;
      const key = typeof e.content === 'string' ? 'content' : typeof e.text === 'string' ? 'text' : undefined;
      const text = key ? (e[key] as string) : undefined;
      if (key && text && text.length > chunk) {
        const pieces = splitText(text, chunk);
        pieces.forEach((piece, j) => items.push({
          part,
          value: { ...e, [key]: piece, part: `${j + 1}/${pieces.length}` },
          label: `${label} part ${j + 1}/${pieces.length}`,
        }));
      } else {
        items.push({ part, value: entry, label });
      }
    });
  }
  return items;
}

function size(v: unknown): number {
  return typeof v === 'string' ? v.length : JSON.stringify(v).length;
}

/** Last resort: cut the text of one item that still exceeds the budget. */
function clipItem(item: Item, budget: number): unknown {
  const marker = (n: number) => ` …[truncated: ${n} more characters]`;
  if (typeof item.value === 'string') {
    return item.value.slice(0, budget) + marker(item.value.length - budget);
  }
  if (isObj(item.value)) {
    const v = { ...item.value };
    for (const k of ['content', 'text']) {
      if (typeof v[k] === 'string') {
        const t = v[k] as string;
        const keep = Math.max(200, budget - (size(v) - t.length));
        if (t.length > keep) v[k] = t.slice(0, keep) + marker(t.length - keep);
      }
    }
    return v;
  }
  return item.value;
}

/** How to read on from an outline — only suggesting parts this document has. */
function readingHint(content: Obj, opts?: ContentOptions): string {
  if (opts?.noPartSelection) {
    // No articleId / include on this tool — never suggest them.
    return 'Read on: call again with view "full" (the body in order, up to maxChars); long bodies continue with the offset its note gives.';
  }
  const has = (k: string) => Array.isArray(content[k]) && (content[k] as unknown[]).length > 0;
  const ways: string[] = [];
  if (has('articles')) ways.push(`one article with articleId (e.g. "${firstArticleId(content)}")`);
  if (has('paragraphs')) ways.push('the paragraphs (judgment grounds / body text) with include ["paragraphs"]');
  if (has('recitals')) ways.push('the recitals with include ["recitals"]');
  if (has('annexes')) ways.push('the annexes with include ["annexes"]');
  if (has('tables')) ways.push('the tables with include ["tables"]');
  if (!ways.length && typeof content.fullText === 'string' && content.fullText) ways.push('the text with include ["fullText"] (or view "full")');
  return ways.length ? `Read on: ${ways.join('; ')}. Long parts continue with offset.` : 'The document has no body text.';
}

function outlineOf(content: Obj, maxChars: number, offset: number): { outline: Obj; note?: string } {
  const articles = Array.isArray(content.articles) ? content.articles as unknown[] : [];
  const annexes = Array.isArray(content.annexes) ? content.annexes as unknown[] : [];
  const sections = Array.isArray(content.sections) ? content.sections as unknown[] : [];
  const count = (k: string) => (Array.isArray(content[k]) ? (content[k] as unknown[]).length : 0);
  const base = compact({
    sections: sections.map((sec) => (isObj(sec)
      ? compact({ type: sec.type, number: sec.number, title: sec.title, articles: Array.isArray(sec.articleRange) ? (sec.articleRange as unknown[]).join('–') : undefined })
      : sec)),
    recitalCount: count('recitals') || undefined,
    paragraphCount: count('paragraphs') || undefined,
    annexes: annexes.map((a, i) => (isObj(a) ? truncate(str(a.title), 120) ?? `Annex #${i + 1}` : a)),
    tableCount: count('tables') || undefined,
    fullTextChars: typeof content.fullText === 'string' ? content.fullText.length : undefined,
  });
  // The article list is the part that grows (CRR-size acts: ~500 entries) —
  // bound it by maxChars and page it with offset.
  let budget = maxChars - size(base);
  const listed: unknown[] = [];
  const from = Math.min(offset, articles.length);
  let i = from;
  for (; i < articles.length; i++) {
    const a = articles[i];
    const entry = isObj(a) ? compact({ id: a.id, number: a.number, title: truncate(str(a.title), 160) }) : a;
    const s = size(entry) + 1;
    if (s > budget && listed.length) break;
    budget -= s;
    listed.push(entry);
  }
  const outline = compact({ ...base, articles: listed, articleCount: articles.length > listed.length ? articles.length : undefined });
  const note = articles.length && (from > 0 || i < articles.length)
    ? `Article list ${from + 1}–${i} of ${articles.length}${i < articles.length ? `; call again with view "outline" and offset=${i} for the rest` : ''}.`
    : undefined;
  return { outline, note };
}

/**
 * Shape `content` (a document's parsed body) under a character budget.
 * Returns the shaped content plus a note when anything was outlined, split,
 * truncated or omitted.
 */
export function shapeContent(content: unknown, opts: ContentOptions): { content?: Obj; note?: string } {
  if (!isObj(content)) return {};
  if (opts.include && !opts.include.some((p) => (PART_ORDER as readonly string[]).includes(p))) return {};
  const explicit = opts.include?.filter((p): p is Part => (PART_ORDER as readonly string[]).includes(p));
  // Without an explicit include, fullText duplicates the structured parts —
  // use it only when the document has no structured body at all.
  const structured = PART_ORDER.filter((p) => p !== 'fullText' && Array.isArray(content[p]) && (content[p] as unknown[]).length);
  const parts: Part[] = explicit && explicit.length
    ? PART_ORDER.filter((p) => explicit.includes(p))
    : structured.length ? structured.filter((p) => p !== 'sections') : ['fullText'];

  const chunk = Math.max(1000, Math.floor(opts.maxChars * 0.9));
  const all = itemsOf(content, parts, chunk);
  const totalSize = all.reduce((n, i) => n + size(i.value), 0);
  const offset = Math.max(0, opts.offset ?? 0);

  // Explicitly selected parts are read, never outlined — unless the caller
  // asked for the outline itself.
  let view = opts.view ?? 'auto';
  if (view === 'auto') view = explicit?.length || offset || totalSize <= opts.maxChars ? 'full' : 'outline';

  if (view === 'outline') {
    const { outline, note } = outlineOf(content, opts.maxChars, offset);
    return {
      content: outline,
      note: [`Outline only: the body is ${totalSize} characters (budget maxChars=${opts.maxChars}).`, note, readingHint(content, opts)].filter(Boolean).join(' '),
    };
  }

  const out: Obj = {};
  let used = 0;
  let emitted = 0;
  let clipped = false;
  const rest = all.slice(offset);
  let stoppedAt: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    const s = size(item.value);
    let value = item.value;
    if (used + s > opts.maxChars) {
      if (emitted > 0) { stoppedAt = i; break; }
      value = clipItem(item, opts.maxChars);
      clipped = true;
    }
    if (item.part === 'fullText') {
      out.fullText = out.fullText ? `${out.fullText}\n\n${value}` : value;
    } else {
      const list = (out[item.part] as unknown[] | undefined) ?? [];
      list.push(value);
      out[item.part] = list;
    }
    used += Math.min(s, opts.maxChars);
    emitted++;
  }

  const notes: string[] = [];
  if (offset) notes.push(`Skipped the first ${offset} items (offset).`);
  if (offset >= all.length && all.length) notes.push(`offset ${offset} is past the end (${all.length} items).`);
  if (all.some((i) => / part \d+\/\d+$/.test(i.label))) notes.push('Long items are split into consecutive parts ("part j/k").');
  if (stoppedAt !== undefined) {
    const omitted = rest.slice(stoppedAt);
    notes.push(`Truncated at maxChars=${opts.maxChars}: ${omitted.length} more items omitted (${omitted[0].label} … ${omitted[omitted.length - 1].label}). Call again with the same arguments and offset=${offset + stoppedAt}.`);
  }
  if (clipped) notes.push('One item was longer than maxChars and was cut; raise maxChars (max 200000) to read it whole.');
  return { content: out, note: notes.length ? notes.join(' ') : undefined };
}

function firstArticleId(content: Obj): string | undefined {
  const a = Array.isArray(content.articles) ? content.articles[0] : undefined;
  return isObj(a) ? (str(a.id) ?? str(a.number)) : undefined;
}

/** A full document object (from /documentContent, batch, by-URL) → compact form. */
export function shapeDocument(doc: unknown, headers: LexResponse['headers'], opts: ContentOptions): Obj {
  if (!isObj(doc)) return {};
  const out = shapeMetadata(doc, headers);
  if (doc.content === null) {
    out.content = null; // no text published — textAvailability says why
    return out;
  }
  const { content, note } = shapeContent(doc.content, opts);
  if (content) out.content = content;
  if (note) out.note = note;
  return out;
}

// ── Search results ─────────────────────────────────────────────────
const ALL_LANGS = 24;

export function shapeSearchResult(r: unknown): Obj {
  if (!isObj(r)) return {};
  const langs = Array.isArray(r.availableLanguages) ? (r.availableLanguages as string[]) : [];
  return compact({
    celex: str(r.celex) ?? str(r.celexNumber),
    title: r.title,
    type: r.documentTypeCode ?? r.documentType ?? r.form,
    date: r.dateOfDocumentISO ?? r.date,
    author: r.author,
    // 24 codes per hit is a lot of tokens for "all of them".
    languages: langs.length && langs.length < ALL_LANGS ? langs.join(',') : undefined,
    url: r.url,
  });
}

export function shapeSearch(res: LexResponse<Json>): Obj {
  const b = res.body;
  const results = Array.isArray(b.results) ? b.results.map(shapeSearchResult) : [];
  return compact({
    totalResults: b.totalResults,
    totalPages: b.totalPages,
    pagesFetched: b.pagesFetched,
    resultCount: results.length,
    results,
    hint: b.hint,
    truncated: b.truncated,
    truncatedReason: b.truncatedReason,
    partial: b.partial,
    partialReason: b.partialReason,
    postFilteredBy: b.postFilteredBy,
    ignoredDocumentTypes: b.ignoredDocumentTypes,
    source: b.source ?? res.headers['x-search-source'],
    cache: res.headers['x-search-cache'] === 'hit' ? 'hit' : undefined,
    warning: res.headers['x-warning'],
    fetchedAt: b.fetchedAt,
  });
}

export function shapeRecent(res: LexResponse<Json>): Obj {
  const b = res.body;
  const results = Array.isArray(b.results) ? b.results.map(shapeSearchResult) : [];
  const p = isObj(b.parameters) ? b.parameters : {};
  return compact({
    window: p.dateFrom && p.dateTo ? `${p.dateFrom}..${p.dateTo}` : undefined,
    totalResults: b.totalResults,
    resultCount: results.length,
    results,
    languageFilter: b.languageFilter,
    hint: b.hint,
    partial: b.partial,
    partialReason: b.partialReason,
    source: res.headers['x-source'],
    warning: res.headers['x-warning'],
  });
}

// ── Semantic search ────────────────────────────────────────────────
const CASE_ANALYTICS = [
  'outcome', 'outcome_detail', 'party_role', 'claimed_amount', 'awarded_amount', 'currency',
  'award_percentage', 'legal_area', 'legislation_cited', 'duration_days', 'was_appealed', 'appeal_outcome',
];

export function shapeCaseLawHit(r: unknown): Obj {
  if (!isObj(r)) return {};
  const md = isObj(r.metadata) ? r.metadata : {};
  const out: Obj = {
    celex: md.celex_id,
    documentType: md.document_type,
    score: round3(r.score),
    case_name: r.case_name,
    case_number: r.case_number,
    ecli: r.ecli,
    court: r.court,
    decision_date: r.decision_date,
    parties: r.parties,
    language: r.language && r.language !== 'en' ? r.language : undefined,
    paragraph: md.paragraph_number,
    // `snippet` is the head of `summary` when one exists — send one, not both.
    summary: r.summary,
    snippet: r.summary ? undefined : r.snippet,
    text: r.text,
    sourceUrl: sourceUrlOf(r.provenance),
  };
  for (const k of CASE_ANALYTICS) out[k] = r[k];
  return compact(out);
}

export function shapeCaseLaw(res: LexResponse<Json>): Obj {
  const b = res.body;
  const results = Array.isArray(b.results) ? b.results.map(shapeCaseLawHit) : [];
  return compact({
    resultCount: results.length,
    results,
    hint: b.hint,
    hyde: b.hyde,
  });
}

export function shapeLegislationHit(r: unknown): Obj {
  if (!isObj(r)) return {};
  return compact({
    law_id: r.law_id,
    law_title: r.law_title,
    article_ref: r.article_ref,
    section: r.section,
    chapter: r.chapter,
    score: round3(r.score),
    language: r.language,
    snippet: r.snippet,
    text: r.text,
    // Consolidated-text labelling — kept verbatim.
    consolidated: r.consolidated,
    consolidatedAsOf: r.consolidatedAsOf,
    baseCelex: r.baseCelex,
    consolidatedNote: r.consolidatedNote,
    baseAct: isObj(r.baseAct) ? compact({ ...r.baseAct, score: round3(r.baseAct.score) }) : undefined,
    // asOf resolution.
    asOf: r.asOf,
    asOfResolved: r.asOfResolved,
    asOfReason: r.asOfReason,
    asOfVersion: r.asOfVersion,
    matchedVersion: r.matchedVersion,
    // The act's in-force status today; absent when unknown.
    ...inForceFields(r),
    sourceUrl: sourceUrlOf(r.provenance),
  });
}

export function shapeLegislation(res: LexResponse<Json>): Obj {
  const b = res.body;
  const results = Array.isArray(b.results) ? b.results.map(shapeLegislationHit) : [];
  const anyConsolidated = results.some((r) => r.consolidated === true
    || (isObj(r.asOfVersion) && r.asOfVersion.kind === 'consolidated'));
  return compact({
    asOf: b.asOf,
    asOfSummary: b.asOfSummary,
    resultCount: results.length,
    results,
    hint: b.hint,
    citing: anyConsolidated
      ? 'Some hits are consolidated texts (consolidated: true, or asOfVersion.kind "consolidated"): they are documentation tools without legal force. The authentic act is baseCelex / baseAct.law_id as published in the Official Journal, together with the amending acts where relevant.'
      : undefined,
    asOfCaveat: b.asOf ? asOfCaveat(results, String(b.asOf)) : undefined,
  });
}

// asOfReason classes (docs.md "asOf — the text in force on a date").
const AS_OF_NOT_IN_FORCE = new Set(['not_yet_adopted', 'not_yet_in_force', 'no_longer_in_force']);
const AS_OF_RETRYABLE = new Set([
  'fetch_pending', 'fetch_capacity', 'fetch_budget_exhausted', 'request_deadline', 'fetch_timeout',
  'fetch_failed', 'version_lookup_cap', 'version_list_unavailable', 'credit_check_failed',
]);
const AS_OF_USER_ACTION = new Set(['insufficient_credits']);

type AsOfGroup = 'notInForce' | 'retryable' | 'needsCredits' | 'unavailable';

/** The class of an asOfReason; a reason not listed above is `unavailable`. */
function asOfGroupOf(reason: string): AsOfGroup {
  if (AS_OF_NOT_IN_FORCE.has(reason)) return 'notInForce';
  if (AS_OF_RETRYABLE.has(reason)) return 'retryable';
  if (AS_OF_USER_ACTION.has(reason)) return 'needsCredits';
  return 'unavailable';
}

/**
 * One instruction per class of unresolved hit present. Every unresolved
 * hit carries the indexed text; what the model should do differs:
 *   - not in force on the date → that IS the answer (say so);
 *   - transient → retry shortly, or with a smaller limit;
 *   - credits → the pool could not pay for the fetch;
 *   - anything else (no text in that version, language, article missing…) →
 *     the version in force could not be read; don't quote it as of that date.
 */
export function asOfCaveat(results: Obj[], asOf: string): Obj | undefined {
  const groups: Record<AsOfGroup, string[]> = { notInForce: [], retryable: [], needsCredits: [], unavailable: [] };
  for (const r of results) {
    if (r.asOfResolved !== false) continue;
    const reason = String(r.asOfReason ?? 'unknown');
    const id = `${String(r.law_id ?? '?')}${r.article_ref ? ` ${String(r.article_ref)}` : ''} (${reason})`;
    groups[asOfGroupOf(reason)].push(id);
  }
  const guidance: string[] = [];
  if (groups.notInForce.length) guidance.push(`notInForce: these acts were not in force on ${asOf} (not yet adopted / not yet in force / no longer in force) — that is the answer for them; their returned text is not the law on that date.`);
  if (groups.retryable.length) guidance.push('retryable: the version in force could not be fetched in this call (busy, time or fetch limits) — call again shortly, or with a smaller limit.');
  if (groups.needsCredits.length) guidance.push('needsCredits: the credit pool could not cover fetching the version in force.');
  if (groups.unavailable.length) guidance.push(`unavailable: the version in force on ${asOf} could not be read (see asOfReason); the returned text is not the law on that date.`);
  if (!guidance.length) return undefined;
  return compact({
    note: `Unresolved hits carry the indexed text, not the text in force on ${asOf}.`,
    ...Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length)),
    guidance,
  });
}

// ── The version of an act for a date (POST /legislation/as-of) ─────
// What each asOfReason of the lookup means (API reference, "Unresolved").
const DATE_OUTSIDE = 'The date is outside the act\'s dates.';
const NOT_FETCHED = 'The text could not be fetched now.';
const NOT_PAID = 'The fetch was not paid for, so it was not made.';
const AS_OF_LOOKUP_MEANING: Record<string, string> = {
  not_yet_adopted: DATE_OUTSIDE,
  not_yet_in_force: DATE_OUTSIDE,
  no_longer_in_force: DATE_OUTSIDE,
  in_force_dates_unknown: 'The act\'s dates do not establish whether it was in force on the date, or could not be read.',
  act_type_not_supported: 'The act is not a regulation, directive, decision or other act of the institutions (CELEX sector 3), for example a treaty or an international agreement; the lookup does not cover it.',
  version_list_unavailable: 'The list of versions, or of the acts amending the act, could not be read.',
  version_lookup_cap: 'A lookup limit was reached.',
  not_in_language: 'The version for the date has no text in the requested language.',
  amendment_not_consolidated: 'An act amending this act may have applied by the date, and no listed version is known to include it.',
  text_unavailable: 'The version has no text at the source.',
  article_not_in_version: 'The version has no such article, annex or recital.',
  provision_ambiguous: 'More than one part of the text answers to the requested provision.',
  version_not_parsed: 'The text is not split into identifiable parts of the requested kind.',
  fetch_budget_exhausted: NOT_FETCHED,
  fetch_pending: NOT_FETCHED,
  fetch_capacity: NOT_FETCHED,
  fetch_failed: NOT_FETCHED,
  fetch_timeout: NOT_FETCHED,
  request_deadline: NOT_FETCHED,
  insufficient_credits: NOT_PAID,
  credit_check_failed: NOT_PAID,
};

/** The caveat of an unresolved lookup: the reason's class (as in asOfCaveat), what the reason means, and what follows. */
export function asOfLookupCaveat(reason: string, asOf: string, versionEstablished: boolean): Obj {
  const group = asOfGroupOf(reason);
  const guidance: Record<AsOfGroup, string> = {
    notInForce: `notInForce: the act was not in force on ${asOf} (not yet adopted / not yet in force / no longer in force) — that is the answer for this date.`,
    retryable: 'retryable: the version or its text could not be read in this call (busy, time or lookup limits) — calling again shortly may resolve it.',
    needsCredits: 'needsCredits: the credit pool could not cover fetching the text. A fetch reserves 5 credits, so a pool holding fewer than 5 gets insufficient_credits even for an answer that would cost 4.',
    unavailable: `unavailable: the text for ${asOf} was not established (see meaning).`,
  };
  return compact({
    note: versionEstablished
      ? `Unresolved: no text is returned for ${asOf}. asOfVersion is the version listed for that date; the requested provision of it was not established.`
      : `Unresolved: no version and no text are returned for ${asOf}.`,
    group,
    meaning: Object.hasOwn(AS_OF_LOOKUP_MEANING, reason) ? AS_OF_LOOKUP_MEANING[reason] : undefined,
    guidance: guidance[group],
  });
}

const AS_OF_VERSION_KEYS = ['celex', 'kind', 'date', 'validUntil', 'checkedAt'] as const;
const AS_OF_ACT_KEYS = ['celex', 'dateOfDocument', 'entryIntoForce', 'endOfValidity', 'inForceToday'] as const;
const PROVENANCE_KEYS = ['publisher', 'sourceUrl', 'sourceIdentifier', 'retrievedAt', 'contentHash', 'versionIdentifier', 'language', 'licence'] as const;
/** Characters of a provision's text returned by lex_legislation_as_of (the default budget of the document tools). */
export const AS_OF_PROVISION_BUDGET = 40_000;
/** Longest value of a field that is an id, a date, a link or a one-line label. */
const AS_OF_FIELD_MAX = 500;
/** Longest heading (number, title) of a provision. */
const AS_OF_HEADING_MAX = 300;

/** A non-empty string no longer than `max`; anything else (an object, a list, a number) is undefined. */
function label(v: unknown, max = AS_OF_FIELD_MAX): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : undefined;
}

/** The listed keys of an API object whose value is a label (a boolean for `flags`); undefined when it is not an object or has none. */
function pick(o: unknown, keys: readonly string[], flags: readonly string[] = []): Obj | undefined {
  if (!isObj(o)) return undefined;
  const out: Obj = {};
  for (const k of keys) {
    const v = flags.includes(k) ? (typeof o[k] === 'boolean' ? o[k] : undefined) : label(o[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `text` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * A POST /legislation/as-of answer → compact form. Only an answer with
 * `asOfResolved: true` keeps a provision text and the consolidated labels;
 * any other answer carries `asOfResolved: false`, the reason and a caveat,
 * and never a text. A field is copied only when it has the expected type.
 */
export function shapeAsOfLookup(body: unknown, budget = AS_OF_PROVISION_BUDGET): Obj {
  const b = isObj(body) ? body : {};
  const resolved = b.asOfResolved === true;
  const asOfVersion = pick(b.asOfVersion, AS_OF_VERSION_KEYS);
  const language = label(b.language);
  const asOf = label(b.asOf);
  const head = {
    document: label(b.document),
    language,
    asOf,
    asOfResolved: resolved,
  };
  const tail = { act: pick(b.act, AS_OF_ACT_KEYS, ['inForceToday']), provenance: pick(b.provenance, PROVENANCE_KEYS) };
  if (!resolved) {
    const reason = label(b.asOfReason);
    return compact({
      ...head,
      asOfReason: reason,
      asOfVersion,
      ...tail,
      asOfCaveat: asOfLookupCaveat(reason ?? 'unknown', asOf ?? 'the date', asOfVersion !== undefined),
    });
  }
  const p = isObj(b.provision) && typeof b.provision.text === 'string' && b.provision.text.trim() ? b.provision : undefined;
  let provision: Obj | undefined;
  let note: string | undefined;
  if (p) {
    const full = p.text as string;
    const kept = cutText(full, budget);
    provision = compact({
      id: label(p.id),
      number: typeof p.number === 'string' ? truncate(p.number, AS_OF_HEADING_MAX) : undefined,
      title: typeof p.title === 'string' ? truncate(p.title, AS_OF_HEADING_MAX) : undefined,
      text: kept.length < full.length ? `${kept} …[truncated: ${full.length - kept.length} more characters]` : full,
    });
    if (kept.length < full.length) {
      const celex = label(asOfVersion?.celex);
      note = `provision.text is cut to ${kept.length} of ${full.length} characters. The whole text is read with lex_get_document${celex ? ` for ${celex}` : ''}${celex && language ? `, language ${language}` : ''} (articleId or include, with offset).`;
    }
  }
  return compact({
    ...head,
    asOfVersion,
    ...tail,
    provision,
    consolidated: b.consolidated === true ? true : undefined,
    consolidatedAsOf: label(b.consolidatedAsOf),
    baseCelex: label(b.baseCelex),
    consolidatedNote: label(b.consolidatedNote),
    note,
  });
}

// ── Citations ──────────────────────────────────────────────────────
// Node identity (API 2.11.0): every node carries `id` (= `celexNumber`),
// `jurisdiction` and `documentKind`. `jurisdiction` is kept only when it is
// not EU, so EU-only answers stay as compact as before.
export function nodeFields(n: Obj): Obj {
  return compact({
    celex: n.celexNumber ?? n.id,
    jurisdiction: n.jurisdiction === 'EU' ? undefined : n.jurisdiction,
    documentKind: n.documentKind,
  });
}

function distinct(values: unknown[]): unknown[] {
  return [...new Set(values.filter((v) => v !== undefined && v !== null && v !== ''))];
}

function shapeEdgeGroup(g: unknown): Obj {
  if (!isObj(g)) return {};
  const edges = (Array.isArray(g.citations) ? g.citations : []).filter(isObj);
  const snippet = edges.map((e) => str(e.contextSnippet)).find(Boolean);
  return compact({
    ...nodeFields(g),
    title: g.title,
    types: distinct(edges.map((e) => e.citationType)),
    provenance: distinct(edges.map((e) => e.provenance)),
    resolution: distinct(edges.map((e) => e.resolution)),
    count: g.citationCount,
    context: truncate(snippet, 240),
  });
}

/** `unresolved=true` on a national id: at most this many references are shown. */
export const UNRESOLVED_SHOWN = 100;

/** The references a national document records that could not become an edge (bounded). */
function unresolvedFields(b: Obj): Obj {
  if (!Array.isArray(b.unresolved)) return {};
  const all = b.unresolved.filter(isObj);
  const out: Obj = {
    unresolved: all.slice(0, UNRESOLVED_SHOWN).map((u) => compact({
      kind: u.kind,
      text: truncate(str(u.text), 200),
      status: u.status,
      targetId: u.targetId,
    })),
  };
  if (typeof b.unresolvedTruncated === 'boolean') out.unresolvedTruncated = b.unresolvedTruncated;
  if (all.length > UNRESOLVED_SHOWN) out.unresolvedNote = `${all.length - UNRESOLVED_SHOWN} more unresolved references not shown.`;
  return out;
}

export function shapeCitedBy(res: LexResponse<Json>): Obj {
  const b = res.body;
  return compact({
    target: b.targetDocument,
    totalCitations: b.totalCitations,
    totalEdges: b.totalEdges,
    countsSource: b.countsSource,
    limit: b.limit,
    offset: b.offset,
    citedBy: Array.isArray(b.citedBy) ? b.citedBy.map(shapeEdgeGroup) : [],
    relationSync: b.relationSync,
    // Present only when the caller's account can see at least one national
    // jurisdiction — absent entirely for everyone else, so EU-only
    // responses are unchanged.
    includeNational: b.includeNational,
  });
}

export function shapeCites(res: LexResponse<Json>): Obj {
  const b = res.body;
  return compact({
    source: b.sourceDocument,
    totalCitations: b.totalCitations,
    totalEdges: b.totalEdges,
    countsSource: b.countsSource,
    limit: b.limit,
    offset: b.offset,
    cites: Array.isArray(b.cites) ? b.cites.map(shapeEdgeGroup) : [],
    includeNational: b.includeNational,
    ...unresolvedFields(b),
  });
}

function shapeNeighbour(n: unknown): Obj {
  if (!isObj(n)) return {};
  const details = (Array.isArray(n.edgeDetails) ? n.edgeDetails : []).filter(isObj);
  return compact({
    ...nodeFields(n),
    title: n.title,
    types: n.types,
    count: n.count,
    provenance: distinct(details.map((d) => d.provenance)),
    resolution: distinct(details.map((d) => d.resolution)),
  });
}

export function shapeNetwork(res: LexResponse<Json>): Obj {
  const b = res.body;
  const net = isObj(b.network) ? b.network : {};
  return compact({
    celex: b.document,
    cites: Array.isArray(net.cites) ? net.cites.map(shapeNeighbour) : [],
    citedBy: Array.isArray(net.citedBy) ? net.citedBy.map(shapeNeighbour) : [],
    paging: b.paging,
    partial: b.partial,
    partialReason: b.partialReason,
    message: b.message,
    relationSync: b.relationSync,
    includeNational: b.includeNational,
    ...unresolvedFields(b),
  });
}

// ── Transposition and counterparts (API 2.11.0) ───────────────────
// A notified measure is a notification, not a finding that the measure
// transposes the act: the API's `note` is always carried through.

function shapeMeasure(m: Obj): Obj {
  const oj = isObj(m.officialJournal) ? compact(m.officialJournal) : undefined;
  const cellar = isObj(m.cellar)
    ? compact({
      celex: m.cellar.celex,
      dateDocument: m.cellar.dateDocument,
      dateNotification: m.cellar.dateNotification,
      entryIntoForce: m.cellar.entryIntoForce,
    })
    : undefined;
  return compact({
    id: m.id,
    resolved: m.resolved,
    resolution: m.resolution,
    resolutionBasis: m.resolutionBasis,
    provenance: m.provenance,
    citationType: m.citationType,
    title: truncate(str(m.title), 300),
    typeAct: m.typeAct,
    officialJournal: oj,
    reference: m.reference,
    eli: m.eli,
    link: m.link,
    cellar,
  });
}

/** Character budget of one transposition / counterparts result. */
export const GRAPH_RESULT_BUDGET = 40_000;

/**
 * The measures are bounded here (`limit` / `offset`, counted across
 * countries in the API's order, and a character budget: measures stop once
 * it is spent, so the next offset is exact); every country's `counts` is
 * always kept.
 */
export function shapeTransposition(res: LexResponse<Json>, limit: number, offset: number, budget = GRAPH_RESULT_BUDGET): Obj {
  const b = res.body;
  const countries = (Array.isArray(b.jurisdictions) ? b.jurisdictions : []).filter(isObj);
  let index = 0;
  let returned = 0;
  let used = 0;
  let full = false;
  const jurisdictions = countries.map((c) => {
    const measures = (Array.isArray(c.measures) ? c.measures : []).filter(isObj);
    const shown: Obj[] = [];
    for (const m of measures) {
      if (!full && index >= offset && index < offset + limit) {
        const shaped = shapeMeasure(m);
        const cost = size(shaped);
        if (returned > 0 && used + cost > budget) full = true;
        else {
          shown.push(shaped);
          returned++;
          used += cost;
        }
      }
      index++;
    }
    return compact({ jurisdiction: c.jurisdiction, live: c.live, counts: c.counts, measures: shown });
  });
  const total = index;
  const doc = isObj(b.document) ? compact({ ...nodeFields(b.document), title: b.document.title }) : undefined;
  const out: Obj = compact({
    document: doc,
    note: b.note,
    includeNational: b.includeNational,
    termsRequired: b.termsRequired,
    source: b.source,
    truncated: b.truncated,
    jurisdictions,
  });
  out.shown = { offset, returned, total };
  if (offset + returned < total) {
    out.more = `Measures ${offset + 1}–${offset + returned} of the ${total} returned shown. Call again with offset ${offset + returned} (another 5 credits), or narrow with jurisdictions.`;
  }
  if (b.truncated === true) {
    out.truncatedNote = `The API returned only part of this act's measures (truncated: true), so ${total} is not the full number: see source.cellar.measures and each country's counts.measures. Narrow with jurisdictions to see the rest.`;
  }
  return out;
}

/**
 * Counterparts: at most `acts` EU acts per call (from `offset`), at most
 * `limit` counterparts per act, and acts stop once the character budget is
 * spent (the first one is always shown).
 */
export function shapeCounterparts(res: LexResponse<Json>, limit: number, offset: number, acts: number, budget = GRAPH_RESULT_BUDGET): Obj {
  const b = res.body;
  const via = (Array.isArray(b.via) ? b.via : []).filter(isObj);
  const all = via.slice(offset, offset + acts).map((v) => {
    const act = isObj(v.euAct) ? v.euAct : {};
    const cps = (Array.isArray(v.counterparts) ? v.counterparts : []).filter(isObj);
    const entry: Obj = compact({
      euAct: compact({ ...nodeFields(act), title: truncate(str(act.title), 300), notifiedMeasures: act.notifiedMeasures }),
      edge: isObj(v.edge) ? compact(v.edge) : undefined,
      counterparts: cps.slice(0, limit).map((c) => compact({
        jurisdiction: c.jurisdiction,
        id: c.id,
        resolved: c.resolved,
        title: truncate(str(c.title), 200),
        citationType: c.citationType,
        provenance: c.provenance,
        rank: c.rank,
      })),
      truncated: v.truncated === true ? true : undefined,
    });
    if (cps.length > limit) entry.more = `${cps.length - limit} more counterparts for this act not shown (raise limit, up to 50).`;
    return entry;
  });
  const shapedVia: Obj[] = [];
  let used = 0;
  for (const entry of all) {
    const cost = size(entry);
    if (shapedVia.length > 0 && used + cost > budget) break;
    shapedVia.push(entry);
    used += cost;
  }
  const window = shapedVia;
  const out: Obj = compact({
    document: isObj(b.document) ? compact({ ...nodeFields(b.document), title: b.document.title }) : undefined,
    includeNational: b.includeNational,
    truncated: b.truncated,
    via: shapedVia,
  });
  out.note = 'Rank 2 and 3 counterparts are measures a member state notified to the Commission: a notification is not a finding that the measure transposes the act, or transposes it completely.';
  if (offset + window.length < via.length) {
    out.more = `EU acts ${offset + 1}–${offset + window.length} of ${via.length} shown. Call again with offset ${offset + window.length} (another 20 credits).`;
  }
  return out;
}

// ── National law ─────────────────────────────────────────────────
// National documents key on `id` (not `celex`) and always carry
// `attribution` (per-source licence/attribution text) — never dropped by
// compacting, since it is the legally required attribution for the source.
//
// Since API 2.8.0 every national response has ONE shape
// for every jurisdiction: `documentKind` ('act' | 'decision'), a decision's
// `decision: { court, chamber, caseNumbers, citedNorms }`, and a closed
// `content` key set (lane extras only under `content.details` /
// `articles[].details`). The tools present the same uniform fields
// everywhere — `documentKind`, `court`, `chamber`, `caseNumbers`,
// `citedNorms`, `dateOfDocument`, `ecli` — whatever the country, and never
// read a source's raw keys (gericht, aktenzeichen, zaaknummer, …).

/** The listing-summary fields (API 2.8.0 NationalDocumentSummary), compacted. */
function nationalSummaryFields(r: Obj): Obj {
  return compact({
    id: r.id,
    jurisdiction: r.jurisdiction,
    language: r.language,
    documentKind: r.documentKind,
    title: r.title,
    documentType: r.documentType,
    ecli: r.ecli,
    eli: r.eli,
    dateOfDocument: r.dateOfDocument,
    version: r.version,
    fetchedAt: r.fetchedAt,
    validTo: r.validTo,
    inForce: r.inForce,
  });
}

export function shapeNationalSearchResult(r: unknown): Obj {
  if (!isObj(r)) return {};
  return nationalSummaryFields(r);
}

/** A decision's normalized case-law metadata (`document.decision`), flattened; {} for acts. */
function nationalDecisionFields(decision: unknown): Obj {
  if (!isObj(decision)) return {};
  const citedNorms = Array.isArray(decision.citedNorms)
    ? decision.citedNorms.filter(isObj).map((n) => compact({ text: n.text, documentId: n.documentId }))
    : undefined;
  return compact({
    court: decision.court,
    chamber: decision.chamber,
    caseNumbers: decision.caseNumbers,
    citedNorms,
  });
}

/**
 * One national article for the model: the uniform unit fields only. The
 * unit's `details` (source unit ids, kinds) are dropped as noise; a unit the
 * source publishes no text for keeps an explicit `text: null`.
 */
function shapeNationalArticle(a: unknown): unknown {
  if (!isObj(a)) return a;
  const out: Obj = compact({
    number: a.number,
    title: a.title,
    section: a.section,
    inForceFrom: a.inForceFrom,
    inForceTo: a.inForceTo,
  });
  out.text = typeof a.text === 'string' ? a.text : null;
  return out;
}

/** A full national document (from GET /{jur}/documents/{id}). */
export function shapeNationalDocument(doc: unknown, opts: ContentOptions): Obj {
  if (!isObj(doc)) return {};
  // `compact` drops `null` values — build the metadata fields through it
  // first, then set `content: null` (when that's the case) on the result
  // directly, never through another `compact` call, or the "no text" signal
  // would be lost (same pitfall shapeDocument's content:null branch avoids).
  const out: Obj = {
    ...nationalSummaryFields(doc),
    // Case-law metadata, same fields in every country; served also when the
    // decision has no text. Absent for acts (`decision: null`).
    ...nationalDecisionFields(doc.decision),
    ...compact({
      textBasis: doc.textBasis,
      sourceUrl: sourceUrlOf(doc.provenance),
      // Required legal attribution for the source (RIS, gesetze-im-internet.de,
      // Normattiva, Légifrance/Judilibre, the Rechtspraak open data, …): always
      // kept, never dropped by compacting elsewhere.
      attribution: doc.attribution,
    }),
  };
  // A text-availability block that just says "available" is noise (mirrors
  // shapeMetadata); any other state (no text, why, which languages) is kept.
  const ta = doc.textAvailability;
  if (isObj(ta) && !(ta.available === true && Object.keys(ta).length === 1)) out.textAvailability = ta;
  if (doc.content === null) {
    out.content = null; // no text published — textAvailability says why
    return out;
  }
  const c = isObj(doc.content) ? doc.content : undefined;
  if (c) {
    // The language facts of the text change how it must be read/cited —
    // surfaced only when they say something beyond the document's language.
    const langs = Array.isArray(c.textLanguages) ? c.textLanguages : [];
    if (langs.length > 1 || (langs.length === 1 && langs[0] !== doc.language)) out.textLanguages = langs;
    if (str(c.textLanguage)) out.textLanguage = c.textLanguage;
    if (c.embeddedForeignText === true) out.embeddedForeignText = true;
    if (isObj(c.repeal)) out.repeal = compact({ validTo: c.repeal.validTo, basis: c.repeal.basis, detectedAt: c.repeal.detectedAt });
  }
  const body = c
    ? { fullText: c.fullText, articles: Array.isArray(c.articles) ? c.articles.map(shapeNationalArticle) : [] }
    : doc.content;
  const { content, note } = shapeContent(body, { ...opts, noPartSelection: true });
  if (content) out.content = content;
  if (note) out.note = note;
  return out;
}

/**
 * A national case-law hit. `documentKind`, `title`, `ecli` and
 * `dateOfDocument` come from the hit's `document` (LexAPI's own record, the
 * same fields in every country — API 2.8.0), falling back to the index's
 * own metadata; `court` / `caseNumbers` come from the index (a summary
 * carries no decision block — lex_get_national_document has the normalized
 * court, chamber, caseNumbers and citedNorms).
 */
export function shapeNationalCaseLawHit(r: unknown): Obj {
  if (!isObj(r)) return {};
  const md = isObj(r.metadata) ? r.metadata : {};
  const d = isObj(r.document) ? r.document : {};
  const caseNumber = str(r.case_number);
  const out: Obj = {
    documentId: r.documentId ?? d.id ?? md.celex_id,
    jurisdiction: r.jurisdiction ?? d.jurisdiction,
    documentKind: d.documentKind,
    score: round3(r.score),
    title: d.title ?? r.case_name,
    documentType: d.documentType,
    ecli: d.ecli ?? r.ecli,
    dateOfDocument: d.dateOfDocument ?? r.decision_date,
    court: r.court,
    caseNumbers: caseNumber ? [caseNumber] : undefined,
    parties: r.parties,
    language: r.language && r.language !== 'en' ? r.language : undefined,
    summary: r.summary,
    snippet: r.summary ? undefined : r.snippet,
    text: r.text,
    validTo: r.validTo ?? d.validTo,
    inForce: r.inForce ?? d.inForce,
    sourceUrl: sourceUrlOf(d.provenance),
    // Required legal attribution for the source — always kept.
    attribution: r.attribution,
  };
  for (const k of CASE_ANALYTICS) out[k] = r[k];
  return compact(out);
}

export function shapeNationalCaseLaw(res: LexResponse<Json>): Obj {
  const b = res.body;
  const results = Array.isArray(b.results) ? b.results.map(shapeNationalCaseLawHit) : [];
  return compact({
    jurisdiction: b.jurisdiction,
    resultCount: results.length,
    results,
    hint: b.hint,
    // Present when the national index could not complete the search: the
    // results may be missing better matches (the hint says what may help).
    partial: b.partial,
    partialReason: b.partialReason,
    attribution: b.attribution,
  });
}

/**
 * A national legislation hit. The index fields (snake_case — the server's
 * own names on this endpoint) are always sent since API 2.8.0, null when
 * the index has nothing (compacted away here); `documentKind`, `title` and
 * the act's validity come from the hit's `document` summary.
 */
export function shapeNationalLegislationHit(r: unknown, asOf?: string): Obj {
  if (!isObj(r)) return {};
  const d = isObj(r.document) ? r.document : {};
  return compact({
    law_id: r.law_id,
    documentId: r.documentId ?? d.id,
    jurisdiction: r.jurisdiction ?? d.jurisdiction,
    documentKind: d.documentKind,
    law_title: r.law_title ?? d.title,
    documentType: d.documentType,
    article_ref: r.article_ref,
    section: r.section,
    chapter: r.chapter,
    score: round3(r.score),
    language: r.language,
    // With asOf, the label comes before the text it qualifies.
    ...(asOf ? nationalAsOfFields(r, asOf) : {}),
    snippet: r.snippet,
    text: r.text,
    // From the index (as of today), or our row's confirmed-repeal override
    // toward false (with valid_to). null = unknown, dropped.
    in_force: r.in_force,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    law_type: r.law_type,
    sourceUrl: sourceUrlOf(d.provenance),
    // Required legal attribution for the source — always kept.
    attribution: r.attribution,
  });
}

// ── National asOf labels (API 2.29.0) ──────────────────────────────
// A national hit is always today's wording; asOf says only whether that
// wording already applied on the date. Unlike the EU reasons, none of
// these means that an earlier version could not be read: LexAPI holds no
// earlier wording at all.
const NATIONAL_AS_OF_MEANING: Record<string, string> = {
  provision_amended_since: 'the provision was amended or added after that date; LexAPI cannot return the earlier wording',
  no_longer_in_force: 'the provision or its act was no longer in force on that date',
  provision_dates_unknown: 'the dates of the provision\'s current wording are unknown',
  asof_not_available: 'LexAPI holds no per-provision dates for this country',
};
const NATIONAL_AS_OF_GROUP: Record<string, string> = {
  provision_amended_since: 'amendedSince',
  no_longer_in_force: 'notInForce',
  provision_dates_unknown: 'datesUnknown',
  asof_not_available: 'notAvailable',
};
const NATIONAL_AS_OF_VERSION_KEYS = ['kind', 'validFrom', 'validTo', 'sourceId', 'checkedAt'] as const;

function nationalAsOfMeaning(reason: string | undefined): string {
  return reason && Object.hasOwn(NATIONAL_AS_OF_MEANING, reason)
    ? NATIONAL_AS_OF_MEANING[reason]
    : 'whether it applied on that date was not established';
}

/**
 * The asOf fields of a national hit. Only `asOfResolved: true` counts as
 * resolved; every other hit is labelled unresolved, and its `asOfLabel`
 * says that the text shown is today's wording, not established as the text
 * for the date. `asOfVersion.validTo: null` (an open end) is kept.
 */
function nationalAsOfFields(r: Obj, asOf: string): Obj {
  if (r.asOfResolved === true) {
    const v = isObj(r.asOfVersion) ? r.asOfVersion : {};
    const version: Obj = {};
    for (const k of NATIONAL_AS_OF_VERSION_KEYS) {
      if (typeof v[k] === 'string' && (v[k] as string).length <= 200) version[k] = v[k];
      else if (k === 'validTo' && v[k] === null) version[k] = null;
    }
    return { asOf, asOfResolved: true, asOfVersion: Object.keys(version).length ? version : undefined };
  }
  const reason = typeof r.asOfReason === 'string' && r.asOfReason.length <= 100 ? r.asOfReason : undefined;
  return {
    asOf,
    asOfResolved: false,
    asOfReason: reason,
    asOfLabel: `Today's wording, not established as the text on ${asOf}: ${nationalAsOfMeaning(reason)}.`,
  };
}

/** One line per class of unresolved national hit present, as asOfCaveat does for EU hits. */
export function nationalAsOfCaveat(results: Obj[], asOf: string): Obj | undefined {
  const groups: Record<string, string[]> = { amendedSince: [], notInForce: [], datesUnknown: [], notAvailable: [], other: [] };
  for (const r of results) {
    if (r.asOfResolved === true) continue;
    const reason = typeof r.asOfReason === 'string' ? r.asOfReason : 'unknown';
    const id = `${String(r.law_id ?? r.documentId ?? '?')}${r.article_ref ? ` ${String(r.article_ref)}` : ''} (${reason})`;
    groups[Object.hasOwn(NATIONAL_AS_OF_GROUP, reason) ? NATIONAL_AS_OF_GROUP[reason] : 'other'].push(id);
  }
  const guidance: string[] = [];
  if (groups.amendedSince.length) guidance.push(`amendedSince: amended or added after ${asOf}; LexAPI cannot return the wording that applied on that date.`);
  if (groups.notInForce.length) guidance.push(`notInForce: no longer in force on ${asOf} — that is the answer for them.`);
  if (groups.datesUnknown.length) guidance.push(`datesUnknown: the dates of today's wording are unknown, so whether it applied on ${asOf} is not established.`);
  if (groups.notAvailable.length) guidance.push('notAvailable: LexAPI holds no per-provision dates for this country.');
  if (groups.other.length) guidance.push(`other: whether today's wording applied on ${asOf} was not established (see asOfReason).`);
  if (!guidance.length) return undefined;
  return compact({
    note: `Unresolved hits carry today's wording, which is not established as the text on ${asOf}. asOf never returns earlier wording.`,
    ...Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length)),
    guidance,
  });
}

/**
 * `requestedAsOf`: the asOf the tool sent. An API that does not label hits
 * (before LexAPI API 2.29.0) echoes no asOf; every hit is then labelled
 * unresolved, so no text reads as established for the date.
 */
export function shapeNationalLegislation(res: LexResponse<Json>, requestedAsOf?: string): Obj {
  const b = res.body;
  const echoed = label(b.asOf, 10);
  const asOf = echoed ?? requestedAsOf;
  const results = Array.isArray(b.results) ? b.results.map((r) => shapeNationalLegislationHit(r, asOf)) : [];
  return compact({
    jurisdiction: b.jurisdiction,
    asOf,
    asOfSummary: asOf && isObj(b.asOfSummary) ? compact({ unresolved: num(b.asOfSummary.unresolved) }) : undefined,
    resultCount: results.length,
    results,
    hint: b.hint,
    partial: b.partial,
    partialReason: b.partialReason,
    attribution: b.attribution,
    asOfCaveat: asOf ? nationalAsOfCaveat(results, asOf) : undefined,
    asOfNote: asOf && !echoed ? 'The API returned no asOf labels for these hits (LexAPI API 2.29.0 or later labels them).' : undefined,
  });
}

/** `provenance.sourceUrl` when it is an http(s) link; undefined otherwise. */
export function sourceUrlOf(provenance: unknown): string | undefined {
  if (!isObj(provenance)) return undefined;
  const u = provenance.sourceUrl;
  return typeof u === 'string' && u.length <= 2000 && /^https?:\/\/\S+$/.test(u) ? u : undefined;
}

export function stripEnvelope(body: unknown, drop: string[] = []): Obj {
  if (!isObj(body)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'success' || k === 'subscription' || k === 'usage' || k === 'credits' || drop.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
