// The three workflow tools, against a stubbed API: both API shapes (with and
// without the in-force fields), and every way one of their calls can fail.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createLexServer, runTool } from '../src/server.js';
import { selectTools, tools, type ToolDef } from '../src/tools.js';
import { clientWith, parseText, type Call } from './helpers.js';

const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;

type Reply = ReturnType<Parameters<typeof clientWith>[0]>;

async function call(name: string, args: Record<string, unknown>, reply: (c: Call, n: number) => Reply) {
  const tool = byName[name];
  const parsed = z.object(tool.inputSchema).parse(args);
  const { client, calls } = clientWith(reply, { maxRetries: 0 });
  const result = await runTool(tool, parsed, client);
  const text = result.content[0].text;
  return { result, calls, text, data: result.isError ? undefined : parseText(result), paths: calls.map((c) => c.url.pathname.replace('/api/v1', '')) };
}

const GDPR_URLS = { html: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679' };
const metadata = (extra: Record<string, unknown> = {}) => ({
  success: true,
  metadata: {
    celexNumber: '32016R0679', celex: '32016R0679',
    title: 'Regulation (EU) 2016/679 (General Data Protection Regulation)',
    documentType: 'Regulation', documentTypeCode: 'regulation',
    dateOfDocumentISO: '2016-04-27', dateOfEffectISO: '2016-05-24',
    eli: 'http://data.europa.eu/eli/reg/2016/679/oj', urls: GDPR_URLS,
    ...extra,
  },
});
const articleDoc = (articles: unknown[], extra: Record<string, unknown> = {}) => ({
  success: true,
  document: {
    celex: '32016R0679', title: 'Regulation (EU) 2016/679', documentType: 'Regulation', dateOfDocumentISO: '2016-04-27',
    language: 'en', urls: GDPR_URLS, textAvailability: { available: true }, content: { articles }, ...extra,
  },
});
const notFound = (message: string) => ({ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message } } });
const exhausted = (weight = 5) => ({
  status: 402,
  body: { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted', details: { weight, available: 0, resetsAt: '2026-12-01T00:00:00.000Z' } } },
});
const rateLimited = () => ({ status: 429, headers: { 'retry-after': '30' }, body: { error: 'Rate limit exceeded', code: 'RATE_LIMITED', retryAfter: 30 } });
const tierForbidden = () => ({ status: 403, body: { success: false, code: 'TIER_FORBIDDEN', error: 'National-law access is not included in your plan', jurisdiction: 'AT' } });
const allowanceExhausted = () => ({
  status: 402,
  headers: { 'x-national-limit': '30', 'x-national-remaining': '0' },
  body: { success: false, error: { code: 'NATIONAL_ALLOWANCE_EXHAUSTED', message: 'Monthly national allowance used', details: { jurisdiction: 'AT', limit: 30, remaining: 0, resetsAt: '2026-12-01T00:00:00.000Z' } } },
});

afterEach(() => { vi.restoreAllMocks(); });

describe('catalogue', () => {
  it('the workflow tools are read-only and listed in read-only mode', () => {
    const ro = selectTools({ readOnly: true }).map((t) => t.name);
    for (const name of ['lex_check_citation', 'lex_act_history', 'lex_research']) {
      expect(ro).toContain(name);
      expect(byName[name].write).toBeUndefined();
      expect(byName[name].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it('the texts say what the tools compute themselves, and describe rather than promote', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    expect(readme).toMatch(/Two values are computed by the tools from what the API returned: `onDate.status`.*`celexYear`/);
    expect(readme).not.toMatch(/add no data of their own/);
    expect(byName.lex_act_history.description).not.toMatch(/webhook/i);
    expect(byName.lex_check_citation.description).not.toMatch(/Every value comes from an API answer/);
    expect(byName.lex_verify_citation).toBeUndefined();
  });

  it('inputs are checked before any call: dates, CELEX numbers, codes and bounds', () => {
    const parse = (name: string, args: Record<string, unknown>) => z.object(byName[name].inputSchema).parse(args);
    expect(() => parse('lex_check_citation', { identifier: '32016R0679', date: '2024-02-30' })).toThrow(/YYYY-MM-DD/);
    expect(() => parse('lex_check_citation', { identifier: 'x' })).toThrow();
    expect(() => parse('lex_act_history', { celexNumber: '!!' })).toThrow(/must look like 32016R0679/);
    expect(() => parse('lex_act_history', { celexNumber: '32016R0679', dates: 11 })).toThrow();
    expect(() => parse('lex_act_history', { celexNumber: '32016R0679', since: '2024' })).toThrow(/YYYY-MM-DD/);
    expect(() => parse('lex_research', { query: 'data protection', jurisdictions: ['austria'] })).toThrow(/two-letter codes/);
    expect(() => parse('lex_research', { query: 'data protection', jurisdictions: ['eu', 'at', 'de', 'nl', 'es', 'cz', 'si', 'pl', 'it'] })).toThrow();
    expect(() => parse('lex_research', { query: 'data protection', kinds: ['caselaw'] })).toThrow();
    expect(() => parse('lex_research', { query: 'data protection', limit: 21 })).toThrow();
    expect(parse('lex_research', { query: 'data protection', jurisdictions: 'EU, At' }).jurisdictions).toEqual(['eu', 'at']);
    expect(parse('lex_act_history', { celexNumber: '32016R0679' })).toMatchObject({ dates: 0, limit: 100, offset: 0 });
  });

  it('over MCP: listed with schemas, called, and bad arguments refused before any request', async () => {
    const { client, calls } = clientWith(() => ({ body: metadata({ inForce: true }), headers: { 'x-source': 'corpus' } }));
    const server = createLexServer(client, { readOnly: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(b);
    const { tools: listed } = await mcp.listTools();
    for (const name of ['lex_check_citation', 'lex_act_history', 'lex_research']) {
      const t = listed.find((x) => x.name === name)!;
      expect(t.annotations, name).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      for (const [key, prop] of Object.entries(t.inputSchema.properties ?? {})) {
        expect((prop as { description?: string }).description, `${name}.${key}`).toBeTruthy();
      }
    }
    const bad = await mcp.callTool({ name: 'lex_check_citation', arguments: { identifier: '32016R0679', date: 'yesterday' } });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const ok = await mcp.callTool({ name: 'lex_check_citation', arguments: { identifier: '32016R0679' } });
    expect(parseText(ok as any)).toMatchObject({ celex: '32016R0679', exists: true, inForce: true });
    expect(calls).toHaveLength(1);
    await mcp.close();
  });
});

describe('the in-force label on the other tools (API 2.19.0)', () => {
  const label = { inForce: false, notInForceReason: 'no_longer_in_force', endOfValidity: '2018-05-24' };

  it('is passed through by metadata and document reads, and absent when the API sends none', async () => {
    const md = await call('lex_get_metadata', { celexNumber: '31995L0046' }, () => ({ body: metadata({ celex: '31995L0046', ...label }) }));
    expect(md.data).toMatchObject(label);
    const doc = await call('lex_get_document', { celexNumber: '32016R0679', articleId: '17' }, () => ({ body: articleDoc([{ id: 'art_17', number: 'Article 17', content: 'x' }], { inForce: true }) }));
    expect(doc.data.inForce).toBe(true);
    const plain = await call('lex_get_metadata', { celexNumber: '32016R0679' }, () => ({ body: metadata() }));
    for (const k of ['inForce', 'notInForceReason', 'endOfValidity', 'entryIntoForce']) expect(k in plain.data, k).toBe(false);
  });

  it('is passed through on semantic legislation hits', async () => {
    const { data } = await call('lex_semantic_legislation', { query: 'data protection' }, () => ({
      body: { success: true, results: [{ law_id: '31995L0046', article_ref: 'art_1', score: 0.9, ...label }, { law_id: '32016R0679', article_ref: 'art_1', score: 0.8 }] },
    }));
    expect(data.results[0]).toMatchObject(label);
    expect('inForce' in data.results[1]).toBe(false);
  });
});

describe('lex_check_citation', () => {
  it('a CELEX on an API without the in-force fields: exists, in force unknown', async () => {
    const { data, paths, calls } = await call('lex_check_citation', { identifier: 'celex:32016r0679' }, () => ({ body: metadata(), headers: { 'x-source': 'corpus' } }));
    expect(paths).toEqual(['/documents/metadata']); // a CELEX is not resolved
    expect(calls[0].body).toEqual({ celexNumber: '32016R0679' });
    expect(data).toMatchObject({
      identifierType: 'celex', celex: '32016R0679', exists: true,
      title: 'Regulation (EU) 2016/679 (General Data Protection Regulation)',
      url: GDPR_URLS.html, inForce: 'unknown', latestConsolidated: 'not_reported',
    });
    expect(data.inForceNote).toMatch(/No in-force status was returned/);
    expect(data.basis).toEqual({ celex: 'the CELEX as given', exists: 'lex_get_metadata: document returned (source: corpus)' });
    expect(data.notChecked).toBeUndefined();
  });

  it('API 2.19.0: the in-force label is passed on as it is', async () => {
    const inForce = await call('lex_check_citation', { identifier: '32016R0679' }, () => ({ body: metadata({ inForce: true }) }));
    expect(inForce.data.inForce).toBe(true);
    expect(inForce.data.inForceNote).toBeUndefined();
    expect(inForce.data.basis.inForce).toMatch(/status today.*amendments are not covered/);

    const repealed = await call('lex_check_citation', { identifier: '31995L0046', date: '2020-01-01' }, () => ({
      body: metadata({ celex: '31995L0046', celexNumber: '31995L0046', dateOfDocumentISO: '1995-10-24', inForce: false, notInForceReason: 'no_longer_in_force', endOfValidity: '2018-05-24' }),
    }));
    expect(repealed.data).toMatchObject({ exists: true, inForce: false, notInForceReason: 'no_longer_in_force', endOfValidity: '2018-05-24' });
    expect(repealed.data.onDate).toEqual({ date: '2020-01-01', status: 'after_end_of_validity', endOfValidity: '2018-05-24' });

    const notYet = await call('lex_check_citation', { identifier: '32024R1689', date: '2024-07-01' }, () => ({
      body: metadata({ celex: '32024R1689', dateOfDocumentISO: '2024-06-13', inForce: false, notInForceReason: 'not_yet_in_force', entryIntoForce: '2024-08-01' }),
    }));
    expect(notYet.data.onDate).toEqual({ date: '2024-07-01', status: 'before_entry_into_force', entryIntoForce: '2024-08-01' });
  });

  it('in-force fields that contradict each other are unknown, with a note', async () => {
    for (const fields of [{ inForce: true, notInForceReason: 'no_longer_in_force', endOfValidity: '2018-05-24' }, { inForce: false }, { inForce: false, endOfValidity: '2018-05-24' }]) {
      const { data } = await call('lex_check_citation', { identifier: '32016R0679' }, () => ({ body: metadata(fields) }));
      expect(data.inForce).toBe('unknown');
      expect(data.inForceNote).toMatch(/contradict each other/);
      expect(data.notInForceReason).toBeUndefined();
      expect(data.basis.inForce).toBeUndefined();
      const history = await call('lex_act_history', { celexNumber: '32016R0679' }, (c) => (
        c.url.pathname.includes('/cited-by/') ? { body: { success: true, citedBy: [] } } : { body: metadata(fields) }
      ));
      expect(history.data.inForce).toBe('unknown');
      expect(history.data.inForceNote).toMatch(/contradict each other/);
      const search = await call('lex_research', { query: 'data protection', kinds: ['legislation'] }, () => ({ body: { success: true, results: [{ law_id: '32016R0679', article_ref: 'art_1', score: 0.9, ...fields }] } }));
      expect(search.data.results[0].inForce).toBe('unknown');
    }
  });

  it('a date the returned dates do not settle is unknown, and one before the document date says so', async () => {
    const open = await call('lex_check_citation', { identifier: '32016R0679', date: '2019-01-01' }, () => ({ body: metadata({ inForce: true }) }));
    expect(open.data.onDate).toMatchObject({ date: '2019-01-01', status: 'unknown' });
    const early = await call('lex_check_citation', { identifier: '32016R0679', date: '2010-01-01' }, () => ({ body: metadata() }));
    expect(early.data.onDate).toEqual({ date: '2010-01-01', status: 'before_document_date', documentDate: '2016-04-27' });
  });

  it('a mistyped CELEX: the 404 is the answer, nothing else is claimed', async () => {
    const { data, result, paths } = await call('lex_check_citation', { identifier: '32016R0697' }, () => notFound('Document 32016R0697 does not exist on EUR-Lex'));
    expect(result.isError).toBeFalsy();
    expect(paths).toEqual(['/documents/metadata']);
    expect(data).toMatchObject({ celex: '32016R0697', exists: false, inForce: 'unknown' });
    expect(data.basis.exists).toBe('lex_get_metadata: LexAPI error 404 (NOT_FOUND): Document 32016R0697 does not exist on EUR-Lex');
    expect(data.title).toBeUndefined();
    expect(data.url).toBeUndefined();
  });

  it('an ELI is resolved first, then read', async () => {
    const { data, paths, calls } = await call('lex_check_citation', { identifier: 'http://data.europa.eu/eli/reg/2016/679/oj' }, (c) => (
      c.url.pathname.endsWith('/resolve')
        ? { body: { success: true, identifier: 'x', identifierType: 'eli', resolvedVia: 'eli-cellar', verified: true, celex: '32016R0679', urls: GDPR_URLS } }
        : { body: metadata({ inForce: true }) }
    ));
    expect(paths).toEqual(['/resolve', '/documents/metadata']);
    expect(calls[0].body).toEqual({ identifier: 'http://data.europa.eu/eli/reg/2016/679/oj' });
    expect(data).toMatchObject({ identifierType: 'eli', celex: '32016R0679', exists: true, inForce: true });
    expect(data.basis.celex).toBe('lex_resolve (eli-cellar; confirmed by a register)');
  });

  it('a URL is read off, not looked up: existence comes from the read alone', async () => {
    const { data } = await call('lex_check_citation', { identifier: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0697' }, (c) => (
      c.url.pathname.endsWith('/resolve')
        ? { body: { success: true, identifierType: 'url', resolvedVia: 'url', verified: false, celex: '32016R0697', urls: {} } }
        : notFound('Document 32016R0697 does not exist on EUR-Lex')
    ));
    expect(data).toMatchObject({ identifierType: 'url', celex: '32016R0697', exists: false });
    expect(data.basis.celex).toBe('lex_resolve (url; read off the identifier, not looked up)');
  });

  it('an ECLI LexAPI cannot resolve is unknown, not "does not exist"', async () => {
    const { data, paths } = await call('lex_check_citation', { identifier: 'ECLI:EU:C:2099:1' }, () => notFound('Could not resolve identifier to a CELEX: ECLI:EU:C:2099:1'));
    expect(paths).toEqual(['/resolve']);
    expect(data).toMatchObject({ identifierType: 'ecli', exists: 'unknown', inForce: 'unknown' });
    expect(data.notChecked[0]).toMatchObject({ call: 'lex_resolve', reason: 'not_found' });
    expect(data.notChecked[0].note).toMatch(/only for case law it holds.*not proof/);
    expect(data.celex).toBeUndefined();
  });

  const ARTICLES = [
    { id: 'art_6', number: 'Article 6', title: 'Lawfulness of processing', content: 'x' },
    { id: 'art_6a', number: 'Article 6a', title: 'Inserted', content: 'x' },
    { id: 'art_17', number: 'Article 17', title: 'Right to erasure', content: `1. The data subject shall have the right… ${'x'.repeat(600)}` },
  ];

  it('an article that exists is read with the document in one call', async () => {
    const { data, paths, calls } = await call('lex_check_citation', { identifier: '32016R0679', article: '17' }, () => ({
      body: articleDoc(ARTICLES, { inForce: true }), headers: { 'x-source': 'corpus' },
    }));
    expect(paths).toEqual(['/documentContent']);
    // The whole article list is read, so a miss can be told from a text without articles.
    expect(calls[0].body).toEqual({ celexNumber: '32016R0679', include: ['metadata', 'articles'] });
    expect(data).toMatchObject({ exists: true, inForce: true });
    expect(data.article).toEqual({
      requested: '17', found: true, id: 'art_17', number: 'Article 17', title: 'Right to erasure', checkedIn: '32016R0679',
      excerpt: expect.any(String),
    });
    expect(data.article.excerpt.length).toBeLessThanOrEqual(300);
    expect(data.basis.article).toBe('lex_get_document: the article units of the text');
  });

  it('common citation forms are mapped to the article number; a paragraph or point is reported as not checked', async () => {
    const reply = () => ({ body: articleDoc(ARTICLES) });
    for (const form of ['Art. 17', 'Art 17', 'art_17', 'ARTICLE 17', 'Article 17(1)', '17(1)(a)', 'Art. 17, para 2']) {
      const { data } = await call('lex_check_citation', { identifier: '32016R0679', article: form }, reply);
      expect(data.article, form).toMatchObject({ requested: form, found: true, id: 'art_17' });
      if (/[(,]/.test(form)) expect(data.article.notChecked, form).toMatch(/only the article was looked up/);
      else expect(data.article.notChecked, form).toBeUndefined();
    }
    const zeros = await call('lex_check_citation', { identifier: '32016R0679', article: 'Art. 017' }, reply);
    expect(zeros.data.article).toMatchObject({ found: true, id: 'art_17' });
    const suffix = await call('lex_check_citation', { identifier: '32016R0679', article: 'Article 6a' }, reply);
    expect(suffix.data.article).toMatchObject({ found: true, id: 'art_6a' });
  });

  it('a form that cannot be mapped is unknown, never "not found", and no document is read for it', async () => {
    for (const form of ['Annex I', '6 bis', 'recital 4', 'seventeen', '17th', 'Article 1st', '17 and 18', '17-19']) {
      const { data, paths } = await call('lex_check_citation', { identifier: '32016R0679', article: form }, () => ({ body: metadata() }));
      expect(paths, form).toEqual(['/documents/metadata']);
      expect(data.exists).toBe(true);
      expect(data.article, form).toMatchObject({ requested: form, found: 'unknown' });
      expect(data.article.note).toMatch(/could not be mapped to one article number/);
    }
  });

  it('an article that does not exist: found false, scoped to the article units that were compared', async () => {
    const { data } = await call('lex_check_citation', { identifier: '32016R0679', article: 'Article 120' }, () => ({ body: articleDoc(ARTICLES) }));
    expect(data.exists).toBe(true);
    expect(data.article).toEqual({
      requested: 'Article 120', found: false, checkedIn: '32016R0679',
      note: 'Article 120 is not among the 3 article units of 32016R0679 (written like "Article 6"); only the act as published was compared, and an article inserted by a later amendment is only in a consolidated version.',
    });
    expect(data.inForce).toBe('unknown');
    const cons = await call('lex_check_citation', { identifier: '02016R0679-20160504', article: '120' }, () => ({ body: articleDoc(ARTICLES, { celex: '02016R0679-20160504' }) }));
    expect(cons.data.article.note).toBe('Article 120 is not among the 3 article units of 02016R0679-20160504 (written like "Article 6"); only this consolidated version was compared.');
  });

  it('a text without article units (a judgment): the article is unknown, not "not found"', async () => {
    for (const content of [{ articles: [] }, {}, { paragraphs: [{ number: 1, text: 'x' }] }]) {
      const { data } = await call('lex_check_citation', { identifier: '62018CJ0311', article: '17' }, () => ({
        body: articleDoc([], { celex: '62018CJ0311', content }),
      }));
      expect(data.exists).toBe(true);
      expect(data.article).toMatchObject({ requested: '17', found: 'unknown' });
      expect(data.article.note).toMatch(/has no article units as LexAPI holds it/);
    }
  });

  it('a 200 that carries no document is not evidence that it exists', async () => {
    const replies: Reply[] = [
      { raw: '' },
      { raw: '<html><body>OK</body></html>', headers: { 'content-type': 'text/html' } },
      { body: { success: true } },
      { body: { success: true, metadata: { title: 'A title without an identifier' } } },
      { body: { success: false, metadata: { celex: '32016R0679', title: 'GDPR' } } },
      { body: [] },
    ];
    for (const reply of replies) {
      const { data, result } = await call('lex_check_citation', { identifier: '32016R0679' }, () => reply);
      expect(result.isError).toBeFalsy();
      expect(data).toMatchObject({ celex: '32016R0679', exists: 'unknown', inForce: 'unknown' });
      expect(data.title).toBeUndefined();
      expect(data.notChecked).toEqual([{
        what: 'existence, title, in-force status', call: 'lex_get_metadata', reason: 'unreadable_response',
        note: 'The answer carried no document with an identifier, so it does not show whether 32016R0679 exists.',
      }]);
    }
    const doc = await call('lex_check_citation', { identifier: '32016R0679', article: '17' }, () => ({ body: { success: true } }));
    expect(doc.data).toMatchObject({ exists: 'unknown' });
    expect(doc.data.article).toBeUndefined();
    const national = await call('lex_check_citation', { identifier: 'AT-NOR-1' }, () => ({ body: { success: true, document: { title: 'Datenschutzgesetz' } } }));
    expect(national.data).toMatchObject({ id: 'AT-NOR-1', exists: 'unknown' });
    expect(national.data.notChecked[0].reason).toBe('unreadable_response');
    expect(national.data.title).toBeUndefined();
  });

  it('an answer about a different document is not reported as the one asked for', async () => {
    const other = () => ({ body: metadata({ celex: '32016R0680', celexNumber: '32016R0680', title: 'Directive (EU) 2016/680', inForce: true }) });
    const { data } = await call('lex_check_citation', { identifier: '32016R0679' }, other);
    expect(data).toMatchObject({ celex: '32016R0679', exists: 'unknown', inForce: 'unknown' });
    expect(data.title).toBeUndefined();
    expect(data.notChecked[0]).toMatchObject({
      reason: 'different_document',
      note: '32016R0679 was asked for and the answer is about 32016R0680; nothing from it is reported.',
    });
    // A consolidated version is not its base act, and the other way round.
    const base = await call('lex_check_citation', { identifier: '02016R0679-20160504' }, () => ({ body: metadata() }));
    expect(base.data).toMatchObject({ exists: 'unknown' });
    expect(base.data.notChecked[0].note).toMatch(/02016R0679-20160504 was asked for and the answer is about 32016R0679/);
    const resolved = await call('lex_check_citation', { identifier: 'http://data.europa.eu/eli/reg/2016/679/oj' }, (c) => (
      c.url.pathname.endsWith('/resolve')
        ? { body: { success: true, identifierType: 'eli', resolvedVia: 'eli-cellar', verified: true, celex: '32016R0679', urls: {} } }
        : other()
    ));
    expect(resolved.data).toMatchObject({ celex: '32016R0679', exists: 'unknown' });
    expect(resolved.data.notChecked[0].reason).toBe('different_document');
    const national = await call('lex_check_citation', { identifier: 'AT-NOR-1' }, () => ({ body: { success: true, document: { id: 'AT-NOR-2', jurisdiction: 'AT', title: 'Another act' } } }));
    expect(national.data).toMatchObject({ id: 'AT-NOR-1', exists: 'unknown' });
    expect(national.data.notChecked[0].note).toMatch(/AT-NOR-1 was asked for and the answer is about AT-NOR-2/);
    expect(national.data.title).toBeUndefined();
  });

  it('a resolve answer without a CELEX is unknown', async () => {
    const { data, paths } = await call('lex_check_citation', { identifier: 'ECLI:EU:C:2020:559' }, () => ({ body: { success: true, identifierType: 'ecli' } }));
    expect(paths).toEqual(['/resolve']);
    expect(data).toMatchObject({ exists: 'unknown', inForce: 'unknown' });
    expect(data.notChecked[0]).toMatchObject({ call: 'lex_resolve', reason: 'unreadable_response' });
    expect(data.celex).toBeUndefined();
  });

  it('a 404 that is not the API\'s NOT_FOUND answer is unknown, not "does not exist"', async () => {
    const replies: Reply[] = [
      { status: 404, raw: '<html><body><h1>404 Not Found</h1>nginx</body></html>', headers: { 'content-type': 'text/html' } },
      { status: 404, body: { error: 'Not Found' } },
      { status: 404, body: { success: false, error: { code: 'ROUTE_NOT_FOUND', message: 'No such route' } } },
    ];
    for (const reply of replies) {
      const { data, result } = await call('lex_check_citation', { identifier: '32016R0679' }, () => reply);
      expect(result.isError).toBeFalsy();
      expect(data).toMatchObject({ celex: '32016R0679', exists: 'unknown', inForce: 'unknown' });
      expect(data.notChecked[0]).toMatchObject({ call: 'lex_get_metadata', reason: 'unconfirmed_not_found' });
      expect(data.notChecked[0].note).toMatch(/not the API's own NOT_FOUND answer/);
      const national = await call('lex_check_citation', { identifier: 'AT-NOR-1' }, () => reply);
      expect(national.data).toMatchObject({ exists: 'unknown' });
      const eli = await call('lex_check_citation', { identifier: 'http://data.europa.eu/eli/reg/2016/679/oj' }, () => reply);
      expect(eli.data).toMatchObject({ exists: 'unknown' });
      expect(eli.data.notChecked[0]).toMatchObject({ call: 'lex_resolve', reason: 'unconfirmed_not_found' });
    }
    // The legacy shape carries the code at the top level.
    const legacy = await call('lex_check_citation', { identifier: '32016R0697' }, () => ({ status: 404, body: { success: false, code: 'NOT_FOUND', error: 'No document found with CELEX number: 32016R0697' } }));
    expect(legacy.data.exists).toBe(false);
  });

  it('a date before a consolidated version\'s own date says nothing about the act', async () => {
    const { data } = await call('lex_check_citation', { identifier: '02016R0679-20160504', date: '2016-05-01' }, () => ({
      body: metadata({ celex: '02016R0679-20160504', celexNumber: '02016R0679-20160504', dateOfDocumentISO: '2016-05-04' }),
    }));
    expect(data.onDate).toMatchObject({ date: '2016-05-01', status: 'unknown' });
  });

  it('no published text: the article is unknown and the consolidated pointer is passed on', async () => {
    const ta = { available: false, reason: 'too_large', latestConsolidated: { celex: '02006R1907-20260622', date: '2026-06-22', source: 'cellar' } };
    const { data } = await call('lex_check_citation', { identifier: '32006R1907', article: '57' }, () => ({
      body: { success: true, document: { celex: '32006R1907', title: 'REACH', urls: {}, content: null, textAvailability: ta } },
    }));
    expect(data.exists).toBe(true);
    expect(data.article).toMatchObject({ requested: '57', found: 'unknown' });
    expect(data.article.note).toMatch(/No text was served for 32006R1907 \(too_large\)/);
    expect(data.latestConsolidated).toEqual(ta.latestConsolidated);
    expect(data.textAvailability).toEqual(ta);
  });

  it('a consolidated CELEX is labelled, with its base act', async () => {
    const { data, calls } = await call('lex_check_citation', { identifier: '02016R0679-20160504' }, () => ({
      body: metadata({ celex: '02016R0679-20160504', celexNumber: '02016R0679-20160504', inForce: true }),
    }));
    expect(calls[0].body).toEqual({ celexNumber: '02016R0679-20160504' });
    expect(data).toMatchObject({ celex: '02016R0679-20160504', exists: true, consolidated: true, consolidatedAsOf: '2016-05-04', baseCelex: '32016R0679', inForce: true });
    expect(data.consolidatedNote).toMatch(/not the authentic text/);
    expect(data.basis.inForce).toMatch(/for 32016R0679/);
    expect(data.latestConsolidated).toBeUndefined();
  });

  it('a consolidated pointer the metadata carries is passed on', async () => {
    const latest = { celex: '02016R0679-20160504', date: '2016-05-04', source: 'cellar' };
    const { data } = await call('lex_check_citation', { identifier: '32016R0679' }, () => ({ body: metadata({ latestConsolidated: latest }) }));
    expect(data.latestConsolidated).toEqual(latest);
  });

  it('partial: resolved, but the read could not be paid for', async () => {
    const { data, result, paths } = await call('lex_check_citation', { identifier: 'http://data.europa.eu/eli/reg/2016/679/oj', article: '17' }, (c) => (
      c.url.pathname.endsWith('/resolve')
        ? { body: { success: true, identifierType: 'eli', resolvedVia: 'eli-cellar', verified: true, celex: '32016R0679', urls: GDPR_URLS } }
        : exhausted()
    ));
    expect(result.isError).toBeFalsy();
    expect(paths).toEqual(['/resolve', '/documentContent']);
    expect(data).toMatchObject({ celex: '32016R0679', exists: 'unknown', inForce: 'unknown' });
    expect(data.notChecked).toEqual([{
      what: 'existence, title, in-force status, article', call: 'lex_get_document',
      reason: 'credits_exhausted', error: 'LexAPI error 402 (CREDITS_EXHAUSTED): Credit pool exhausted',
    }]);
    expect(data.title).toBeUndefined();
    expect(data.article).toBeUndefined();
  });

  it('partial: resolved, then the read failed upstream or was rate limited', async () => {
    for (const [reply, reason] of [
      [{ status: 504, body: { success: false, error: { code: 'TIMEOUT', message: 'Upstream EUR-Lex fetch timed out' } } }, 'timeout'],
      [rateLimited(), 'rate_limited'],
    ] as const) {
      const { data } = await call('lex_check_citation', { identifier: 'ECLI:EU:C:2020:559' }, (c) => (
        c.url.pathname.endsWith('/resolve')
          ? { body: { success: true, identifierType: 'ecli', resolvedVia: 'ecli-corpus', verified: true, celex: '62018CJ0311', urls: {} } }
          : reply
      ));
      expect(data).toMatchObject({ celex: '62018CJ0311', exists: 'unknown' });
      expect(data.notChecked[0]).toMatchObject({ call: 'lex_get_metadata', reason });
    }
  });

  it('nothing obtained: the API error is returned as the error', async () => {
    const noCredits = await call('lex_check_citation', { identifier: '32016R0679' }, () => exhausted());
    expect(noCredits.result.isError).toBe(true);
    expect(noCredits.text).toMatch(/LexAPI error 402 \(CREDITS_EXHAUSTED\)/);
    const limited = await call('lex_check_citation', { identifier: 'ECLI:EU:C:2020:559' }, () => rateLimited());
    expect(limited.result.isError).toBe(true);
    expect(limited.text).toMatch(/Per-minute rate limit/);
    expect(limited.calls).toHaveLength(1);
    const badKey = await call('lex_check_citation', { identifier: '32016R0679' }, () => ({ status: 401, body: { error: 'Invalid API key' } }));
    expect(badKey.text).toMatch(/LexAPI error 401/);
  });

  const nationalDoc = (extra: Record<string, unknown> = {}) => ({
    success: true,
    document: {
      id: 'AT-NOR-10001597', jurisdiction: 'AT', language: 'de', documentKind: 'act', title: 'Datenschutzgesetz', documentType: 'Bundesgesetz',
      ecli: null, eli: null, dateOfDocument: '1999-08-17', version: 3, fetchedAt: '2026-10-01T00:00:00.000Z', validTo: null, inForce: null,
      decision: null, textBasis: 'consolidated', textAvailability: { available: true },
      attribution: 'Source: RIS (Rechtsinformationssystem des Bundes), CC BY 4.0. Not the authentic text.',
      content: { fullText: '…', articles: [
        { number: '§ 1', title: 'Grundrecht auf Datenschutz', section: null, text: 'Jedermann hat…', inForceFrom: '2018-05-25', inForceTo: null, details: {} },
        { number: '§ 17a', title: null, section: null, text: 'y', inForceFrom: null, inForceTo: null, details: {} },
      ] },
      ...extra,
    },
  });

  it('a national id: one document read, attribution kept, no end of validity is unknown', async () => {
    const { data, paths } = await call('lex_check_citation', { identifier: 'at-nor-10001597', article: 'Art. 1' }, () => ({
      body: nationalDoc(), headers: { 'x-national-limit': '30', 'x-national-remaining': '12', 'x-national-reset': '2026-12-01T00:00:00.000Z' },
    }));
    expect(paths).toEqual(['/at/documents/AT-NOR-10001597']);
    expect(data).toMatchObject({ identifierType: 'national_id', id: 'AT-NOR-10001597', jurisdiction: 'AT', exists: true, title: 'Datenschutzgesetz', inForce: 'unknown' });
    expect(data.inForceNote).toMatch(/not a statement that it is in force/);
    expect(data.article).toMatchObject({ found: true, number: '§ 1', title: 'Grundrecht auf Datenschutz', inForceFrom: '2018-05-25' });
    expect(data.attribution).toMatch(/RIS/);
    expect(data.allowance).toEqual({ limit: 30, remaining: 12, resetsAt: '2026-12-01T00:00:00.000Z' });
  });

  it('a national id: a repealed act, a unit that is not there, a date after the end', async () => {
    const { data } = await call('lex_check_citation', { identifier: 'AT-NOR-10001597', article: '99', date: '2025-06-01' }, () => ({
      body: nationalDoc({ validTo: '2024-12-31', inForce: false }),
    }));
    expect(data).toMatchObject({ exists: true, inForce: false, validTo: '2024-12-31' });
    expect(data.article).toMatchObject({ requested: '99', found: false, checkedIn: 'AT-NOR-10001597' });
    expect(data.article.note).toMatch(/among the 2 numbered units.*written like "§ 1"/);
    expect(data.onDate).toEqual({ date: '2025-06-01', status: 'after_end_of_validity', endOfValidity: '2024-12-31' });
    const a = await call('lex_check_citation', { identifier: 'AT-NOR-10001597', article: '§17a' }, () => ({ body: nationalDoc() }));
    expect(a.data.article).toMatchObject({ found: true, number: '§ 17a' });
  });

  it('a national id: a paragraph part is not checked, and a document without units is unknown', async () => {
    const part = await call('lex_check_citation', { identifier: 'AT-NOR-10001597', article: '§ 1 (2)' }, () => ({ body: nationalDoc() }));
    expect(part.data.article).toMatchObject({ found: true, number: '§ 1' });
    expect(part.data.article.notChecked).toMatch(/"\(2\)": only the unit was looked up/);
    const decision = await call('lex_check_citation', { identifier: 'AT-NOR-10001597', article: '1' }, () => ({
      body: nationalDoc({ documentKind: 'decision', content: { fullText: '…', articles: [] } }),
    }));
    expect(decision.data.article).toMatchObject({ requested: '1', found: 'unknown' });
    expect(decision.data.article.note).toMatch(/held without numbered units/);
  });

  const units = (...numbers: string[]) => nationalDoc({ content: { fullText: '…', articles: numbers.map((number) => ({ number, title: null, section: null, text: 't', inForceFrom: null, inForceTo: null, details: {} })) } });
  const unit = async (article: string, ...numbers: string[]) => (await call('lex_check_citation', { identifier: 'AT-NOR-10001597', article }, () => ({ body: units(...numbers) }))).data.article;

  it('a national unit with a paragraph, point or sentence part is found; the part is not checked', async () => {
    for (const [form, rest] of [
      ['§ 5 Abs. 2', 'abs. 2'], ['§ 5 Z 3', 'z 3'], ['§ 5 Absatz 1 Satz 2', 'absatz 1 satz 2'], ['§ 5 (2)', '(2)'], ['§ 5, Abs. 2', ', abs. 2'], ['§5 lit. a', 'lit. a'],
    ]) {
      const a = await unit(form, '§ 4', '§ 5', '§ 6', '§ 56', '§ 52');
      expect(a, form).toMatchObject({ requested: form, found: true, number: '§ 5' });
      expect(a.notChecked, form).toBe(`"${rest}": only the unit was looked up, not a paragraph or point of it.`);
    }
    expect(await unit('Artikel 2 Abs. 1', 'Artikel 1', 'Artikel 2')).toMatchObject({ found: true, number: 'Artikel 2' });
    expect(await unit('Art. 5 odst. 2', '§ 5')).toMatchObject({ found: true, number: '§ 5' });
    expect(await unit('5. člen', '4. člen', '5. člen')).toMatchObject({ found: true, number: '5. člen' });
    expect(await unit('§ 017', '§ 17')).toMatchObject({ found: true, number: '§ 17' });
  });

  it('a list, a range or an unreadable remainder is unknown, never a match or a miss', async () => {
    for (const form of ['§§ 5-6', '§ 5-6', 'Art. 5 und 17', '§ 5, 6', '§ 5 und 6', '§ 5 ff', '§ 5 bis 7', '§ 5 something', 'Anl. 1', '§ 5 a']) {
      const a = await unit(form, '§ 5', '§ 6', '§ 17', '§ 56', 'Anl. 1');
      expect(a, form).toMatchObject({ requested: form, found: 'unknown' });
      expect(a.note, form).toMatch(/could not be read as one unit/);
    }
  });

  it('two units with one number: the label decides, and a bare number is unknown', async () => {
    const doc = ['Artikel 1', 'Artikel 2', '§ 1', '§ 2'];
    expect(await unit('§ 2', ...doc)).toMatchObject({ found: true, number: '§ 2' });
    expect(await unit('Artikel 2', ...doc)).toMatchObject({ found: true, number: 'Artikel 2' });
    expect(await unit('Art. 2 Abs. 1', ...doc)).toMatchObject({ found: true, number: 'Artikel 2' });
    const bare = await unit('2', ...doc);
    expect(bare).toMatchObject({ found: 'unknown' });
    expect(bare.note).toBe('Number 2 is carried by units with different labels ("Artikel 2", "§ 2"), so the one meant could not be told.');
    // One unit of that number under another label: matched by number, and said.
    const other = await unit('§ 2', 'Artikel 1', 'Artikel 2');
    expect(other).toMatchObject({ found: true, number: 'Artikel 2' });
    expect(other.note).toBe('Matched by number: the document has one unit numbered 2 and writes it "Artikel 2".');
  });

  it('a unit that is not there is a miss only against units that could be compared', async () => {
    const miss = await unit('§ 99', '§ 1', '§ 2', 'Anl. 1');
    expect(miss).toEqual({
      requested: '§ 99', found: false, checkedIn: 'AT-NOR-10001597',
      note: 'No unit numbered 99 among the 2 numbered units of the text LexAPI holds (compared by number; they are written like "§ 1").',
    });
    const odd = await unit('§ 1', 'Erster Abschnitt', 'Anl. 1');
    expect(odd).toMatchObject({ found: 'unknown' });
    expect(odd.note).toMatch(/not in a form that could be compared/);
  });

  it('a national id LexAPI does not hold, and a country that is not live, are told apart', async () => {
    const missing = await call('lex_check_citation', { identifier: 'AT-NOR-999' }, () => ({
      status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'No document AT-NOR-999', details: { id: 'AT-NOR-999', jurisdiction: 'AT' } } },
    }));
    expect(missing.data).toMatchObject({ id: 'AT-NOR-999', exists: false, inForce: 'unknown' });
    const notLive = await call('lex_check_citation', { identifier: 'FR-LEGI-1' }, () => ({
      status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Unknown API endpoint' } },
    }));
    expect(notLive.data).toMatchObject({ id: 'FR-LEGI-1', exists: 'unknown' });
    expect(notLive.data.notChecked[0].note).toMatch(/no route for FR.*not live/);
  });

  it('a national id behind a plan gate, or withdrawn, is the API error', async () => {
    const gated = await call('lex_check_citation', { identifier: 'AT-NOR-1' }, () => tierForbidden());
    expect(gated.result.isError).toBe(true);
    expect(gated.text).toMatch(/LexAPI error 403 \(TIER_FORBIDDEN\).*plan or subscription does not allow/);
    const used = await call('lex_check_citation', { identifier: 'AT-NOR-1' }, () => allowanceExhausted());
    expect(used.text).toMatch(/monthly allowance of national-law calls/);
    const gone = await call('lex_check_citation', { identifier: 'AT-NOR-1' }, () => ({
      status: 410, body: { success: false, error: { code: 'DOCUMENT_WITHDRAWN', message: 'Withdrawn', details: { id: 'AT-NOR-1', jurisdiction: 'AT' } } },
    }));
    expect(gone.result.isError).toBe(true);
    expect(gone.text).toMatch(/withdrawn by its source/);
  });
});

describe('lex_act_history', () => {
  const edge = (celexNumber: string, citationType: string, title: string | null = `Title of ${celexNumber}`) => ({
    id: celexNumber, celexNumber, jurisdiction: 'EU', documentKind: 'act', title, citationCount: 1,
    citations: [{ citationType, contextSnippet: null, extractedAt: '2026-09-01T00:00:00.000Z', provenance: 'cellar', resolution: null }],
  });
  const citedBy = (groups: unknown[], extra: Record<string, unknown> = {}) => ({
    success: true, targetDocument: '32006R1907', totalCitations: groups.length, totalEdges: groups.length, limit: 100, offset: 0,
    citedBy: groups, relationSync: { source: 'cellar', status: 'fresh', syncedAt: '2026-11-15T00:00:00.000Z' }, ...extra,
  });
  const GROUPS = [
    edge('32020R0878', 'amendment'),
    edge('32024R2865', 'amendment'),
    edge('32006R1907R(01)', 'corrigendum', null),
    edge('32018R0589', 'amendment'),
    edge('32025R0100', 'repeal'),
  ];
  const act = (extra: Record<string, unknown> = {}) => metadata({ celex: '32006R1907', celexNumber: '32006R1907', title: 'REACH', dateOfDocumentISO: '2006-12-18', ...extra });
  const route = (handlers: { edges?: Reply; act?: Reply; dated?: (celex: string) => Reply }) => (c: Call): Reply => {
    if (c.url.pathname.includes('/citations/cited-by/')) return handlers.edges ?? { body: citedBy(GROUPS) };
    const celex = String((c.body as { celexNumber?: string }).celexNumber);
    if (celex === '32006R1907') return handlers.act ?? { body: act() };
    return handlers.dated ? handlers.dated(celex) : notFound('unexpected');
  };

  it('amendments, corrigenda and repeals in one result, with the 2.19.0 label', async () => {
    const { data, calls, paths } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({
      act: { body: act({ inForce: true, endOfValidity: '2030-12-31' }) },
    }));
    expect(paths).toEqual(['/citations/cited-by/32006R1907', '/documents/metadata']);
    expect(calls[0].url.searchParams.get('citationType')).toBe('repeal,amendment,corrigendum');
    expect(calls[0].url.searchParams.get('limit')).toBe('100');
    expect(data).toMatchObject({ celex: '32006R1907', title: 'REACH', inForce: true, endOfValidity: '2030-12-31', consolidatedVersions: 'not_reported' });
    expect(data.changes.repeals).toEqual([{ celex: '32025R0100', title: 'Title of 32025R0100', celexYear: 2025, provenance: ['cellar'] }]);
    expect(data.changes.amendments.map((c: any) => c.celex)).toEqual(['32024R2865', '32020R0878', '32018R0589']);
    expect(data.changes.corrigenda).toEqual([{ celex: '32006R1907R(01)', provenance: ['cellar'] }]); // no year of its own
    expect(data.counts).toEqual({ relations: 5, read: 5 });
    expect(data.completeness.relationSync.status).toBe('fresh');
    expect(data.completeness.note).toMatch(/refreshed from the Publications Office/);
    expect(data.incomplete).toBeUndefined();
    expect(data.basis.changes).toBe('lex_cited_by with citationType amendment, corrigendum, repeal');
  });

  it('an API without the in-force fields: status unknown, end of validity absent', async () => {
    const { data } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({}));
    expect(data.inForce).toBe('unknown');
    expect(data.inForceNote).toMatch(/No in-force status was returned/);
    expect(data.endOfValidity).toBeUndefined();
    expect(data.basis.inForce).toBeUndefined();
  });

  it('since: by CELEX year for free, exactly for the entries whose date is read', async () => {
    const byYear = await call('lex_act_history', { celexNumber: '32006R1907', since: '2024-06-01' }, route({}));
    expect(byYear.calls).toHaveLength(2);
    expect(byYear.data.changes.amendments.map((c: any) => c.celex)).toEqual(['32024R2865']);
    expect(byYear.data.changes.repeals.map((c: any) => c.celex)).toEqual(['32025R0100']);
    expect(byYear.data.changes.corrigenda).toHaveLength(1); // cannot be placed without a date
    expect(byYear.data.since).toMatchObject({ date: '2024-06-01', removedAsEarlier: 2 });
    expect(byYear.data.since.note).toMatch(/3 kept entries have no document date read/);

    const dated = await call('lex_act_history', { celexNumber: '32006R1907', since: '2024-06-01', dates: 2 }, route({
      dated: (celex) => ({ body: metadata({ celex, dateOfDocumentISO: celex === '32024R2865' ? '2024-03-11' : '2007-05-29' }) }),
    }));
    // The two the year cannot place are read first: the corrigendum and the 2024 act.
    expect(dated.calls.slice(2).map((c) => (c.body as any).celexNumber).sort()).toEqual(['32006R1907R(01)', '32024R2865']);
    expect(dated.data.changes.amendments).toEqual([]);
    expect(dated.data.changes.corrigenda).toEqual([]);
    expect(dated.data.changes.repeals.map((c: any) => c.celex)).toEqual(['32025R0100']);
    expect(dated.data.since.removedAsEarlier).toBe(4);
    expect(dated.data.counts.datesRead).toBe(2);
  });

  it('dates without since: the newest entries are dated and sorted by date', async () => {
    const { data } = await call('lex_act_history', { celexNumber: '32006R1907', dates: 1 }, route({
      dated: (celex) => ({ body: metadata({ celex, dateOfDocumentISO: '2025-01-20' }) }),
    }));
    expect(data.changes.repeals).toEqual([{ celex: '32025R0100', title: 'Title of 32025R0100', date: '2025-01-20', provenance: ['cellar'] }]);
    expect(data.changes.amendments[0]).toMatchObject({ celex: '32024R2865', celexYear: 2024 });
  });

  it('a consolidated CELEX is read as its base act', async () => {
    const { data, paths } = await call('lex_act_history', { celexNumber: '02006R1907-20260622' }, route({}));
    expect(paths[0]).toBe('/citations/cited-by/32006R1907');
    expect(data).toMatchObject({ celex: '32006R1907', requested: '02006R1907-20260622' });
  });

  it('consolidated pointers are shown when the metadata carries them', async () => {
    const latest = { celex: '02006R1907-20260622', date: '2026-06-22', source: 'cellar' };
    const upcoming = { celex: '02006R1907-20270101', date: '2027-01-01', source: 'cellar' };
    const { data } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ act: { body: act({ latestConsolidated: latest, upcomingConsolidated: upcoming }) } }));
    expect(data.latestConsolidated).toEqual(latest);
    expect(data.upcomingConsolidated).toEqual(upcoming);
    expect(data.consolidatedVersions).toBeUndefined();
    expect(data.basis.consolidated).toMatch(/not a full list/);
  });

  it('relations served without a refresh, and more pages, are said', async () => {
    const { data } = await call('lex_act_history', { celexNumber: '32006R1907', limit: 5 }, route({
      edges: { body: citedBy(GROUPS, { totalEdges: 42, limit: 5, relationSync: { source: 'cellar', status: 'pending', syncedAt: '2026-10-01T00:00:00.000Z' } }) },
    }));
    expect(data.completeness.note).toMatch(/without a refresh.*may be missing/);
    expect(data.counts).toEqual({ relations: 42, read: 5 });
    expect(data.more).toMatch(/Relations 1–5 of 42 read.*offset 5/);
  });

  it('partial: the relations failed, the act is still returned', async () => {
    const { data, result } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({
      edges: { status: 500, body: { success: false, code: 'INTERNAL', error: 'Failed to fetch citations' } },
      act: { body: act({ inForce: true }) },
    }));
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ title: 'REACH', inForce: true });
    expect(data.changes).toBeUndefined();
    expect(data.incomplete).toEqual([{
      part: 'the changes: amendments, corrigenda, repeals', call: 'lex_cited_by',
      reason: 'upstream_error', error: 'LexAPI error 500 (INTERNAL): Failed to fetch citations',
    }]);
  });

  it('partial: credits ran out after the relations; no further call is made', async () => {
    const { data, calls } = await call('lex_act_history', { celexNumber: '32006R1907', dates: 3 }, route({ act: exhausted() }));
    expect(calls).toHaveLength(2); // the three date reads were not started
    expect(data.changes.amendments).toHaveLength(3);
    expect(data.inForce).toBe('unknown');
    expect(data.title).toBeUndefined();
    expect(data.stopped.reason).toBe('credits_exhausted');
    expect(data.stopped.detail).toMatch(/monthly LexAPI credit pool is exhausted/);
    expect(data.incomplete[0]).toMatchObject({ call: 'lex_get_metadata', reason: 'credits_exhausted' });
    expect(data.incomplete[1].part).toMatch(/document dates/);
    expect(data.changes.repeals[0].dateNotRead).toMatchObject({ reason: 'credits_exhausted' });
    expect(data.changes.repeals[0].dateNotRead.error).toMatch(/^not run/);
  });

  it('partial: a date read hits the rate limit, the rest are not started', async () => {
    let dated = 0;
    const { data, calls } = await call('lex_act_history', { celexNumber: '32006R1907', dates: 4 }, route({
      dated: (celex) => (dated++ === 0 ? { body: metadata({ celex, dateOfDocumentISO: '2025-01-20' }) } : rateLimited()),
    }));
    expect(calls).toHaveLength(4);
    expect(data.counts.datesRead).toBe(1);
    expect(data.stopped.reason).toBe('rate_limited');
    const all = [...data.changes.repeals, ...data.changes.amendments, ...data.changes.corrigenda];
    expect(all.filter((c: any) => c.dateNotRead).map((c: any) => c.dateNotRead.reason)).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
  });

  it('an absent refresh status is said to be absent, and the repeal typing is in the note', async () => {
    const { data } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ edges: { body: citedBy([], { relationSync: undefined }) } }));
    expect(data.completeness.relationSync).toBeUndefined();
    expect(data.completeness.note).toMatch(/The refresh status of the relations was not reported\.$/);
    expect(data.completeness.note).not.toMatch(/without a refresh/);
    expect(data.completeness.note).toMatch(/A partial repeal is typed as an amendment, so an empty repeals list does not exclude one/);
    expect(byName.lex_act_history.description).toMatch(/from LexAPI's citation graph/);
    expect(byName.lex_act_history.description).not.toMatch(/as the Publications Office records them/);
  });

  it('every result carries the completeness caveat, also an empty list and a failed list', async () => {
    const caveat = /may be incomplete: an empty or short list is not proof that nothing changed/;
    const full = await call('lex_act_history', { celexNumber: '32006R1907' }, route({}));
    expect(full.data.completeness.note).toMatch(caveat);
    const empty = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ edges: { body: citedBy([]) } }));
    expect(empty.data.changes).toEqual({ repeals: [], amendments: [], corrigenda: [] });
    expect(empty.data.completeness.note).toMatch(caveat);
    const pending = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ edges: { body: citedBy([], { relationSync: { source: 'cellar', status: 'pending', syncedAt: null } }) } }));
    expect(pending.data.completeness.note).toMatch(caveat);
    const failed = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ edges: { status: 500, body: { success: false, code: 'INTERNAL', error: 'x' } } }));
    expect(failed.data.completeness.note).toMatch(caveat);
  });

  it('an act the API says does not exist is not shown as an act without changes', async () => {
    const { data, result } = await call('lex_act_history', { celexNumber: '32006R1970' }, (c) => (
      c.url.pathname.includes('/citations/cited-by/')
        ? { body: citedBy([], { targetDocument: '32006R1970' }) }
        : notFound('Document 32006R1970 does not exist on EUR-Lex')
    ));
    expect(result.isError).toBeFalsy();
    expect(data).toEqual({
      celex: '32006R1970', exists: false, inForce: 'unknown',
      basis: { exists: 'lex_get_metadata: LexAPI error 404 (NOT_FOUND): Document 32006R1970 does not exist on EUR-Lex' },
    });
    // Also when the relations call failed.
    const both = await call('lex_act_history', { celexNumber: '32006R1970' }, (c) => (
      c.url.pathname.includes('/citations/cited-by/') ? { status: 500, body: { success: false, code: 'INTERNAL', error: 'x' } } : notFound('Document 32006R1970 does not exist on EUR-Lex')
    ));
    expect(both.data.exists).toBe(false);
    expect(both.data.changes).toBeUndefined();
  });

  it('existence that was not confirmed is said: a failed, unreadable or mismatched metadata answer', async () => {
    const replies: Array<[Reply, string]> = [
      [{ status: 504, body: { success: false, error: { code: 'TIMEOUT', message: 'timed out' } } }, 'timeout'],
      [{ status: 404, raw: '<html>404</html>', headers: { 'content-type': 'text/html' } }, 'unconfirmed_not_found'],
      [{ body: { success: true } }, 'unreadable_response'],
      [{ body: metadata({ celex: '32016R0680', celexNumber: '32016R0680', title: 'Another act' }) }, 'different_document'],
    ];
    for (const [reply, reason] of replies) {
      const { data } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ act: reply }));
      expect(data.exists, reason).toBe('unknown');
      expect(data.inForce).toBe('unknown');
      expect(data.title).toBeUndefined();
      expect(data.incomplete[0]).toMatchObject({ call: 'lex_get_metadata', reason });
      expect(data.incomplete[0].part).toMatch(/whether it exists \(not confirmed\)/);
      expect(data.changes.amendments).toHaveLength(3);
    }
    const ok = await call('lex_act_history', { celexNumber: '32006R1907' }, route({}));
    expect(ok.data.exists).toBe(true);
  });

  it('an unreadable or empty 200 for the relations is a failed part, not "no changes"', async () => {
    const replies: Reply[] = [
      { raw: '' }, { raw: '<html>OK</html>', headers: { 'content-type': 'text/html' } }, { body: { success: true } },
      { body: { success: false, citedBy: [] } }, { body: { success: true, citedBy: 'none' } }, { body: [] },
    ];
    for (const edges of replies) {
      const { data, result } = await call('lex_act_history', { celexNumber: '32006R1907' }, route({ edges }));
      expect(result.isError).toBeFalsy();
      expect(data.changes).toBeUndefined();
      expect(data.title).toBe('REACH');
      expect(data.incomplete).toEqual([{
        part: 'the changes: amendments, corrigenda, repeals', call: 'lex_cited_by',
        reason: 'unreadable_response', error: 'the answer was not readable: it carried no citedBy list',
      }]);
    }
    // Both answers unreadable: still a result that says so, with nothing claimed.
    const both = await call('lex_act_history', { celexNumber: '32006R1907' }, () => ({ raw: '' }));
    expect(both.data).toMatchObject({ celex: '32006R1907', exists: 'unknown', inForce: 'unknown' });
    expect(both.data.changes).toBeUndefined();
    expect(both.data.incomplete.map((i: any) => i.reason)).toEqual(['unreadable_response', 'unreadable_response']);
  });

  it('a date is taken only from an answer about the listed act', async () => {
    const { data } = await call('lex_act_history', { celexNumber: '32006R1907', dates: 2 }, route({
      dated: (celex) => (celex === '32025R0100'
        ? { body: metadata({ celex: '32016R0679', celexNumber: '32016R0679', dateOfDocumentISO: '2016-04-27' }) }
        : { body: { success: true } }),
    }));
    expect(data.changes.repeals[0].date).toBeUndefined();
    expect(data.changes.repeals[0]).toMatchObject({ celex: '32025R0100', celexYear: 2025, dateNotRead: { reason: 'different_document' } });
    expect(data.changes.repeals[0].dateNotRead.error).toMatch(/32025R0100 was asked for and the answer is about 32016R0679/);
    expect(data.changes.amendments[0].dateNotRead.reason).toBe('unreadable_response');
    expect(data.counts.datesRead).toBeUndefined();
  });

  it('nothing obtained: the API error is returned as the error', async () => {
    const { result, text, calls } = await call('lex_act_history', { celexNumber: '32006R1907' }, () => exhausted(1));
    expect(result.isError).toBe(true);
    expect(text).toMatch(/LexAPI error 402 \(CREDITS_EXHAUSTED\)/);
    expect(calls).toHaveLength(1);
  });
});

describe('lex_research', () => {
  const legis = (n: number, extra: Record<string, unknown> = {}) => ({
    law_id: '32016R0679', article_ref: `art_${n}`, law_title: 'GDPR', score: 0.9 - n / 100, language: 'en', snippet: `EU article ${n}`, ...extra,
  });
  const euCase = (score: number) => ({
    case_name: 'Schrems II', case_number: 'C-311/18', ecli: 'ECLI:EU:C:2020:559', court: 'Court of Justice', decision_date: '2020-07-16',
    score, summary: 's'.repeat(900), metadata: { celex_id: '62018CJ0311', document_type: 'judgment' },
  });
  const ATTRIBUTION = 'Source: RIS, CC BY 4.0. Not the authentic text.';
  const natLegis = (code: string, score: number, extra: Record<string, unknown> = {}) => ({
    law_id: `${code}-NOR-1`, documentId: `${code}-NOR-1`, jurisdiction: code, article_ref: '§ 1', law_title: 'Datenschutzgesetz', score,
    snippet: 'Jedermann hat…', in_force: true, valid_from: '2018-05-25', valid_to: null, law_type: null, attribution: ATTRIBUTION,
    document: { id: `${code}-NOR-1`, jurisdiction: code, documentKind: 'act', title: 'Datenschutzgesetz', documentType: 'Bundesgesetz' }, ...extra,
  });
  const natCase = (code: string, score: number) => ({
    documentId: `${code}-JUD-1`, jurisdiction: code, score, court: 'OGH', case_number: '6 Ob 1/20', snippet: 'Der Kläger…', attribution: ATTRIBUTION,
    document: { id: `${code}-JUD-1`, jurisdiction: code, documentKind: 'decision', title: null, ecli: 'ECLI:AT:OGH0002:2020:1', dateOfDocument: '2020-03-01' },
  });
  const coverage = (rows: Array<[string, boolean]>) => ({
    updatedAt: '2026-11-17T00:00:00.000Z',
    jurisdictions: rows.map(([code, live]) => ({ code, name: code, live, semanticSearch: { legislation: true, caseLaw: true } })),
  });
  const kindOf = (c: Call) => (c.url.pathname.endsWith('/legislation/semantic') ? 'legislation' : 'case_law');
  const codeOf = (c: Call) => { const m = /\/api\/v1\/([a-z]{2})\//.exec(c.url.pathname); return m ? m[1] : 'eu'; };
  const allowance = { 'x-national-limit': '30', 'x-national-remaining': '27', 'x-national-reset': '2026-12-01T00:00:00.000Z' };

  it('default: EU legislation and EU case law, merged by score, with in-force labels', async () => {
    const { data, calls, paths } = await call('lex_research', { query: 'right to erasure' }, (c) => (kindOf(c) === 'legislation'
      ? { body: { success: true, results: [legis(1, { inForce: true }), legis(2, { law_id: '31995L0046', inForce: false, notInForceReason: 'no_longer_in_force', endOfValidity: '2018-05-24' }), legis(3)] } }
      : { body: { success: true, results: [euCase(0.885)] } }));
    expect(paths.sort()).toEqual(['/legislation/semantic', '/search/semantic']);
    expect(calls[0].body).toEqual({ query: 'right to erasure', limit: 5 });
    expect(data.searches).toEqual({ requested: 2, ok: 2 });
    expect(data.results.map((h: any) => [h.jurisdiction, h.kind, h.score])).toEqual([
      ['EU', 'legislation', 0.89], ['EU', 'case_law', 0.885], ['EU', 'legislation', 0.88], ['EU', 'legislation', 0.87],
    ]);
    expect(data.results[0]).toMatchObject({ law_id: '32016R0679', article_ref: 'art_1', inForce: true });
    expect(data.results[2]).toMatchObject({ law_id: '31995L0046', inForce: false, notInForceReason: 'no_longer_in_force', endOfValidity: '2018-05-24' });
    expect(data.results[3].inForce).toBe('unknown'); // no label on this hit
    expect(data.results[1]).toMatchObject({ celex: '62018CJ0311', ecli: 'ECLI:EU:C:2020:559' });
    expect(data.results[1].inForce).toBeUndefined(); // case law has no in-force status
    expect(data.results[1].summary.length).toBeLessThanOrEqual(500);
    expect(data.sources).toEqual([
      { jurisdiction: 'EU', kind: 'legislation', call: 'lex_semantic_legislation', status: 'ok', hits: 3 },
      { jurisdiction: 'EU', kind: 'case_law', call: 'lex_semantic_case_law', status: 'ok', hits: 1 },
    ]);
    expect(data.incomplete).toBeUndefined();
    expect(data.inForceNote).toMatch(/"unknown" means none was reported\. On an EU hit it is the act's/);
    expect(data.scoreNote).toMatch(/separate indexes/);
  });

  it('an API without the in-force fields: every EU legislation hit is unknown', async () => {
    const { data } = await call('lex_research', { query: 'right to erasure', kinds: ['legislation'] }, () => ({ body: { success: true, results: [legis(1), legis(2)] } }));
    expect(data.results.map((h: any) => h.inForce)).toEqual(['unknown', 'unknown']);
    expect(data.scoreNote).toBeUndefined();
  });

  it('national: only live countries are searched, hits keep attribution and the allowance is reported', async () => {
    const { data, calls, paths } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['EU', 'at', 'fr', 'xx'], kinds: ['legislation'], limit: 3, min_score: 0.5, language: 'de' }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true], ['FR', false]]) };
      return codeOf(c) === 'at'
        ? { body: { success: true, jurisdiction: 'AT', results: [natLegis('AT', 0.95), natLegis('AT', 0.6, { in_force: null })] }, headers: allowance }
        : { body: { success: true, results: [legis(1)] } };
    });
    expect(paths[0]).toBe('/national/coverage');
    expect(paths.slice(1).sort()).toEqual(['/at/legislation/semantic', '/legislation/semantic']); // nothing sent for FR or XX
    const at = calls.find((c) => codeOf(c) === 'at')!;
    expect(at.body).toEqual({ query: 'Datenschutz', limit: 3, min_score: 0.5 }); // the country's own language
    expect(calls.find((c) => c.url.pathname === '/api/v1/legislation/semantic')!.body).toEqual({ query: 'Datenschutz', limit: 3, min_score: 0.5, language: 'de' });
    expect(data.results[0]).toMatchObject({ jurisdiction: 'AT', kind: 'legislation', documentId: 'AT-NOR-1', inForce: true, valid_from: '2018-05-25', attribution: ATTRIBUTION });
    expect(data.results[0].in_force).toBeUndefined();
    expect(data.results[2]).toMatchObject({ jurisdiction: 'AT', inForce: 'unknown', attribution: ATTRIBUTION });
    expect(data.sources).toEqual([
      { jurisdiction: 'EU', kind: 'legislation', call: 'lex_semantic_legislation', status: 'ok', hits: 1 },
      { jurisdiction: 'AT', kind: 'legislation', call: 'lex_national_semantic_legislation', status: 'ok', hits: 2 },
      { jurisdiction: 'FR', kind: 'legislation', call: 'lex_national_semantic_legislation', status: 'not_run', reason: 'not_live', error: 'FR is listed by lex_national_coverage but not live' },
      { jurisdiction: 'XX', kind: 'legislation', call: 'lex_national_semantic_legislation', status: 'not_run', reason: 'not_listed', error: 'lex_national_coverage lists no country XX' },
    ]);
    expect(data.incomplete).toBe(true);
    expect(data.searches).toEqual({ requested: 4, ok: 2 });
    expect(data.allowance).toEqual({ limit: 30, remaining: 27, resetsAt: '2026-12-01T00:00:00.000Z' });
  });

  it('national case law and legislation of one country', async () => {
    const { data } = await call('lex_research', { query: 'Schadenersatz', jurisdictions: ['at'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true]]) };
      return kindOf(c) === 'legislation'
        ? { body: { success: true, results: [natLegis('AT', 0.8)] } }
        : { body: { success: true, results: [natCase('AT', 0.82)], partial: true, partialReason: 'SEARCH_INCOMPLETE', hint: 'Narrow the query.' } };
    });
    expect(data.results[0]).toMatchObject({ jurisdiction: 'AT', kind: 'case_law', documentId: 'AT-JUD-1', court: 'OGH', attribution: ATTRIBUTION });
    expect(data.results[0].inForce).toBeUndefined();
    expect(data.sources[1]).toEqual({
      jurisdiction: 'AT', kind: 'case_law', call: 'lex_national_semantic_case_law', status: 'ok', hits: 1,
      hint: 'Narrow the query.', partial: true, partialReason: 'SEARCH_INCOMPLETE',
    });
  });

  it('a plan gate on national law leaves the EU results in place', async () => {
    const { data, result } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['eu', 'at'], kinds: ['legislation'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true]]) };
      return codeOf(c) === 'at' ? tierForbidden() : { body: { success: true, results: [legis(1)] } };
    });
    expect(result.isError).toBeFalsy();
    expect(data.results).toHaveLength(1);
    expect(data.sources[1]).toEqual({
      jurisdiction: 'AT', kind: 'legislation', call: 'lex_national_semantic_legislation', status: 'failed',
      reason: 'plan', error: 'LexAPI error 403 (TIER_FORBIDDEN): National-law access is not included in your plan',
    });
    expect(data.incomplete).toBe(true);
    expect(data.stopped).toMatchObject({ reason: 'plan', scope: 'national searches' });
  });

  it('a plan refusal stops the remaining national searches', async () => {
    const { data, calls } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['eu', 'at', 'de', 'nl', 'es', 'cz', 'si', 'pl'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true], ['DE', true], ['NL', true], ['ES', true], ['CZ', true], ['SI', true], ['PL', true]]) };
      return codeOf(c) === 'eu' ? { body: { success: true, results: [legis(1)] } } : tierForbidden();
    });
    const national = data.sources.filter((s: any) => s.jurisdiction !== 'EU');
    expect(national).toHaveLength(14);
    expect(national.every((s: any) => s.status !== 'ok' && s.reason === 'plan')).toBe(true);
    expect(national.filter((s: any) => s.status === 'not_run').length).toBeGreaterThanOrEqual(11);
    // Fourteen national searches were asked for; only those already under way were sent.
    expect(calls.filter((c) => codeOf(c) !== 'eu' && !c.url.pathname.endsWith('/coverage')).length).toBeLessThanOrEqual(3);
    expect(data.sources.filter((s: any) => s.jurisdiction === 'EU').every((s: any) => s.status === 'ok')).toBe(true);
    expect(data.stopped).toMatchObject({ reason: 'plan', scope: 'national searches' });
  });

  it('a national hit without its own attribution takes the response\'s; a national decision keeps the inForce the API sent', async () => {
    const { data } = await call('lex_research', { query: 'Schadenersatz', jurisdictions: ['at'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true]]) };
      const bare = { ...natLegis('AT', 0.8), attribution: undefined };
      const bareCase = { ...natCase('AT', 0.7), attribution: null };
      return kindOf(c) === 'legislation'
        ? { body: { success: true, attribution: 'Source: RIS (response level).', results: [bare, natLegis('AT', 0.6)] } }
        : { body: { success: true, attribution: 'Source: RIS (response level).', results: [{ ...bareCase, validTo: '2020-01-01', inForce: false }, natCase('AT', 0.5)] } };
    });
    expect(data.results.map((h: any) => h.attribution)).toEqual(['Source: RIS (response level).', 'Source: RIS (response level).', ATTRIBUTION, ATTRIBUTION]);
    expect(data.results[1]).toMatchObject({ kind: 'case_law', inForce: false, validTo: '2020-01-01' });
    expect('inForce' in data.results[3]).toBe(false);
    expect(data.inForceNote).toMatch(/On a national hit it comes from the validity recorded in the national index for the matched text/);
    expect(data.inForceNote).not.toMatch(/for the act/);
    expect(byName.lex_research.description).toMatch(/a national decision carries inForce: false once its recorded end of validity has passed/);
  });

  it('the national allowance runs out: no further national search, EU unaffected', async () => {
    const { data, calls } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['at', 'de', 'nl', 'eu'], kinds: ['legislation'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true], ['DE', true], ['NL', true]]) };
      return codeOf(c) === 'eu' ? { body: { success: true, results: [legis(1)] } } : allowanceExhausted();
    });
    const national = data.sources.filter((s: any) => s.jurisdiction !== 'EU');
    expect(national.every((s: any) => s.status !== 'ok' && s.reason === 'national_allowance_exhausted')).toBe(true);
    expect(data.sources.find((s: any) => s.jurisdiction === 'EU')).toMatchObject({ status: 'ok', hits: 1 });
    expect(data.stopped).toMatchObject({ reason: 'national_allowance_exhausted', scope: 'national searches' });
    expect(data.stopped.detail).toMatch(/monthly allowance of national-law calls/);
    expect(calls.filter((c) => codeOf(c) !== 'eu' && !c.url.pathname.endsWith('/coverage')).length).toBeLessThanOrEqual(3);
  });

  it('credits run out midway: what was found is returned and nothing more is started', async () => {
    let served = 0;
    const { data, calls, result } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['eu', 'at', 'de', 'nl', 'es'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true], ['DE', true], ['NL', true], ['ES', true]]) };
      return served++ === 0 ? { body: { success: true, results: [legis(1)] } } : exhausted();
    });
    expect(result.isError).toBeFalsy();
    expect(data.results).toHaveLength(1);
    expect(data.searches).toEqual({ requested: 10, ok: 1 });
    expect(data.stopped.reason).toBe('credits_exhausted');
    expect(data.stopped.detail).toMatch(/LexAPI error 402/);
    // Ten searches were asked for; only those already under way got a request.
    expect(calls.length - 1).toBeLessThanOrEqual(4);
    const notRun = data.sources.filter((s: any) => s.status === 'not_run');
    expect(notRun.length).toBeGreaterThanOrEqual(6);
    expect(notRun.every((s: any) => s.reason === 'credits_exhausted' && /^not run/.test(s.error))).toBe(true);
    expect(data.sources.filter((s: any) => s.status === 'failed').every((s: any) => s.reason === 'credits_exhausted')).toBe(true);
  });

  it('a rate limit stops the remaining searches and gives the wait', async () => {
    const { data } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['eu', 'at', 'de', 'nl'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true], ['DE', true], ['NL', true]]) };
      return rateLimited();
    });
    expect(data.results).toEqual([]);
    expect(data.searches.ok).toBe(0);
    expect(data.stopped.reason).toBe('rate_limited');
    expect(data.sources.find((s: any) => s.status === 'failed')).toMatchObject({ reason: 'rate_limited', retryAfterSeconds: 30 });
    expect(data.sources.some((s: any) => s.status === 'not_run')).toBe(true);
  });

  it('a country without semantic search, an unavailable index and a failed coverage call are each reported', async () => {
    const { data } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['at', 'cz'], kinds: ['legislation'] }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'coverage failed' } } };
      return codeOf(c) === 'cz'
        ? { status: 409, body: { success: false, code: 'NATIONAL_SEMANTIC_NOT_ENABLED', error: 'Semantic search is not enabled for CZ', jurisdiction: 'CZ' } }
        : { status: 422, body: { success: false, code: 'NATIONAL_SEMANTIC_FILTER_UNREACHABLE', error: 'The index cannot search this slice', jurisdiction: 'AT' } };
    });
    expect(data.coverage).toMatchObject({ call: 'lex_national_coverage', reason: 'upstream_error' });
    expect(data.sources[0]).toMatchObject({ jurisdiction: 'AT', status: 'failed', reason: 'search_incomplete' });
    expect(data.sources[1]).toMatchObject({ jurisdiction: 'CZ', status: 'failed', reason: 'semantic_not_enabled' });
    expect(data.results).toEqual([]);
    expect(data.incomplete).toBe(true);
  });

  it('an unreadable or empty 200 is a failed search, not "ok, 0 hits"', async () => {
    const replies: Reply[] = [
      { raw: '' }, { raw: '<html>OK</html>', headers: { 'content-type': 'text/html' } }, { body: { success: true } },
      { body: { success: false, results: [] } }, { body: { results: {} } }, { body: [] },
    ];
    for (const reply of replies) {
      const { data } = await call('lex_research', { query: 'right to erasure' }, (c) => (kindOf(c) === 'legislation' ? reply : { body: { success: true, results: [euCase(0.8)] } }));
      expect(data.sources[0]).toEqual({
        jurisdiction: 'EU', kind: 'legislation', call: 'lex_semantic_legislation', status: 'failed',
        reason: 'unreadable_response', error: 'the answer was not readable: it carried no results list',
      });
      expect(data.sources[1]).toMatchObject({ status: 'ok', hits: 1 });
      expect(data.searches).toEqual({ requested: 2, ok: 1 });
      expect(data.incomplete).toBe(true);
    }
    const empty = await call('lex_research', { query: 'right to erasure', kinds: ['legislation'] }, () => ({ body: { success: true, results: [] } }));
    expect(empty.data.sources[0]).toMatchObject({ status: 'ok', hits: 0 });
  });

  it('a full text an answer carries is bounded like the snippet', async () => {
    const { data, text } = await call('lex_research', { query: 'right to erasure' }, (c) => (kindOf(c) === 'legislation'
      ? { body: { success: true, results: [legis(1, { text: 'T'.repeat(200_000) })] } }
      : { body: { success: true, results: [{ ...euCase(0.8), text: 'J'.repeat(200_000) }] } }));
    expect(data.results).toHaveLength(2);
    for (const h of data.results) expect(h.text.length).toBeLessThanOrEqual(500);
    expect(text.length).toBeLessThan(5_000);
  });

  it('rows that are not objects do not become hits', async () => {
    const { data } = await call('lex_research', { query: 'right to erasure', kinds: ['legislation'] }, () => ({ body: { success: true, results: [null, 'x', 7, [], legis(1)] } }));
    expect(data.results).toHaveLength(1);
    expect(data.results[0].law_id).toBe('32016R0679');
    expect(data.sources[0]).toMatchObject({ status: 'ok', hits: 1, unreadableRows: 4 });
  });

  it('a coverage answer of an unexpected shape is a coverage failure, not "no such country"', async () => {
    for (const cov of [{ raw: '' }, { body: { success: true } }, { body: { jurisdictions: 'AT' } }] as Reply[]) {
      const { data, paths } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['at'], kinds: ['legislation'] }, (c) => (
        c.url.pathname.endsWith('/national/coverage') ? cov : { body: { success: true, results: [natLegis('AT', 0.8)] } }
      ));
      expect(data.coverage).toMatchObject({ call: 'lex_national_coverage', reason: 'unreadable_response' });
      expect(paths).toEqual(['/national/coverage', '/at/legislation/semantic']);
      expect(data.sources[0]).toMatchObject({ jurisdiction: 'AT', status: 'ok', hits: 1 });
    }
  });

  it('a search that was not started for lack of time is reported as not run', async () => {
    const start = Date.now();
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { data, calls } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['at'] }, () => {
      now = start + 54_000; // the coverage answer arrives with one second of the deadline left
      return { body: coverage([['AT', true]]) };
    });
    expect(calls).toHaveLength(1);
    expect(data.results).toEqual([]);
    expect(data.sources.map((s: any) => [s.status, s.reason])).toEqual([['not_run', 'timeout'], ['not_run', 'timeout']]);
    expect(data.sources[0].error).toBe('not run: the time available to this tool call was used up');
    expect(data.incomplete).toBe(true);
  });

  it('a very large merged list is cut at the lowest scores, and says so', async () => {
    const long = 'A'.repeat(4000);
    const { data, text } = await call('lex_research', { query: 'Datenschutz', jurisdictions: ['at'], kinds: ['legislation'], limit: 20 }, (c) => {
      if (c.url.pathname.endsWith('/national/coverage')) return { body: coverage([['AT', true]]) };
      return { body: { success: true, results: Array.from({ length: 20 }, (_, i) => natLegis('AT', 0.9 - i / 100, { attribution: long })) } };
    });
    expect(data.sources[0].hits).toBe(20);
    expect(data.results.length).toBeLessThan(20);
    expect(data.omitted).toMatch(/lower-scored hits left out/);
    expect(data.results[0].score).toBe(0.9);
    expect(text.length).toBeLessThan(70_000);
  });

  it('a bad key ends the call', async () => {
    const { result, text } = await call('lex_research', { query: 'right to erasure' }, () => ({ status: 401, body: { error: 'Invalid API key' } }));
    expect(result.isError).toBe(true);
    expect(text).toMatch(/LexAPI error 401/);
  });
});
