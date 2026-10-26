import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runTool } from '../src/server.js';
import { selectTools, tools, type ToolDef } from '../src/tools.js';
import { clientWith, fakeDocument, parseText } from './helpers.js';

const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;

/** Validate args the way the MCP SDK does (defaults applied), then run. */
async function call(name: string, args: Record<string, unknown>, reply: Parameters<typeof clientWith>[0]) {
  const tool = byName[name];
  const parsed = z.object(tool.inputSchema).parse(args);
  const { client, calls } = clientWith(reply);
  const result = await runTool(tool, parsed, client);
  return { result, calls, data: result.isError ? undefined : parseText(result) };
}

describe('tool catalogue', () => {
  it('keeps every v0.2 tool name (renames break user prompts and configs)', () => {
    for (const name of [
      'lex_search', 'lex_get_document', 'lex_get_metadata', 'lex_get_document_by_url', 'lex_recent_documents',
      'lex_cited_by', 'lex_cites', 'lex_citation_network', 'lex_semantic_case_law', 'lex_semantic_legislation',
    ]) expect(byName[name], name).toBeDefined();
  });

  it('covers every public endpoint', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'lex_citation_network', 'lex_citation_path', 'lex_citation_stats', 'lex_cited_by', 'lex_cites',
      'lex_create_webhook', 'lex_delete_webhook', 'lex_document_versions', 'lex_export', 'lex_extract_citations',
      'lex_get_document', 'lex_get_document_by_url', 'lex_get_document_version', 'lex_get_documents_batch',
      'lex_get_metadata', 'lex_get_webhook', 'lex_info', 'lex_list_webhooks', 'lex_recent_documents', 'lex_related',
      'lex_resolve', 'lex_search', 'lex_semantic_case_law', 'lex_semantic_legislation', 'lex_test_webhook',
      'lex_update_webhook',
    ]);
  });

  it('read-only mode hides only account-changing tools', () => {
    const ro = selectTools({ readOnly: true }).map((t) => t.name);
    expect(ro).not.toContain('lex_create_webhook');
    expect(ro).not.toContain('lex_update_webhook');
    expect(ro).not.toContain('lex_delete_webhook');
    expect(ro).not.toContain('lex_test_webhook');
    expect(ro).not.toContain('lex_extract_citations'); // N8: writes to the shared graph
    expect(ro).toContain('lex_list_webhooks');
    expect(ro).toHaveLength(tools.length - 5);
  });

  it('annotates writes honestly', () => {
    for (const t of tools) {
      if (t.write) expect(t.annotations.readOnlyHint, t.name).toBe(false);
      expect(t.annotations.openWorldHint).toBe(true);
    }
    expect(byName.lex_delete_webhook.annotations.destructiveHint).toBe(true);
  });

  it('every description states its cost or that it is free (N7: including webhook writes)', () => {
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/[Cc]ost|[Ff]ree/);
    }
  });
});

describe('input validation', () => {
  const ok = (name: string, args: unknown) => z.object(byName[name].inputSchema).safeParse(args).success;

  it('accepts consolidated, corrigendum and lower-case CELEX numbers (v0.2 rejected the first two)', () => {
    expect(ok('lex_get_document', { celexNumber: '02016R0679-20180524' })).toBe(true);
    expect(ok('lex_get_document', { celexNumber: '32013R0952R(04)' })).toBe(true);
    expect(ok('lex_get_document', { celexNumber: '32016r0679' })).toBe(true);
    expect(ok('lex_get_document', { celexNumber: 'CELEX:32016R0679' })).toBe(true);
    expect(ok('lex_get_document', { celexNumber: 'GDPR!' })).toBe(false);
  });

  it('validates asOf as a date', () => {
    expect(ok('lex_semantic_legislation', { query: 'own funds', asOf: '2019-06-01' })).toBe(true);
    expect(ok('lex_semantic_legislation', { query: 'own funds', asOf: '1 June 2019' })).toBe(false);
  });

  it('rejects removed / unknown enum values', () => {
    expect(ok('lex_search', { documentType: 'opinion-act' })).toBe(false); // removed from the API
    expect(ok('lex_search', { documentType: ['staff-working-document', 'judgment'] })).toBe(true);
    expect(ok('lex_cited_by', { celexNumber: '32008R1272', citationType: 'corrigendum' })).toBe(true);
    expect(ok('lex_semantic_case_law', { query: 'abc', language: 'hu' })).toBe(false); // not in the semantic index
  });
});

describe('lex_search', () => {
  it('forwards the filters and shapes hits compactly', async () => {
    const { calls, data } = await call('lex_search', { query: 'artificial intelligence', documentType: ['regulation'], procedure: 'ordinary', month: 3, year: 2024 }, () => ({
      body: {
        searchParameters: {},
        totalResults: 12,
        totalPages: 2,
        pagesFetched: 1,
        resultCount: 1,
        results: [{
          celexNumber: '32024R1689', celex: '32024R1689', title: 'Regulation (EU) 2024/1689 …', form: 'Regulation',
          documentType: 'Regulation', documentTypeCode: 'regulation', date: '2024-06-13', dateOfDocumentISO: '2024-06-13',
          author: 'European Parliament, Council', availableLanguages: Array(24).fill('XX'), url: 'https://eur-lex.europa.eu/x',
        }],
        subscription: { tier: 'FREE' },
        usage: { current: 3 },
        credits: { remaining: 497, limit: 500 },
        fetchedAt: '2026-10-26T10:00:00.000Z',
      },
      headers: { 'x-search-source': 'soap', 'x-search-cache': 'miss' },
    }));
    expect(calls[0].body).toEqual({ query: 'artificial intelligence', documentType: ['regulation'], procedure: 'ordinary', month: 3, year: 2024, maxPages: 1 });
    expect(data.results[0]).toEqual({
      celex: '32024R1689', title: 'Regulation (EU) 2024/1689 …', type: 'regulation', date: '2024-06-13',
      author: 'European Parliament, Council', url: 'https://eur-lex.europa.eu/x',
    });
    expect(data.source).toBe('soap');
    expect(data).not.toHaveProperty('subscription');
    expect(data).not.toHaveProperty('usage');
    expect(data).not.toHaveProperty('notice');
  });

  it('passes the zero-result hint and adds a low-credit notice', async () => {
    const { data } = await call('lex_search', { query: 'x y z' }, () => ({
      body: { totalResults: 0, results: [], hint: 'No results. EUR-Lex keyword search is literal …', credits: { remaining: 12, limit: 500, resetsAt: '2026-11-01T00:00:00.000Z' } },
    }));
    expect(data.hint).toMatch(/literal/);
    expect(data.notice).toBe('LexAPI credit pool is low: 12 of 500 credits left (resets 2026-11-01T00:00:00.000Z).');
  });
});

describe('lex_get_document', () => {
  it('normalises the CELEX and passes language / acceptLanguages', async () => {
    const { calls } = await call('lex_get_document', { celexNumber: 'celex:62019tj0001', language: 'de', acceptLanguages: ['fr'] }, () => ({ body: { success: true, document: fakeDocument() } }));
    expect(calls[0].body).toEqual({ celexNumber: '62019TJ0001', language: 'de', acceptLanguages: ['fr'] });
  });

  it('articleId alone asks the API for metadata + that article only', async () => {
    const { calls, data } = await call('lex_get_document', { celexNumber: '32016R0679', articleId: '17' }, () => ({
      body: { success: true, document: fakeDocument(1) },
    }));
    expect(calls[0].body).toEqual({ celexNumber: '32016R0679', articleId: '17', include: ['metadata', 'articles'] });
    expect(data.content.articles).toHaveLength(1);
  });

  it('says so when articleId matched nothing (the API answers articles: [])', async () => {
    const { data } = await call('lex_get_document', { celexNumber: '32016R0679', articleId: '999' }, () => ({
      body: { success: true, document: { ...fakeDocument(0), content: { articles: [] } } },
    }));
    expect(data.note).toMatch(/No article matched articleId "999"/);
  });

  it('returns a small document whole, without the duplicate fullText', async () => {
    const { data } = await call('lex_get_document', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, document: fakeDocument(3, 100) },
      headers: { 'x-source': 'corpus' },
    }));
    expect(data.celex).toBe('32016R0679');
    expect(data.source).toBe('corpus');
    expect(data.url).toMatch(/TXT\/HTML/);
    expect(data.content.articles).toHaveLength(3);
    expect(data.content.recitals).toHaveLength(1);
    expect(data.content).not.toHaveProperty('fullText');
    expect(data).not.toHaveProperty('textAvailability'); // {available:true} is noise
    expect(data).not.toHaveProperty('celexNumber');
    expect(data).not.toHaveProperty('dateOfDocument'); // ISO twin present
  });

  it('outlines a large document and says how to read it', async () => {
    const { data } = await call('lex_get_document', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, document: fakeDocument(99, 2000) },
    }));
    expect(data.content.articles).toHaveLength(99);
    expect(data.content.articles[0]).toEqual({ id: 'art_1', number: 'Article 1', title: 'Title 1' });
    expect(data.content.sections[0]).toMatchObject({ number: 'I', articles: 'art_1–art_99' });
    expect(data.note).toMatch(/Outline only/);
    expect(data.note).toMatch(/articleId/);
  });

  it('view "full" truncates at maxChars and gives the offset to continue', async () => {
    const reply = () => ({ body: { success: true, document: fakeDocument(10, 3000) } });
    const first = await call('lex_get_document', { celexNumber: '32016R0679', view: 'full', maxChars: 10000 }, reply);
    expect(first.data.content.articles.length).toBeLessThan(10);
    const m = /offset=(\d+)/.exec(first.data.note);
    expect(m).not.toBeNull();
    const second = await call('lex_get_document', { celexNumber: '32016R0679', view: 'full', maxChars: 10000, offset: Number(m![1]) }, reply);
    expect(second.data.content.articles[0].id).toBe(`art_${first.data.content.articles.length + 1}`);
  });

  it('include ["metadata"] returns no body', async () => {
    const { calls, data } = await call('lex_get_document', { celexNumber: '32016R0679', include: ['metadata'] }, () => ({
      body: { success: true, document: { ...fakeDocument(), content: undefined } },
    }));
    expect(calls[0].body).toMatchObject({ include: ['metadata'] });
    expect(data).not.toHaveProperty('content');
  });

  it('keeps textAvailability and the consolidated pointer when there is no text', async () => {
    const ta = {
      available: false, reason: 'too_large', retryable: false, availableLanguages: null, source: 'parse-worker',
      latestConsolidated: { celex: '02008R1272-20260701', date: '2026-07-01', source: 'cellar' },
    };
    const { data } = await call('lex_get_document', { celexNumber: '32008R1272' }, () => ({
      body: { success: true, document: { ...fakeDocument(), celex: '32008R1272', content: null, textAvailability: ta } },
    }));
    expect(data.content).toBeNull();
    expect(data.textAvailability).toEqual(ta); // verbatim: null languages ≠ []
  });

  it('labels a consolidated CELEX and names the authentic act', async () => {
    const { data } = await call('lex_get_document', { celexNumber: '02016R0679-20160504' }, () => ({
      body: { success: true, document: fakeDocument(2, 50, { celex: '02016R0679-20160504' }) },
    }));
    expect(data.consolidated).toBe(true);
    expect(data.baseCelex).toBe('32016R0679');
    expect(data.consolidatedAsOf).toBe('2016-05-04');
    expect(data.consolidatedNote).toMatch(/not the authentic text/);
  });

  it('surfaces the language fallback labels', async () => {
    const { data } = await call('lex_get_document', { celexNumber: '62019TJ0001', language: 'en', acceptLanguages: 'any' }, () => ({
      body: { success: true, document: fakeDocument(1, 10, { language: 'fr', languageRequested: 'en', languageFallback: 'fr', titleLanguage: 'fr' }) },
    }));
    expect(data).toMatchObject({ language: 'fr', languageRequested: 'en', languageFallback: 'fr', titleLanguage: 'fr' });
  });
});

describe('lex_get_documents_batch / lex_get_metadata / lex_get_document_by_url', () => {
  it('B1: batch + articleId returns the article text, not an outline', async () => {
    const { data } = await call('lex_get_documents_batch', { celexNumbers: ['32016R0679', '32018R1725'], articleId: '5' }, () => ({
      body: { success: true, requested: 2, processed: 2, successful: 2, failed: 0, documents: [fakeDocument(1, 3000), fakeDocument(1, 3000, { celex: '32018R1725' })], errors: [] },
    }));
    for (const d of data.documents) {
      expect(d.content.articles[0].content).toMatch(/^x+/);
      expect(d.note ?? '').not.toMatch(/Outline only/);
    }
  });

  it('B1: batch + include returns those parts', async () => {
    const { data } = await call('lex_get_documents_batch', { celexNumbers: ['32016R0679'], include: ['articles'] }, () => ({
      body: { success: true, documents: [fakeDocument(3, 100)], errors: [] },
    }));
    expect(data.documents[0].content.articles[0]).toHaveProperty('content');
  });

  it('N6: batch output stays within the shared maxChars budget', async () => {
    const docs = Array.from({ length: 40 }, (_, i) => fakeDocument(20, 2000, { celex: `3201${i}R0001` }));
    const { data } = await call('lex_get_documents_batch', { celexNumbers: docs.map((d) => d.celex), include: ['articles'], maxChars: 20_000 }, () => ({
      body: { success: true, documents: docs, errors: [] },
    }));
    const bodyChars = data.documents.reduce((n: number, d: any) => n + JSON.stringify(d.content ?? {}).length, 0);
    expect(bodyChars).toBeLessThan(20_000 * 1.6); // JSON overhead aside, no 2,000-char floor × 40
  });


  it('batch: normalises CELEX numbers, outlines by default, keeps errors', async () => {
    const { calls, data } = await call('lex_get_documents_batch', { celexNumbers: ['32016r0679', '62018CJ0311'] }, () => ({
      body: {
        success: true, requested: 2, processed: 2, successful: 1, failed: 1, textUnavailable: 0,
        documents: [fakeDocument(2)],
        errors: [{ celexNumber: '62018CJ0311', error: 'TIMEOUT', message: 'timed out' }],
      },
    }));
    expect(calls[0].body).toEqual({ celexNumbers: ['32016R0679', '62018CJ0311'] });
    expect(data.documents[0].content.articles[0]).not.toHaveProperty('content');
    expect(data.errors).toHaveLength(1);
  });

  it('metadata: compact, with the source', async () => {
    const { calls, data } = await call('lex_get_metadata', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, metadata: { ...fakeDocument(), content: undefined } },
      headers: { 'x-source': 'cellar' },
    }));
    expect(calls[0].url.pathname).toBe('/api/v1/documents/metadata');
    expect(data).toMatchObject({ celex: '32016R0679', source: 'cellar', documentType: 'Regulation' });
    expect(data).not.toHaveProperty('content');
  });

  it('by URL: forwards selection and echoes the extracted CELEX', async () => {
    const url = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679';
    const { calls, data } = await call('lex_get_document_by_url', { url, articleId: '5' }, () => ({
      body: { success: true, sourceUrl: url, extractedCelex: '32016R0679', document: fakeDocument(1) },
    }));
    expect(calls[0].body).toEqual({ url, articleId: '5', include: ['metadata', 'articles'] });
    expect(data.extractedCelex).toBe('32016R0679');
  });
});

describe('lex_recent_documents', () => {
  it('sends query parameters with the cheaper default limit', async () => {
    const { calls, data } = await call('lex_recent_documents', { days: 3, documentType: 'judgment' }, () => ({
      body: { success: true, parameters: { dateFrom: '2026-10-23', dateTo: '2026-10-26' }, totalResults: 1, results: [{ celex: '62024CJ0001', title: 't' }] },
      headers: { 'x-source': 'live' },
    }));
    expect(calls[0].method).toBe('GET');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ days: '3', documentType: 'judgment', limit: '20' });
    expect(data.window).toBe('2026-10-23..2026-10-26');
    expect(data.source).toBe('live');
  });
});

describe('lex_semantic_legislation', () => {
  const consolidatedHit = {
    id: 'u1', law_id: '02013R0575-20190627', law_title: 'CRR (consolidated)', article_ref: 'art_92', language: 'en',
    score: 0.81234, snippet: 'Own funds requirements …', exact_match_law_id: false,
    consolidated: true, consolidatedAsOf: '2019-06-27', baseCelex: '32013R0575',
    consolidatedNote: 'The act as amended, consolidated as of 2019-06-27; not the authentic text. Only the act as published in the Official Journal is authentic (32013R0575).',
    baseAct: { law_id: '32013R0575', article_ref: 'art_92', score: 0.8 },
    asOf: '2019-06-01', asOfResolved: true, asOfVersion: { celex: '02013R0575-20190627', date: '2019-06-27', kind: 'consolidated' },
    metadata: { opaque: true },
  };

  it('sends asOf and the other parameters; keeps consolidated + asOf labels; adds citing guidance', async () => {
    const { calls, data } = await call('lex_semantic_legislation', { query: 'own funds requirements', asOf: '2019-06-01', language: 'en', min_score: 0.5 }, () => ({
      body: {
        success: true, searchType: 'semantic-legislation', query: 'own funds requirements', resultCount: 1,
        results: [consolidatedHit], metadata: { x: 1 }, tookMs: 900, asOf: '2019-06-01',
        asOfSummary: { liveFetches: 1, unresolved: 0 }, subscription: { tier: 'STARTER', maxResults: 20 },
      },
    }));
    expect(calls[0].url.pathname).toBe('/api/v1/legislation/semantic');
    expect(calls[0].body).toEqual({ query: 'own funds requirements', asOf: '2019-06-01', limit: 10, min_score: 0.5, language: 'en' });
    const hit = data.results[0];
    expect(hit).toMatchObject({
      law_id: '02013R0575-20190627', article_ref: 'art_92', score: 0.812, consolidated: true, consolidatedAsOf: '2019-06-27',
      baseCelex: '32013R0575', baseAct: { law_id: '32013R0575', article_ref: 'art_92', score: 0.8 },
      asOfResolved: true, asOfVersion: { kind: 'consolidated' },
    });
    expect(hit.consolidatedNote).toMatch(/not the authentic text/);
    expect(hit).not.toHaveProperty('id');
    expect(hit).not.toHaveProperty('metadata');
    expect(data.asOf).toBe('2019-06-01');
    expect(data.asOfSummary).toEqual({ liveFetches: 1, unresolved: 0 });
    expect(data.citing).toMatch(/cite the authentic act/);
    expect(data).not.toHaveProperty('asOfCaveat');
  });

  it('S2: groups unresolved hits by reason class with per-class guidance', async () => {
    const hit = (law_id: string, asOfReason: string) => ({ law_id, article_ref: 'art_1', score: 0.7, asOf: '2019-06-01', asOfResolved: false, asOfReason });
    const { data } = await call('lex_semantic_legislation', { query: 'x', asOf: '2019-06-01' }, () => ({
      body: {
        success: true, asOf: '2019-06-01', asOfSummary: { liveFetches: 1, unresolved: 4 },
        results: [
          hit('32024R1689', 'not_yet_adopted'),
          hit('32013R0575', 'fetch_pending'),
          hit('32016R0679', 'insufficient_credits'),
          hit('32006R1907', 'article_not_in_version'),
          { law_id: '32019R0001', article_ref: 'art_2', score: 0.8, asOf: '2019-06-01', asOfResolved: true },
        ],
      },
    }));
    const c = data.asOfCaveat;
    expect(c.notInForce).toEqual(['32024R1689 art_1 (not_yet_adopted)']);
    expect(c.retryable).toEqual(['32013R0575 art_1 (fetch_pending)']);
    expect(c.needsCredits).toEqual(['32016R0679 art_1 (insufficient_credits)']);
    expect(c.unavailable).toEqual(['32006R1907 art_1 (article_not_in_version)']);
    expect(c.guidance.join(' ')).toMatch(/not in force on 2019-06-01.*that is the answer/);
    expect(c.guidance.join(' ')).toMatch(/call again shortly/);
    expect(c.guidance.join(' ')).toMatch(/tell the user/);
    expect(data).not.toHaveProperty('citing');
  });

  it('S2: only the classes present are reported', async () => {
    const { data } = await call('lex_semantic_legislation', { query: 'x', asOf: '2001-01-01' }, () => ({
      body: { success: true, asOf: '2001-01-01', results: [{ law_id: '32016R0679', article_ref: 'art_17', asOf: '2001-01-01', asOfResolved: false, asOfReason: 'no_longer_in_force' }] },
    }));
    expect(Object.keys(data.asOfCaveat).sort()).toEqual(['guidance', 'notInForce', 'note']);
  });

  it('without consolidated hits the output has no citing note', async () => {
    const { data } = await call('lex_semantic_legislation', { query: 'right to be forgotten' }, () => ({
      body: { success: true, results: [{ law_id: '32016R0679', law_title: 'GDPR', article_ref: 'art_17', score: 0.73, snippet: 's' }] },
    }));
    expect(data).toEqual({ resultCount: 1, results: [{ law_id: '32016R0679', law_title: 'GDPR', article_ref: 'art_17', score: 0.73, snippet: 's' }] });
  });

  it('bounds full texts by maxChars', async () => {
    const { data } = await call('lex_semantic_legislation', { query: 'x', include: ['text'], maxChars: 4000 }, () => ({
      body: { success: true, results: [{ law_id: 'A', text: 'y'.repeat(5000) }, { law_id: 'B', text: 'z'.repeat(5000) }] },
    }));
    expect(data.results[0].text.length).toBeLessThan(2200);
    expect(data.note).toMatch(/truncated/);
  });
});

describe('lex_semantic_case_law', () => {
  it('forwards hyde, language, include and typed filters; drops snapshot ids and duplicate snippet', async () => {
    const { calls, data } = await call('lex_semantic_case_law', {
      query: 'credit scoring article 22', hyde: true, language: 'fr', filters: { court: 'Court of Justice', date_from: '2020-01-01' },
    }, () => ({
      body: {
        success: true, resultCount: 1, hyde: true, hypotheticalDocument: 'long…',
        results: [{
          case_id: 'snap-1', score: 0.7642, case_name: 'SCHUFA', case_number: 'C-634/21', ecli: 'ECLI:EU:C:2023:957',
          court: 'Court of Justice', decision_date: '2023-12-07', language: 'en', summary: 'The Court held …', snippet: 'The Court held …',
          metadata: { celex_id: '62021CJ0634', document_type: 'judgment' }, outcome: 'upheld',
        }],
        metadata: { model: 'x' }, tookMs: 2000,
      },
    }));
    expect(calls[0].url.pathname).toBe('/api/v1/search/semantic');
    expect(calls[0].body).toEqual({
      query: 'credit scoring article 22', limit: 10, language: 'fr', hyde: true,
      filters: { court: 'Court of Justice', date_from: '2020-01-01' },
    });
    expect(data.results[0]).toEqual({
      celex: '62021CJ0634', documentType: 'judgment', score: 0.764, case_name: 'SCHUFA', case_number: 'C-634/21',
      ecli: 'ECLI:EU:C:2023:957', court: 'Court of Justice', decision_date: '2023-12-07', summary: 'The Court held …', outcome: 'upheld',
    });
    expect(data.hyde).toBe(true);
    expect(data).not.toHaveProperty('hypotheticalDocument');
  });
});

describe('citation tools', () => {
  it('lex_cited_by: query params and grouped edges', async () => {
    const { calls, data } = await call('lex_cited_by', { celexNumber: '32008R1272', citationType: 'amendment' }, () => ({
      body: {
        success: true, targetDocument: '32008R1272', totalCitations: 2, uniqueDocuments: 1, limit: 50, offset: 0,
        citedBy: [{ celexNumber: '32009R0790', title: 'Commission Regulation (EC) No 790/2009', citationCount: 1, citations: [{ citationType: 'amendment', contextSnippet: null, extractedAt: '2026-01-01' }] }],
        relationSync: { source: 'cellar', status: 'fresh', syncedAt: '2026-10-20T00:00:00Z' },
      },
    }));
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ citationType: 'amendment', limit: '50', offset: '0' });
    expect(data.citedBy[0]).toEqual({ celex: '32009R0790', title: 'Commission Regulation (EC) No 790/2009', types: ['amendment'], count: 1 });
    expect(data.relationSync.status).toBe('fresh');
  });

  it('lex_citation_network now forwards citationType / limit / offset', async () => {
    const { calls, data } = await call('lex_citation_network', { celexNumber: '32016R0679', limit: 10 }, () => ({
      body: {
        success: true, document: '32016R0679',
        network: { celexNumber: '32016R0679', citesCount: 1, citedByCount: 0, cites: [{ celexNumber: '31995L0046', title: 'Directive 95/46/EC', count: 2, types: ['repeal'] }], citedBy: [] },
        paging: { limit: 10, offset: 0, citesTotal: 1, citedByTotal: 0 },
      },
    }));
    expect(calls[0].url.searchParams.get('limit')).toBe('10');
    expect(data.cites[0]).toEqual({ celex: '31995L0046', title: 'Directive 95/46/EC', types: ['repeal'], count: 2 });
  });

  it('lex_citation_path / lex_related / lex_extract_citations shape compactly', async () => {
    const p = await call('lex_citation_path', { from: '62018cj0311', to: '32016R0679', maxDepth: 4 }, () => ({
      body: { success: true, from: '62018CJ0311', to: '32016R0679', found: true, pathLength: 1, maxDepth: 4, path: [{ celexNumber: '62018CJ0311', title: 'Schrems II', titleSource: 'corpus' }, { celexNumber: '32016R0679', title: 'GDPR' }] },
    }));
    expect(p.calls[0].url.pathname).toBe('/api/v1/citations/path/62018CJ0311/32016R0679');
    expect(p.data.path[0]).toEqual({ celex: '62018CJ0311', title: 'Schrems II' });

    const r = await call('lex_related', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, celexNumber: '32016R0679', method: 'bibliographic-coupling', count: 1, related: [{ celexNumber: '32016L0680', title: 'LED', sharedCount: 9, sharedTargets: Array(30).fill('X'), titleSource: 'corpus' }] },
    }));
    expect(r.data.related[0].sharedTargets).toHaveLength(10);

    const e = await call('lex_extract_citations', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, citationCount: 2, alreadyExtracted: false, citations: [{ targetCelex: '31995L0046', citationType: 'repeal', contextSnippet: null }] },
    }));
    expect(e.calls[0].body).toEqual({ celexNumber: '32016R0679' });
    expect(e.data.citations).toEqual([{ celex: '31995L0046', type: 'repeal' }]);
  });
});

describe('identity, versions, info, export', () => {
  it('lex_resolve posts the identifier', async () => {
    const { calls, data } = await call('lex_resolve', { identifier: 'ECLI:EU:C:2020:559' }, () => ({
      body: { success: true, identifier: 'ECLI:EU:C:2020:559', identifierType: 'ecli', resolvedVia: 'ecli-corpus', celex: '62018CJ0311', urls: {}, subscription: {} },
    }));
    expect(calls[0].body).toEqual({ identifier: 'ECLI:EU:C:2020:559' });
    expect(data.celex).toBe('62018CJ0311');
    expect(data).not.toHaveProperty('subscription');
  });

  it('lex_get_document_version: by date or version, exactly one', async () => {
    const reply = () => ({ body: { success: true, celex: '32016R0679', language: 'en', asOf: '2026-06-15', document: { version: 2, isCurrent: false, fetchedAt: '2026-03-15', parsedContent: fakeDocument(2).content } } });
    const byDate = await call('lex_get_document_version', { celexNumber: '32016R0679', date: '2026-06-15' }, reply);
    expect(byDate.calls[0].url.pathname).toBe('/api/v1/documents/32016R0679/at/2026-06-15');
    expect(byDate.data.content.articles).toHaveLength(2);
    expect(byDate.data.semantics).toMatch(/not a legal in-force/);
    const byVersion = await call('lex_get_document_version', { celexNumber: '32016R0679', version: 2 }, reply);
    expect(byVersion.calls[0].url.pathname).toBe('/api/v1/documents/32016R0679/versions/2');
    const neither = await call('lex_get_document_version', { celexNumber: '32016R0679' }, reply);
    expect(neither.result.isError).toBe(true);
    expect(neither.calls).toHaveLength(0);
  });

  it('lex_document_versions shortens hashes', async () => {
    const { data } = await call('lex_document_versions', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, celex: '32016R0679', currentVersion: 2, versions: [{ version: 2, isCurrent: true, contentHash: 'abcdef0123456789', fetchedAt: 'x' }, { version: 1, isCurrent: false, contentHash: '0123456789abcdef', fetchedAt: 'y' }] },
    }));
    expect(data.versions[0]).toEqual({ version: 2, isCurrent: true, fetchedAt: 'x', contentHash: 'abcdef012345' });
    expect(data.versions[1]).not.toHaveProperty('isCurrent');
  });

  it('lex_info: drops the endpoint map', async () => {
    const { data } = await call('lex_info', {}, () => ({
      body: { service: 'LexAPI', version: '2.0.0', endpoints: { huge: true }, subscription: { tier: 'FREE' }, credits: { operation_weight: 0, remaining: 480, limit: 500 }, supportedLanguages: ['en', 'fr'] },
    }));
    expect(data).toEqual({ service: 'LexAPI', apiVersion: '2.0.0', subscription: { tier: 'FREE' }, credits: { remaining: 480, limit: 500 }, supportedLanguages: 'en,fr' });
  });

  it('lex_export: small defaults, NDJSON parsed, content off', async () => {
    const { calls, data } = await call('lex_export', { documentType: ['Regulation'] }, () => ({
      raw: [
        JSON.stringify({ _meta: { totalMatching: 120 } }),
        JSON.stringify({ celex: '32016R0679', title: 'GDPR', documentType: 'Regulation', contentHash: 'h', lastSeenAt: '2026-10-01' }),
        JSON.stringify({ _done: { written: 1, truncated: true, skippedStubs: 0 } }),
      ].join('\n'),
      headers: { 'content-type': 'application/x-ndjson' },
    }));
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ documentType: 'Regulation', includeContent: 'false', limit: '20' });
    expect(data).toEqual({ totalMatching: 120, returned: 1, truncated: true, skippedStubs: 0, rows: [{ celex: '32016R0679', title: 'GDPR', documentType: 'Regulation', lastSeenAt: '2026-10-01' }] });
  });
});

describe('webhook tools', () => {
  it('create: requires criteria or a watch list; never retried; warns about the one-time secret', async () => {
    const none = await call('lex_create_webhook', { name: 'x', url: 'https://example.com/h' }, () => ({ body: {} }));
    expect(none.result.isError).toBe(true);
    expect(none.calls).toHaveLength(0);

    const { calls, data } = await call('lex_create_webhook', { name: 'Chemicals', url: 'https://example.com/h', watchCelex: ['32006r1907'] }, () => ({
      status: 201,
      body: { success: true, message: 'Webhook created', webhook: { id: 'w1', secret: 'abc', status: 'ACTIVE' } },
    }));
    expect(calls[0].body).toEqual({ name: 'Chemicals', url: 'https://example.com/h', watchCelex: ['32006R1907'] });
    expect(data.webhook.secret).toBe('abc');
    expect(data.important).toMatch(/only once/);
  });

  it('criteria are strict (unknown keys are refused, as the API would)', () => {
    const s = z.object(byName.lex_create_webhook.inputSchema);
    expect(s.safeParse({ name: 'x', url: 'https://e.com', searchCriteria: { query: 'AI', bogus: 1 } }).success).toBe(false);
  });

  it('update forwards only the given fields, including searchCriteria: null', async () => {
    const { calls } = await call('lex_update_webhook', { id: 'w1', status: 'ACTIVE', searchCriteria: null }, () => ({ body: { success: true, webhook: {}, requeuedDeliveries: 0 } }));
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toEqual({ status: 'ACTIVE', searchCriteria: null });
  });

  it('get with delivery paging calls the deliveries endpoint', async () => {
    const { calls, data } = await call('lex_get_webhook', { id: 'w1', deliveriesLimit: 5 }, (c) => (c.url.pathname.endsWith('/deliveries')
      ? { body: { success: true, total: 7, deliveries: [{ id: 'd1', status: 'FAILED', payload: { event: 'documents.new', data: { count: 3, documents: [] } }, responseStatus: 500, attemptCount: 7 }] } }
      : { body: { success: true, webhook: { id: 'w1', name: 'n', recentDeliveries: [] } } }));
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/webhooks/w1', '/api/v1/webhooks/w1/deliveries']);
    expect(data.deliveriesTotal).toBe(7);
    expect(data.deliveries[0]).toEqual({ id: 'd1', status: 'FAILED', event: 'documents.new', documents: 3, responseStatus: 500, attemptCount: 7 });
  });

  it('delete reports the id', async () => {
    const { calls, data } = await call('lex_delete_webhook', { id: 'w1' }, () => ({ status: 204 }));
    expect(calls[0].method).toBe('DELETE');
    expect(data).toEqual({ deleted: 'w1' });
  });
});

describe('descriptions (review N3, N9, webhook URLs, N10)', () => {
  it('N3: cited-by no longer claims completeness; points at relationSync', () => {
    const d = byName.lex_cited_by.description;
    expect(d).not.toMatch(/are complete/);
    expect(d).toMatch(/relationSync/);
    expect(d).toMatch(/refreshed on read/);
  });

  it('N9: export cost is neutral and the unreliable date filters are gone', () => {
    const t = byName.lex_export;
    expect(t.description).not.toMatch(/per row/);
    expect(Object.keys(t.inputSchema)).not.toContain('dateFrom');
    expect(Object.keys(t.inputSchema)).not.toContain('dateTo');
  });

  it('webhook URLs must be public https', () => {
    expect(byName.lex_create_webhook.description).toMatch(/must be a public https URL/);
    expect((byName.lex_update_webhook.inputSchema.url as any).description).toMatch(/public https URL/);
  });

  it('N10: languages are validated without repeating the 24-code enum', () => {
    const s = z.object(byName.lex_get_document.inputSchema);
    expect(s.safeParse({ celexNumber: '32016R0679', language: 'hu' }).success).toBe(true);
    expect(s.safeParse({ celexNumber: '32016R0679', language: 'xx' }).success).toBe(false);
    expect(s.safeParse({ celexNumber: '32016R0679', acceptLanguages: ['fr', 'zz'] }).success).toBe(false);
  });
});

describe('errors reach the model as actionable tool errors', () => {
  it('402 from a semantic call', async () => {
    const { result } = await call('lex_semantic_case_law', { query: 'abc def' }, () => ({
      status: 402,
      body: { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted', details: { weight: 5, available: 1, resetsAt: '2026-11-01T00:00:00.000Z' } } },
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/needs 5 credits.*1 are available.*2026-11-01/);
  });
});
