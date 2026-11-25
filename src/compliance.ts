// lex_compliance_checklist: the sources for one compliance topic in one
// country, in one call — the EU acts the topic rests on, the measures the
// country notified for each, each act's recorded amendments, and the national
// provisions that match the topic. It follows the workflow rules
// (workflows.ts): every value comes from an API answer, a failed call is named
// with its reason, and nothing is assessed. Which acts and searches make up a
// topic is the only thing this file decides (TOPICS).

import { compact, isObj, shapeNationalLegislationHit, truncate } from './shape.js';
import { Calls, shown, type Failure } from './workflows.js';

import type { LexAPIClient } from './client.js';

type Obj = Record<string, unknown>;

export interface TopicAct {
  celex: string;
  /** Why the act belongs to the topic, in a few words. */
  role: string;
}

export interface Topic {
  title: string;
  acts: TopicAct[];
  /** Searches of the country's legislation, by country code; `default` is used for a country without its own list. */
  nationalQueries: Record<string, string[]> & { default: string[] };
}

/**
 * The topics. An act is listed because the topic's obligations rest on it;
 * a search, because the provisions it finds are the ones a review of the
 * topic reads. A country's own-language searches match its texts best;
 * the English ones are the fallback.
 */
export const TOPICS = {
  employment_contract: {
    title: 'Employment contracts',
    acts: [
      { celex: '32019L1152', role: 'transparent and predictable working conditions (written information on the employment relationship)' },
      { celex: '32003L0088', role: 'working time, breaks, rest periods, annual leave' },
      { celex: '31999L0070', role: 'fixed-term work' },
      { celex: '31997L0081', role: 'part-time work' },
      { celex: '32023L0970', role: 'pay transparency' },
    ],
    nationalQueries: {
      si: [
        'obvezne sestavine pogodbe o zaposlitvi',
        'sklenitev pogodbe o zaposlitvi za določen čas',
        'delovni čas, odmori, dnevni in tedenski počitek, letni dopust',
        'prepoved konkurence in konkurenčna klavzula',
        'odpoved pogodbe o zaposlitvi in odpovedni roki',
        'delo na domu',
      ],
      default: [
        'mandatory content of an employment contract',
        'fixed-term employment contract',
        'working time, breaks, rest periods and annual leave',
        'non-competition clause after employment ends',
        'termination of employment and notice periods',
        'remote work from home',
      ],
    },
  },
  gdpr: {
    title: 'Personal data protection (GDPR)',
    acts: [
      { celex: '32016R0679', role: 'General Data Protection Regulation' },
      { celex: '32002L0058', role: 'privacy in electronic communications (cookies, direct marketing)' },
    ],
    nationalQueries: {
      si: [
        'pooblaščena oseba za varstvo osebnih podatkov',
        'evidenca dejavnosti obdelave osebnih podatkov',
        'videonadzor delovnih prostorov',
        'obdelava osebnih podatkov zaposlenih pri delodajalcu',
        'biometrični ukrepi',
        'neposredno trženje in privolitev',
      ],
      default: [
        'data protection officer',
        'records of processing activities',
        'video surveillance of workplaces',
        'processing of employee personal data by the employer',
        'biometric data processing',
        'direct marketing and consent',
      ],
    },
  },
  nis2: {
    title: 'Cybersecurity (NIS2)',
    acts: [
      { celex: '32022L2555', role: 'NIS2 Directive' },
      { celex: '32024R2690', role: 'technical and methodological requirements of the risk-management measures (digital infrastructure and digital providers)' },
    ],
    nationalQueries: {
      si: [
        'bistveni in pomembni subjekti, za katere velja zakon o informacijski varnosti',
        'ukrepi za obvladovanje tveganj za kibernetsko varnost',
        'obveznost priglasitve incidentov',
        'odgovornost organov upravljanja za kibernetsko varnost',
        'registracija subjektov pri pristojnem organu',
        'globe za kršitve zakona o informacijski varnosti',
      ],
      default: [
        'essential and important entities within the scope of the cybersecurity law',
        'cybersecurity risk-management measures',
        'incident reporting obligations',
        'liability of management bodies for cybersecurity',
        'registration of entities with the competent authority',
        'fines for infringements of the cybersecurity law',
      ],
    },
  },
} as const satisfies Record<string, Topic>;

export type TopicName = keyof typeof TOPICS;
export const TOPIC_NAMES = Object.keys(TOPICS) as [TopicName, ...TopicName[]];

export interface ChecklistArgs {
  topic: TopicName;
  jurisdiction: string;
  focus?: string;
  amendments?: number;
}

const MEASURES_PER_ACT = 15;
const HITS_PER_SEARCH = 3;
const PROVISION_TEXT_CHARS = 1500;
const CONCURRENCY = 4;

/** What one call of the checklist reports in `sources`. */
interface Source { call: string; target: string; report: Obj }

export async function complianceChecklist(a: ChecklistArgs, client: LexAPIClient): Promise<Obj> {
  const topic: Topic = TOPICS[a.topic];
  const code = a.jurisdiction.toLowerCase();
  const calls = new Calls(client);
  const sources: Source[] = [];
  const amendmentsShown = a.amendments ?? 5;

  // Is the country live? One free call: a country that is not live costs nothing.
  let notLive: Failure | undefined;
  const cov = await calls.runList('jurisdictions', (c) => c.nationalCoverage());
  let attribution: unknown;
  if (cov.failure) {
    sources.push({ call: 'lex_national_coverage', target: code.toUpperCase(), report: { status: 'failed', ...shown(cov.failure) } });
  } else {
    const j = (cov.res.body.jurisdictions as unknown[]).filter(isObj).find((x) => String(x.code ?? '').toLowerCase() === code);
    if (!j) notLive = { reason: 'not_listed', error: `lex_national_coverage lists no country ${code.toUpperCase()}` };
    else if (j.live !== true) notLive = { reason: 'not_live', error: `${code.toUpperCase()} is listed by lex_national_coverage but not live` };
    else if (Array.isArray(j.sources)) attribution = j.sources.filter(isObj).map((s) => s.attribution).filter(Boolean);
  }

  const queries = [...(topic.nationalQueries[code] ?? topic.nationalQueries.default)];
  if (a.focus) queries.unshift(a.focus);
  const queryLanguage = topic.nationalQueries[code] ? 'national' : 'english_fallback';

  const acts: Obj[] = topic.acts.map((act) => ({ celex: act.celex, role: act.role }));
  const provisions = new Map<string, Obj>();

  type Job = () => Promise<void>;
  const jobs: Job[] = [];

  topic.acts.forEach((act, i) => {
    const out = acts[i];
    // Measures the country notified for the act.
    jobs.push(async () => {
      const src: Source = { call: 'lex_transposition', target: act.celex, report: {} };
      sources.push(src);
      if (notLive) { Object.assign(src.report, { status: 'not_run', reason: notLive.reason, error: notLive.error }); return; }
      const r = await calls.runList('jurisdictions', (c) => c.transposition(act.celex, { jurisdictions: [code] }));
      if (r.failure) { Object.assign(src.report, r.notRun ? { status: 'not_run', reason: r.failure.reason, error: r.failure.error } : { status: 'failed', ...shown(r.failure) }); return; }
      const b = r.res.body;
      if (isObj(b.document) && typeof b.document.title === 'string') out.title = b.document.title;
      const country = (b.jurisdictions as unknown[]).filter(isObj).find((x) => String(x.jurisdiction ?? '').toLowerCase() === code);
      const measures = (country && Array.isArray(country.measures) ? country.measures : []).filter(isObj);
      out.notifiedMeasures = {
        count: measures.length,
        shown: measures.slice(0, MEASURES_PER_ACT).map(measureOf),
        ...(measures.length > MEASURES_PER_ACT ? { more: `${measures.length - MEASURES_PER_ACT} more: lex_transposition lists all of them` } : {}),
      };
      if (isObj(b.source) && isObj(b.source.cellar) && b.source.cellar.attribution) out.notifiedMeasuresAttribution = b.source.cellar.attribution;
      Object.assign(src.report, { status: 'ok', measures: measures.length });
    });
    // Amendments, repeals and corrigenda the act has recorded.
    jobs.push(async () => {
      const src: Source = { call: 'lex_cited_by', target: act.celex, report: {} };
      sources.push(src);
      const r = await calls.runList('citedBy', (c) => c.citedBy(act.celex, { citationType: ['amendment', 'repeal', 'corrigendum'], limit: 100 }));
      if (r.failure) { Object.assign(src.report, r.notRun ? { status: 'not_run', reason: r.failure.reason, error: r.failure.error } : { status: 'failed', ...shown(r.failure) }); return; }
      const b = r.res.body;
      const edges = (b.citedBy as unknown[]).filter(isObj).map((e) => ({
        celex: e.celex ?? e.celexNumber,
        title: typeof e.title === 'string' ? truncate(e.title, 240) : undefined,
        types: e.types,
      })).filter((e) => typeof e.celex === 'string');
      const byType = (t: string) => edges.filter((e) => Array.isArray(e.types) && e.types.includes(t));
      // Newest first by the year in the CELEX number (the edges carry no date).
      const newest = (xs: Obj[]) => [...xs].sort((x, y) => String(y.celex).localeCompare(String(x.celex))).slice(0, amendmentsShown).map((e) => compact(e));
      const repealedBy = byType('repeal');
      out.recordedChanges = compact({
        amendments: { count: byType('amendment').length, newest: newest(byType('amendment')) },
        repealedBy: repealedBy.length ? newest(repealedBy) : undefined,
        corrigenda: byType('corrigendum').length,
        relationSync: isObj(b.relationSync) ? b.relationSync.status : undefined,
      });
      Object.assign(src.report, { status: 'ok', edges: edges.length });
    });
  });

  // The country's provisions that match the topic.
  for (const query of queries) {
    jobs.push(async () => {
      const src: Source = { call: 'lex_national_semantic_legislation', target: `${code.toUpperCase()}: ${query}`, report: {} };
      sources.push(src);
      if (notLive) { Object.assign(src.report, { status: 'not_run', reason: notLive.reason, error: notLive.error }); return; }
      const r = await calls.runList('results', (c) => c.nationalSemanticLegislation(code, { query, limit: HITS_PER_SEARCH, include: ['text'] }));
      if (r.failure) { Object.assign(src.report, r.notRun ? { status: 'not_run', reason: r.failure.reason, error: r.failure.error } : { status: 'failed', ...shown(r.failure) }); return; }
      const rows = (r.res.body.results as unknown[]).filter(isObj);
      for (const row of rows) {
        const h = shapeNationalLegislationHit(row);
        const key = `${String(h.documentId ?? h.law_id)}#${String(h.article_ref ?? '')}`;
        const seen = provisions.get(key);
        if (seen) { (seen.matchedQueries as string[]).push(query); continue; }
        const text = typeof h.text === 'string' ? h.text : typeof h.snippet === 'string' ? h.snippet : undefined;
        provisions.set(key, compact({
          documentId: h.documentId ?? h.law_id,
          act: h.law_title,
          article: h.article_ref,
          inForce: typeof h.in_force === 'boolean' ? h.in_force : 'unknown',
          score: h.score,
          text: text ? truncate(text, PROVISION_TEXT_CHARS) : undefined,
          textTruncated: text && text.length > PROVISION_TEXT_CHARS ? true : undefined,
          matchedQueries: [query],
        }));
      }
      Object.assign(src.report, compact({ status: 'ok', hits: rows.length, partial: r.res.body.partial }));
    });
  }

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));

  const ok = sources.filter((s) => s.report.status === 'ok').length;
  if (!ok && calls.stopped?.cause) throw calls.stopped.cause;

  const nationalProvisions = [...provisions.values()].sort((x, y) => Number(y.score ?? 0) - Number(x.score ?? 0));
  return compact({
    topic: a.topic,
    topicTitle: topic.title,
    jurisdiction: code.toUpperCase(),
    euActs: acts,
    nationalProvisions,
    nationalSearch: { queries, queryLanguage },
    nationalAttribution: attribution,
    calls: { requested: sources.length, ok },
    incomplete: ok < sources.length ? true : undefined,
    sources: sources.map((s) => ({ call: s.call, target: s.target, ...s.report })),
    stopped: calls.stopped ? { reason: calls.stopped.reason, error: calls.stopped.error } : undefined,
    notes: [
      'Notified measures are the ones the member state notified to the Commission for the act; a notification is not a finding that the measure transposes the act, or does so completely, and a list can include acts that touch the topic only marginally.',
      'National provisions are the indexed consolidated wording of today; consolidated national texts are not authentic — only the official gazette is. inForce "unknown" means no status was reported.',
      'recordedChanges lists the amending, repealing and correcting acts LexAPI has recorded for each EU act, newest CELEX first; it does not say which provisions they changed.',
      'This is a set of sources selected for the topic, not an assessment of whether anyone complies; the list of acts and searches is LexAPI\'s selection and is not exhaustive.',
    ],
    ...calls.footer(),
  });
}

function measureOf(m: Obj): Obj {
  const oj = isObj(m.officialJournal) ? m.officialJournal : {};
  const cellar = isObj(m.cellar) ? m.cellar : {};
  return compact({
    id: m.id,
    title: m.title,
    officialJournal: [oj.name, oj.number].filter(Boolean).join(' ') || undefined,
    date: oj.date ?? cellar.dateDocument,
    notified: cellar.dateNotification,
    link: m.link,
  });
}

