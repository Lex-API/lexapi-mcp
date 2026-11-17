// The credit costs written in tool descriptions, compared with the API's
// operation weights. The weights are a checked-in copy
// (tests/fixtures/operation-weights.json: operation names and numbers);
// scripts/refresh-operation-weights.mjs rewrites it from the API's
// operation-weight module.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeError, LexAPIError } from '../src/errors.js';
import { runTool } from '../src/server.js';
import { tools } from '../src/tools.js';
import { clientWith, parseText } from './helpers.js';

interface Fixture { weights: Record<string, number>; corpusHit: number; cellarHit: number }
const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/operation-weights.json', import.meta.url)), 'utf8')) as Fixture;
const w = fx.weights;
const credits = (n: number) => `${n} credit${n === 1 ? '' : 's'}`;
const bySource = (live: number) => `${fx.corpusHit} / ${fx.cellarHit} / ${live} credits`;
const bySourceLong = (live: number) => `Cost: ${credits(fx.corpusHit)} from the corpus, ${fx.cellarHit} via the Publications Office, ${live} live`;

interface Expected {
  /** The API operations the tool's endpoint charges. */
  ops: string[];
  /** Also settles at the corpus / Publications Office price. */
  settles?: boolean;
  /** Text the description must contain, built from the weights. */
  says: string[];
}
const FREE: Expected = { ops: [], says: ['Free'] };

const EXPECTED: Record<string, Expected> = {
  lex_info: { ops: ['info'], says: [`Free (${w.info} credits)`] },
  lex_search: { ops: ['search_keyword'], says: [`Cost: ${credits(w.search_keyword)} per result page`] },
  lex_recent_documents: { ops: ['recent_documents'], says: [`Cost: ${credits(w.recent_documents)} per 10 results`, `for ${credits(w.recent_documents)}`] },
  lex_resolve: { ops: ['resolve'], says: [`Cost: ${credits(w.resolve)}.`] },
  lex_get_document: { ops: ['document_fetch'], settles: true, says: [bySourceLong(w.document_fetch)] },
  lex_get_documents_batch: { ops: ['document_batch'], settles: true, says: [`(${bySource(w.document_batch)})`] },
  lex_get_metadata: { ops: ['document_metadata'], settles: true, says: [bySourceLong(w.document_metadata)] },
  lex_get_document_by_url: { ops: ['document_url'], settles: true, says: [`Cost: ${bySource(w.document_url)}`] },
  lex_document_versions: { ops: ['document_versions'], says: [`Cost: ${credits(w.document_versions)}.`] },
  lex_get_document_version: { ops: ['document_version_fetch'], says: [`Cost: ${credits(w.document_version_fetch)}.`] },
  lex_semantic_legislation: { ops: ['semantic_legis', 'document_fetch'], says: [`Cost: ${credits(w.semantic_legis)}; with asOf, plus up to ${w.document_fetch} per in-force version fetched live`] },
  lex_semantic_case_law: { ops: ['semantic_case_law', 'semantic_case_law_hyde'], says: [`Cost: ${credits(w.semantic_case_law)}.`, `${credits(w.semantic_case_law_hyde)} instead of ${w.semantic_case_law}`, `refunded to ${w.semantic_case_law}`] },
  lex_national_coverage: FREE,
  lex_list_national_documents: { ops: ['national_documents_list'], says: [`Cost: ${credits(w.national_documents_list)} per call`] },
  // Reserved at the document weight, always settled at the corpus price.
  lex_get_national_document: { ops: [], settles: true, says: [`Cost: ${credits(fx.corpusHit)}.`] },
  lex_national_semantic_case_law: { ops: ['semantic_case_law'], says: [`Cost: ${credits(w.semantic_case_law)}.`] },
  lex_national_semantic_legislation: { ops: ['semantic_legis'], says: [`Cost: ${credits(w.semantic_legis)}.`] },
  lex_cited_by: { ops: ['citation_cited_by'], says: [`Cost: ${credits(w.citation_cited_by)}.`] },
  lex_cites: { ops: ['citation_cites'], says: [`Cost: ${credits(w.citation_cites)}.`] },
  lex_citation_network: { ops: ['citation_network', 'citation_cites', 'citation_cited_by'], says: [`Cost: ${credits(w.citation_network)}`, `one direction for ${credits(w.citation_cites)}`] },
  lex_citation_path: { ops: ['citation_path'], says: [`Cost: ${credits(w.citation_path)}.`] },
  lex_related: { ops: ['citation_related'], says: [`Cost: ${credits(w.citation_related)}.`] },
  lex_citation_stats: { ops: ['citation_stats'], says: [`Cost: ${credits(w.citation_stats)}.`] },
  lex_transposition: { ops: ['citation_transposition'], says: [`Cost: ${credits(w.citation_transposition)} per call or page`] },
  lex_counterparts: { ops: ['citation_counterparts'], says: [`Cost: ${credits(w.citation_counterparts)} per call or page`] },
  lex_extract_citations: { ops: ['citation_extract'], settles: true, says: [`Cost: ${credits(w.citation_extract)} (${fx.corpusHit} when already extracted)`] },
  lex_export: { ops: ['export_per_row'], says: [`Cost: ${credits(w.export_per_row)} per row returned, at least ${w.export_per_row} per call`] },
  lex_list_webhooks: FREE,
  lex_get_webhook: FREE,
  lex_create_webhook: FREE,
  lex_update_webhook: FREE,
  lex_delete_webhook: FREE,
  lex_test_webhook: FREE,
};

/** Every number written as a credit amount: "5 credits", "1 credit", "1 / 4 / 5 credits". */
function creditAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/((?:\d+\s*\/\s*)*\d+)\s+credits?\b/g)) {
    for (const n of m[1].split('/')) out.push(Number(n.trim()));
  }
  return out;
}

function descriptionsOf(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => descriptionsOf(s, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      else descriptionsOf(v, out);
    }
  }
  return out;
}

describe('credit costs in descriptions match the API operation weights', () => {
  it('the fixture holds operation names and numbers only', () => {
    expect(Object.keys(fx).sort()).toEqual(['cellarHit', 'corpusHit', 'weights']);
    for (const [k, v] of Object.entries(w)) {
      expect(k).toMatch(/^[a-z_]+$/);
      expect(Number.isInteger(v) && v >= 0, k).toBe(true);
    }
  });

  it('every tool has an expected cost, for operations the fixture knows', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const [name, e] of Object.entries(EXPECTED)) {
      for (const op of e.ops) expect(w[op], `${name}: ${op}`).toBeTypeOf('number');
    }
  });

  for (const tool of tools) {
    it(`${tool.name}`, () => {
      const e = EXPECTED[tool.name];
      for (const d of [tool.description, tool.readOnlyDescription ?? tool.description]) {
        for (const phrase of e.says) expect(d).toContain(phrase);
      }
      const allowed = new Set(e.ops.map((op) => w[op]));
      if (e.settles) { allowed.add(fx.corpusHit); allowed.add(fx.cellarHit); }
      const params = descriptionsOf(z.toJSONSchema(z.object(tool.inputSchema), { io: 'input' }));
      for (const text of [tool.description, ...params]) {
        for (const n of creditAmounts(text)) expect([...allowed], `"${text}"`).toContain(n);
      }
    });
  }
});

describe('credit costs outside the descriptions match the weights too', () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const run = async (name: string, args: Record<string, unknown>, reply: Parameters<typeof clientWith>[0]) => {
    const { client } = clientWith(reply);
    return runTool(byName[name], z.object(byName[name].inputSchema).parse(args), client);
  };
  const exhausted = (weight: number) => ({
    status: 402,
    body: { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted', details: { weight, available: 0 } } },
  });

  it('402 text: the cheap calls it names', () => {
    expect(w.resolve).toBe(w.citation_cites);
    expect(describeError(new LexAPIError(402, 'CREDITS_EXHAUSTED', 'x'))).toContain(`lex_resolve or lex_cites cost ${credits(w.resolve)}`);
  });

  it('402 on a national document read: what is reserved and what it settles at', async () => {
    const r = await run('lex_get_national_document', { jurisdiction: 'at', id: 'AT-NOR-1' }, () => exhausted(w.document_fetch));
    expect(r.content[0].text).toContain(`reserves ${credits(w.document_fetch)} and settles at ${fx.corpusHit}, so the pool must hold ${w.document_fetch}`);
  });

  it('lex_export: the 402 text and the billing line of a credit-plan result', async () => {
    const r = await run('lex_export', {}, () => exhausted(20));
    expect(r.content[0].text).toContain(`admitted for ${credits(w.export_per_row)} and then reserves ${credits(w.export_per_row)} per matching row`);
    const ok = await run('lex_export', {}, () => ({
      raw: [
        JSON.stringify({ _meta: { totalMatching: 1 } }),
        JSON.stringify({ celex: '32016R0679', title: 'GDPR' }),
        JSON.stringify({ _done: { written: 1, truncated: false, credits: { operation_weight: 1 } } }),
      ].join('\n'),
      headers: { 'content-type': 'application/x-ndjson' },
    }));
    expect(parseText(ok).billing).toContain(`${credits(w.export_per_row)} per row returned, at least ${w.export_per_row}`);
  });

  it('README credits column', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    const column: Record<string, string> = {};
    for (const line of readme.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length >= 5 && cells[1].startsWith('`lex_')) column[cells[1]] = cells[3];
    }
    const doc = `${fx.corpusHit} · ${fx.cellarHit} · ${w.document_fetch}`;
    expect(column).toEqual({
      '`lex_semantic_legislation`': `${w.semantic_legis} (+ up to ${w.document_fetch} per version fetch with \`asOf\`)`,
      '`lex_semantic_case_law`': `${w.semantic_case_law} (${w.semantic_case_law_hyde} with \`hyde\`)`,
      '`lex_search`': `${w.search_keyword} per page`,
      '`lex_recent_documents`': `${w.recent_documents} per 10 results`,
      '`lex_resolve`': `${w.resolve}`,
      '`lex_get_document`': `${fx.corpusHit} corpus · ${fx.cellarHit} Cellar · ${w.document_fetch} live`,
      '`lex_get_documents_batch`': 'per document, as above',
      '`lex_get_metadata`': doc,
      '`lex_get_document_by_url`': doc,
      '`lex_document_versions`': `${w.document_versions}`,
      '`lex_get_document_version`': `${w.document_version_fetch}`,
      '`lex_cited_by` · `lex_cites`': `${w.citation_cites}`,
      '`lex_citation_network`': `${w.citation_network}`,
      '`lex_citation_path`': `${w.citation_path}`,
      '`lex_related`': `${w.citation_related}`,
      '`lex_citation_stats`': `${w.citation_stats}`,
      '`lex_extract_citations`': `${w.citation_extract} (${fx.corpusHit} if already done)`,
      '`lex_transposition`': `${w.citation_transposition}`,
      '`lex_counterparts`': `${w.citation_counterparts}`,
      '`lex_export`': `${w.export_per_row} per row, at least ${w.export_per_row} per call`,
      '`lex_national_coverage`': 'free',
      '`lex_list_national_documents`': `${w.national_documents_list}`,
      '`lex_get_national_document`': `${fx.corpusHit}`,
      '`lex_national_semantic_case_law` · `lex_national_semantic_legislation`': `${w.semantic_case_law}`,
      '`lex_info`': 'free',
      '`lex_list_webhooks` · `lex_get_webhook`': 'free',
      '`lex_create_webhook` · `lex_update_webhook` · `lex_delete_webhook` · `lex_test_webhook`': 'free',
    });
  });
});
