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

function truncate(s: string | undefined, max: number): string | undefined {
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

// ── National-law allowance (lex-api PR #306) ────────────────────────
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
    consolidatedNote: `Consolidated text (the act with its amendments integrated, as of ${c.date}) — a documentation tool, not the authentic text. Cite the act as published in the Official Journal (${c.base}) and its amending acts.`,
  };
}

// ── Document metadata ──────────────────────────────────────────────
const META_KEYS = [
  'title', 'titleLanguage', 'documentType', 'documentTypeCode', 'author',
  'dateOfDocumentISO', 'dateOfEffectISO', 'dateOfPublicationISO', 'dateType',
  'ecli', 'eli', 'caseNumber', 'parties', 'subject',
  'language', 'languageRequested', 'languageFallback', 'version', 'fetchedAt',
  'latestConsolidated', 'upcomingConsolidated', 'newestConsolidated',
] as const;

export function shapeMetadata(doc: Obj, headers: LexResponse['headers'] = {}): Obj {
  const out: Obj = { celex: str(doc.celex) ?? str(doc.celexNumber) };
  for (const k of META_KEYS) out[k] = doc[k];
  // Legacy DD/MM/YYYY strings only when no ISO twin exists.
  if (!doc.dateOfDocumentISO && doc.dateOfDocument) out.dateOfDocument = doc.dateOfDocument;
  if (Array.isArray(doc.keywords)) out.keywords = (doc.keywords as unknown[]).slice(0, 20);
  const urls = isObj(doc.urls) ? doc.urls : undefined;
  if (urls) out.url = urls.html ?? urls.metadata;
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
function readingHint(content: Obj): string {
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
      note: [`Outline only: the body is ${totalSize} characters (budget maxChars=${opts.maxChars}).`, note, readingHint(content)].filter(Boolean).join(' '),
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
    // Consolidated-text labelling (#284 §6) — kept verbatim.
    consolidated: r.consolidated,
    consolidatedAsOf: r.consolidatedAsOf,
    baseCelex: r.baseCelex,
    consolidatedNote: r.consolidatedNote,
    baseAct: isObj(r.baseAct) ? compact({ ...r.baseAct, score: round3(r.baseAct.score) }) : undefined,
    // asOf resolution (#284 §7).
    asOf: r.asOf,
    asOfResolved: r.asOfResolved,
    asOfReason: r.asOfReason,
    asOfVersion: r.asOfVersion,
    matchedVersion: r.matchedVersion,
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
      ? 'Some hits are consolidated texts (consolidated: true, or asOfVersion.kind "consolidated"): they are documentation tools without legal force. Quote them for reading, but cite the authentic act (baseCelex / baseAct.law_id) as published in the Official Journal, plus the amending acts where relevant.'
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

/**
 * One instruction per class of unresolved hit present. Every unresolved
 * hit carries the LATEST text; what the model should do differs:
 *   - not in force on the date → that IS the answer (say so);
 *   - transient → retry shortly, or with a smaller limit;
 *   - credits → tell the user;
 *   - anything else (no text in that version, language, article missing…) →
 *     the version in force could not be read; don't quote it as of that date.
 */
export function asOfCaveat(results: Obj[], asOf: string): Obj | undefined {
  const groups: Record<string, string[]> = { notInForce: [], retryable: [], needsCredits: [], unavailable: [] };
  for (const r of results) {
    if (r.asOfResolved !== false) continue;
    const reason = String(r.asOfReason ?? 'unknown');
    const id = `${String(r.law_id ?? '?')}${r.article_ref ? ` ${String(r.article_ref)}` : ''} (${reason})`;
    if (AS_OF_NOT_IN_FORCE.has(reason)) groups.notInForce.push(id);
    else if (AS_OF_RETRYABLE.has(reason)) groups.retryable.push(id);
    else if (AS_OF_USER_ACTION.has(reason)) groups.needsCredits.push(id);
    else groups.unavailable.push(id);
  }
  const guidance: string[] = [];
  if (groups.notInForce.length) guidance.push(`notInForce: these acts were not in force on ${asOf} (not yet adopted / not yet in force / no longer in force) — that is the answer for them; say so, and do not quote their text as the law on that date.`);
  if (groups.retryable.length) guidance.push('retryable: the version in force could not be fetched in this call (busy, time or fetch limits) — call again shortly, or with a smaller limit.');
  if (groups.needsCredits.length) guidance.push('needsCredits: the credit pool could not cover fetching the version in force — tell the user.');
  if (groups.unavailable.length) guidance.push(`unavailable: the version in force on ${asOf} could not be read (see asOfReason) — do not present the returned text as the law on that date.`);
  if (!guidance.length) return undefined;
  return compact({
    note: `Unresolved hits carry the LATEST text, not the text in force on ${asOf}.`,
    ...Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length)),
    guidance,
  });
}

// ── Citations ──────────────────────────────────────────────────────
function shapeEdgeGroup(g: unknown): Obj {
  if (!isObj(g)) return {};
  const edges = Array.isArray(g.citations) ? g.citations : [];
  const types = [...new Set(edges.map((e) => (isObj(e) ? e.citationType : undefined)).filter(Boolean))];
  const snippet = edges.map((e) => (isObj(e) ? str(e.contextSnippet) : undefined)).find(Boolean);
  return compact({
    celex: g.celexNumber,
    title: g.title,
    types,
    count: g.citationCount,
    context: truncate(snippet, 240),
  });
}

export function shapeCitedBy(res: LexResponse<Json>): Obj {
  const b = res.body;
  return compact({
    target: b.targetDocument,
    totalCitations: b.totalCitations,
    limit: b.limit,
    offset: b.offset,
    citedBy: Array.isArray(b.citedBy) ? b.citedBy.map(shapeEdgeGroup) : [],
    relationSync: b.relationSync,
  });
}

export function shapeCites(res: LexResponse<Json>): Obj {
  const b = res.body;
  return compact({
    source: b.sourceDocument,
    totalCitations: b.totalCitations,
    limit: b.limit,
    offset: b.offset,
    cites: Array.isArray(b.cites) ? b.cites.map(shapeEdgeGroup) : [],
  });
}

function shapeNeighbour(n: unknown): Obj {
  if (!isObj(n)) return {};
  return compact({ celex: n.celexNumber, title: n.title, types: n.types, count: n.count });
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
  });
}

// ── National law (lex-api PR #306, launching 2026-11-03) ────────────
// National documents key on `id` (not `celex`) and always carry
// `attribution` (per-source licence/attribution text) — never dropped by
// compacting, since it is the legally required attribution for the source.

export function shapeNationalSearchResult(r: unknown): Obj {
  if (!isObj(r)) return {};
  return compact({
    id: r.id,
    jurisdiction: r.jurisdiction,
    language: r.language,
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

/** A full national document (from GET /{jur}/documents/{id}). */
export function shapeNationalDocument(doc: unknown, opts: ContentOptions): Obj {
  if (!isObj(doc)) return {};
  // `compact` drops `null` values — build the metadata fields through it
  // first, then set `content: null` (when that's the case) on the result
  // directly, never through another `compact` call, or the "no text" signal
  // would be lost (same pitfall shapeDocument's content:null branch avoids).
  const out: Obj = compact({
    id: doc.id,
    jurisdiction: doc.jurisdiction,
    language: doc.language,
    title: doc.title,
    documentType: doc.documentType,
    ecli: doc.ecli,
    eli: doc.eli,
    dateOfDocument: doc.dateOfDocument,
    version: doc.version,
    fetchedAt: doc.fetchedAt,
    validTo: doc.validTo,
    inForce: doc.inForce,
    textBasis: doc.textBasis,
    // Required legal attribution for the source (RIS, gesetze-im-internet.de,
    // Normattiva, Légifrance/Judilibre, the Rechtspraak open data, …): always
    // kept, never dropped by compacting elsewhere.
    attribution: doc.attribution,
  });
  // A text-availability block that just says "available" is noise (mirrors
  // shapeMetadata); any other state (no text, why, which languages) is kept.
  const ta = doc.textAvailability;
  if (isObj(ta) && !(ta.available === true && Object.keys(ta).length === 1)) out.textAvailability = ta;
  if (doc.content === null) {
    out.content = null; // no text published — textAvailability says why
    return out;
  }
  const { content, note } = shapeContent(doc.content, opts);
  if (content) out.content = content;
  if (note) out.note = note;
  return out;
}

export function shapeNationalCaseLawHit(r: unknown): Obj {
  if (!isObj(r)) return {};
  const md = isObj(r.metadata) ? r.metadata : {};
  const out: Obj = {
    documentId: r.documentId ?? md.celex_id,
    jurisdiction: r.jurisdiction,
    score: round3(r.score),
    case_name: r.case_name,
    case_number: r.case_number,
    ecli: r.ecli,
    court: r.court,
    decision_date: r.decision_date,
    parties: r.parties,
    language: r.language && r.language !== 'en' ? r.language : undefined,
    summary: r.summary,
    snippet: r.summary ? undefined : r.snippet,
    text: r.text,
    validTo: r.validTo,
    inForce: r.inForce,
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
    // The national index never rewrites (clausly answers hyde:false) — the
    // request's hyde was accepted but did not cost the HyDE premium.
    hyde: b.hyde,
    attribution: b.attribution,
  });
}

export function shapeNationalLegislationHit(r: unknown): Obj {
  if (!isObj(r)) return {};
  return compact({
    law_id: r.law_id,
    documentId: r.documentId,
    jurisdiction: r.jurisdiction,
    law_title: r.law_title,
    article_ref: r.article_ref,
    section: r.section,
    chapter: r.chapter,
    score: round3(r.score),
    language: r.language,
    snippet: r.snippet,
    text: r.text,
    // Our row's confirmed-repeal override, when it fired (snake_case —
    // mirrors the server's own field names on this endpoint only).
    in_force: r.in_force,
    valid_to: r.valid_to,
    // Required legal attribution for the source — always kept.
    attribution: r.attribution,
  });
}

export function shapeNationalLegislation(res: LexResponse<Json>): Obj {
  const b = res.body;
  const results = Array.isArray(b.results) ? b.results.map(shapeNationalLegislationHit) : [];
  return compact({
    jurisdiction: b.jurisdiction,
    resultCount: results.length,
    results,
    hint: b.hint,
    attribution: b.attribution,
  });
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
