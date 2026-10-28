import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runTool } from '../src/server.js';
import { selectTools, tools, type ToolDef } from '../src/tools.js';
import { clientWith, parseText } from './helpers.js';

const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;

/** Validate args the way the MCP SDK does (defaults applied), then run. */
async function call(name: string, args: Record<string, unknown>, reply: Parameters<typeof clientWith>[0]) {
  const tool = byName[name];
  const parsed = z.object(tool.inputSchema).parse(args);
  const { client, calls } = clientWith(reply);
  const result = await runTool(tool, parsed, client);
  return { result, calls, data: result.isError ? undefined : parseText(result) };
}

const NATIONAL_TOOLS = [
  'lex_national_coverage',
  'lex_list_national_documents',
  'lex_get_national_document',
  'lex_national_semantic_case_law',
  'lex_national_semantic_legislation',
];

describe('national-law tools', () => {
  it('are registered and read-only (visible in read-only mode)', () => {
    const ro = selectTools({ readOnly: true }).map((t) => t.name);
    for (const name of NATIONAL_TOOLS) {
      expect(byName[name], name).toBeDefined();
      expect(ro, name).toContain(name);
      expect(byName[name].annotations.readOnlyHint, name).toBe(true);
    }
  });

  it('say to call lex_national_coverage first, and state their cost (except the coverage tool itself)', () => {
    expect(byName.lex_national_coverage.description).toMatch(/call this before any other national tool/i);
    for (const name of NATIONAL_TOOLS.filter((n) => n !== 'lex_national_coverage')) {
      const d = byName[name].description;
      expect(d, name).toMatch(/lex_national_coverage/);
      expect(d, name).toMatch(/not yet live/i);
      expect(d, name).toMatch(/[Cc]ost/);
    }
  });
});

describe('lex_national_coverage', () => {
  it('GETs /national/coverage and returns it close to verbatim, keeping sources/attribution', async () => {
    const body = {
      updatedAt: '2026-10-28T00:00:00.000Z',
      jurisdictions: [
        {
          code: 'AT', name: 'Austria', live: true, launchedAt: '2026-11-03T00:00:00.000Z',
          legislation: { available: true, documents: 1200, from: '1945-01-01' },
          caseLaw: { available: true, documents: 300, from: '2010-01-01', courts: ['OGH'] },
          semanticSearch: { legislation: true, caseLaw: true },
          sources: [{ name: 'RIS', url: 'https://ris.bka.gv.at', licence: 'CC BY 4.0', attribution: 'Data source: RIS, Bundeskanzleramt Österreich.' }],
          lastSyncAt: '2026-10-27T00:00:00.000Z',
        },
        { code: 'ES', name: 'Spain', live: false, launchedAt: null, legislation: { available: false }, caseLaw: { available: false }, semanticSearch: { legislation: false, caseLaw: false }, sources: [], lastSyncAt: null },
      ],
    };
    const { calls, data } = await call('lex_national_coverage', {}, () => ({ body }));
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.pathname).toBe('/api/v1/national/coverage');
    expect(data.jurisdictions[0].sources[0].attribution).toMatch(/RIS/);
    expect(data.jurisdictions[0].sources[0].licence).toBe('CC BY 4.0');
    expect(data.jurisdictions).toHaveLength(2);
  });
});

describe('lex_list_national_documents', () => {
  it('maps documentType to the wire "type" param and shapes results', async () => {
    const { calls, data } = await call('lex_list_national_documents', {
      jurisdiction: 'AT', q: 'data protection', documentType: 'Act', page: 2, limit: 10,
    }, () => ({
      body: {
        jurisdiction: 'AT', total: 1, page: 2, limit: 10, includeRepealed: false,
        results: [{ id: 'AT-NOR-1', jurisdiction: 'AT', language: 'de', title: 'Datenschutzgesetz', documentType: 'Act', version: 1, fetchedAt: '2026-10-01T00:00:00.000Z' }],
      },
      headers: { 'x-national-limit': '30', 'x-national-remaining': '29', 'x-national-reset': '2026-11-01T00:00:00.000Z' },
    }));
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.pathname).toBe('/api/v1/at/documents');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ q: 'data protection', type: 'Act', page: '2', limit: '10' });
    expect(data.total).toBe(1);
    expect(data.results[0]).toMatchObject({ id: 'AT-NOR-1', title: 'Datenschutzgesetz' });
    expect(data.allowance).toEqual({ limit: 30, remaining: 29, resetsAt: '2026-11-01T00:00:00.000Z' });
  });

  it('lower-cases the jurisdiction in the URL', async () => {
    const { calls } = await call('lex_list_national_documents', { jurisdiction: 'DE' }, () => ({ body: { results: [] } }));
    expect(calls[0].url.pathname).toBe('/api/v1/de/documents');
  });

  it('omits allowance when the plan has no separate limit (BUSINESS+: headers absent)', async () => {
    const { data } = await call('lex_list_national_documents', { jurisdiction: 'AT' }, () => ({ body: { results: [] } }));
    expect(data).not.toHaveProperty('allowance');
  });

  it('cursor paging (lex-api PR #320): sends cursor instead of page, keeps nextCursor/hasMore/totalExact, and nextCursor: null is not dropped by compact', async () => {
    const { calls, data } = await call('lex_list_national_documents', {
      jurisdiction: 'at', cursor: 'abc123', limit: 50,
    }, () => ({
      body: {
        jurisdiction: 'AT', total: 1200, totalExact: false, limit: 50, includeRepealed: false,
        hasMore: false, nextCursor: null, results: [],
      },
    }));
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ cursor: 'abc123', limit: '50' });
    expect(calls[0].url.searchParams.has('page')).toBe(false);
    expect(data.totalExact).toBe(false);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
  });

  it('a page is dropped from the query when cursor is also given', async () => {
    const { calls } = await call('lex_list_national_documents', {
      jurisdiction: 'at', page: 3, cursor: 'c1',
    }, () => ({ body: { results: [] } }));
    expect(calls[0].url.searchParams.has('page')).toBe(false);
    expect(calls[0].url.searchParams.get('cursor')).toBe('c1');
  });

  it('q shorter than 3 characters is rejected by the schema itself (no network call)', () => {
    const tool = byName.lex_list_national_documents;
    const result = z.object(tool.inputSchema).safeParse({ jurisdiction: 'at', q: 'ab' });
    expect(result.success).toBe(false);
  });
});

describe('a national document its source withdrew (410 DOCUMENT_WITHDRAWN, lex-api PR #320)', () => {
  it('typed envelope on lex_get_national_document: not retryable, says to drop any copy', async () => {
    const { result } = await call('lex_get_national_document', { jurisdiction: 'at', id: 'AT-NOR-5' }, () => ({
      status: 410,
      body: {
        success: false,
        error: {
          code: 'DOCUMENT_WITHDRAWN',
          message: 'AT document AT-NOR-5 was withdrawn by its source and is no longer served',
          details: { id: 'AT-NOR-5', jurisdiction: 'AT', withdrawnAt: '2026-10-20T00:00:00.000Z' },
        },
      },
    }));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/withdrawn/i);
    expect(text).toMatch(/do not retry/i);
    expect(text).toMatch(/drop it/i);
    expect(text).not.toMatch(/lex_resolve/);
  });

  it('legacy shape on a citation tool (id/jurisdiction/withdrawnAt as top-level siblings)', async () => {
    const { result } = await call('lex_cited_by', { celexNumber: 'AT-NOR-5' }, () => ({
      status: 410,
      body: {
        success: false,
        code: 'DOCUMENT_WITHDRAWN',
        error: 'Document withdrawn: AT-NOR-5',
        message: 'AT document AT-NOR-5 was withdrawn by its source and is no longer served.',
        id: 'AT-NOR-5',
        jurisdiction: 'AT',
        withdrawnAt: '2026-10-20T00:00:00.000Z',
      },
    }));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/withdrawn/i);
    expect(text).toMatch(/AT/);
  });
});

describe('lex_get_national_document', () => {
  it('fetches one document, keeps attribution, and bounds content', async () => {
    const { calls, data } = await call('lex_get_national_document', { jurisdiction: 'at', id: 'AT-NOR-1', language: 'de' }, () => ({
      body: {
        document: {
          id: 'AT-NOR-1', jurisdiction: 'AT', language: 'de', title: 'Datenschutzgesetz', documentType: 'Act',
          version: 2, fetchedAt: '2026-10-01T00:00:00.000Z', inForce: true,
          content: { fullText: 'x'.repeat(200), articles: [{ id: 'art_1', number: 'Art. 1', content: 'y'.repeat(50) }], recitals: [], paragraphs: [], sections: [], tables: [], annexes: [] },
          textAvailability: { available: true },
          attribution: 'Data source: RIS, Bundeskanzleramt Österreich (data.bka.gv.at), CC BY 4.0.',
        },
      },
      headers: { 'x-national-limit': '30', 'x-national-remaining': '29', 'x-national-reset': '2026-11-01T00:00:00.000Z' },
    }));
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.pathname).toBe('/api/v1/at/documents/AT-NOR-1');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ language: 'de' });
    expect(data.id).toBe('AT-NOR-1');
    expect(data.attribution).toMatch(/RIS/);
    expect(data.allowance.remaining).toBe(29);
  });

  it('a text-unavailable document keeps content: null and textAvailability', async () => {
    const { data } = await call('lex_get_national_document', { jurisdiction: 'nl', id: 'NL-1' }, () => ({
      body: {
        document: {
          id: 'NL-1', jurisdiction: 'NL', title: 'Regeling X', content: null,
          textAvailability: { available: false, reason: 'unknown' },
          attribution: 'Sources: Basiswettenbestand, KOOP — public domain (CC0).',
        },
      },
    }));
    expect(data.content).toBeNull();
    expect(data.textAvailability).toEqual({ available: false, reason: 'unknown' });
    expect(data.attribution).toMatch(/CC0/);
  });
});

describe('lex_national_semantic_case_law', () => {
  it('sends jurisdiction, filters and hyde, and keeps attribution on each hit', async () => {
    const { calls, data } = await call('lex_national_semantic_case_law', {
      jurisdiction: 'at', query: 'data protection fine', hyde: true, filters: { court: 'OGH' },
    }, () => ({
      body: {
        success: true, searchType: 'semantic-case-law', jurisdiction: 'AT', resultCount: 1, hyde: false,
        results: [{
          documentId: 'AT-JUD-OGH-1', jurisdiction: 'AT', score: 0.81, case_name: 'X v Y', court: 'OGH',
          snippet: 'Der Oberste Gerichtshof …', attribution: 'Data source: RIS, Bundeskanzleramt Österreich.',
        }],
        attribution: 'Data source: RIS, Bundeskanzleramt Österreich.',
      },
    }));
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.pathname).toBe('/api/v1/at/search/semantic');
    expect(calls[0].body).toMatchObject({ query: 'data protection fine', limit: 10, hyde: true, filters: { court: 'OGH' } });
    expect(data.hyde).toBe(false);
    expect(data.results[0].documentId).toBe('AT-JUD-OGH-1');
    expect(data.results[0].attribution).toMatch(/RIS/);
  });

  it('rejects case_number in filters (not available nationally)', () => {
    const tool = byName.lex_national_semantic_case_law;
    expect(() => z.object(tool.inputSchema).parse({
      jurisdiction: 'at', query: 'abc', filters: { case_number: 'C-1/23' },
    })).toThrow();
  });
});

describe('lex_national_semantic_legislation', () => {
  it('sends jurisdiction and friendly filter names, keeps attribution', async () => {
    const { calls, data } = await call('lex_national_semantic_legislation', {
      jurisdiction: 'DE', query: 'Datenschutz', filters: { inForce: true },
    }, () => ({
      body: {
        success: true, searchType: 'semantic-legislation', jurisdiction: 'DE', resultCount: 1,
        results: [{ law_id: 'DE-1', documentId: 'DE-1', jurisdiction: 'DE', article_ref: 'art_1', score: 0.7, snippet: 's', attribution: 'Source: gesetze-im-internet.de.' }],
        attribution: 'Source: gesetze-im-internet.de.',
      },
    }));
    expect(calls[0].url.pathname).toBe('/api/v1/de/legislation/semantic');
    expect(calls[0].body).toMatchObject({ query: 'Datenschutz', limit: 10, filters: { inForce: true } });
    expect(data.results[0]).toMatchObject({ law_id: 'DE-1', attribution: 'Source: gesetze-im-internet.de.' });
  });

  it('has no asOf parameter', () => {
    expect(byName.lex_national_semantic_legislation.inputSchema).not.toHaveProperty('asOf');
  });
});

describe('a used-up national-law allowance (402 NATIONAL_ALLOWANCE_EXHAUSTED)', () => {
  it('is reported as the allowance, not the credit pool, and is not confused with CREDITS_EXHAUSTED', async () => {
    const { result } = await call('lex_list_national_documents', { jurisdiction: 'at' }, () => ({
      status: 402,
      headers: { 'x-national-limit': '30', 'x-national-remaining': '0', 'x-national-reset': '2026-11-01T00:00:00.000Z' },
      body: {
        success: false,
        error: {
          code: 'NATIONAL_ALLOWANCE_EXHAUSTED',
          message: "This month's national-law allowance of 30 calls on the FREE plan is used up.",
          details: { jurisdiction: 'AT', limit: 30, remaining: 0, resetsAt: '2026-11-01T00:00:00.000Z', upgradeUrl: '/pricing' },
        },
      },
    }));
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/monthly allowance of national-law calls/);
    expect(text).toMatch(/not the LexAPI credit pool/);
    expect(text).toMatch(/2026-11-01/);
    expect(text).toMatch(/does not help/);
  });
});

describe('national semantic search: country-level errors (not account errors)', () => {
  it('409 NATIONAL_SEMANTIC_NOT_ENABLED (legacy shape, top-level code/jurisdiction) points at the right tools, not lex_resolve/lex_search', async () => {
    const { result } = await call('lex_national_semantic_case_law', { jurisdiction: 'at', query: 'Datenschutz' }, () => ({
      status: 409,
      body: {
        error: 'National semantic search not enabled',
        code: 'NATIONAL_SEMANTIC_NOT_ENABLED',
        jurisdiction: 'AT',
        message: 'Semantic search over Austria (AT) is not enabled yet. No credits were charged.',
      },
    }));
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/not available for AT/);
    expect(text).toMatch(/lex_national_coverage/);
    expect(text).toMatch(/lex_list_national_documents/);
    expect(text).toMatch(/lex_get_national_document/);
    expect(text).not.toMatch(/lex_resolve/);
    expect(text).not.toMatch(/lex_search\b/);
    expect(text).toMatch(/nothing was charged/i);
  });

  it('503 NATIONAL_SEMANTIC_UNAVAILABLE names the country and says to retry with backoff', async () => {
    const { result } = await call('lex_national_semantic_legislation', { jurisdiction: 'de', query: 'Datenschutz' }, () => ({
      status: 503,
      body: {
        error: 'National semantic index unavailable',
        code: 'NATIONAL_SEMANTIC_UNAVAILABLE',
        jurisdiction: 'DE',
        message: 'The Germany (DE) semantic index is temporarily unavailable. No credits were charged. Please try again later.',
      },
    }));
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/DE'?s national semantic index is temporarily unavailable/);
    expect(text).toMatch(/[Rr]etry later/);
    expect(text).toMatch(/backoff/);
  });

  it('a 409/503 without a national code falls back to the pre-existing generic text', async () => {
    const conflict = await call('lex_list_national_documents', { jurisdiction: 'at' }, () => ({
      status: 409, body: { error: 'conflict', message: 'some other 409' },
    }));
    expect(conflict.result.content[0].text).toMatch(/account's current state/);

    const unavailable = await call('lex_list_national_documents', { jurisdiction: 'at' }, () => ({
      status: 503, body: { error: 'maintenance', message: 'down for maintenance' },
    }));
    expect(unavailable.result.content[0].text).toMatch(/LexAPI had a server error/);
  });
});

describe('national 404s point at the national tools, never lex_resolve/lex_search', () => {
  it('a country that is not live yet: the generic "Unknown API endpoint" 404', async () => {
    const { result } = await call('lex_get_national_document', { jurisdiction: 'es', id: 'ES-NOR-1' }, () => ({
      status: 404,
      body: {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Unknown API endpoint: GET /api/v1/es/documents/ES-NOR-1. See https://lex-api.com/docs for the endpoint reference.' },
      },
    }));
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/lex_national_coverage/);
    expect(text).not.toMatch(/lex_resolve/);
    expect(text).not.toMatch(/lex_search\b/);
  });

  it('an unknown id in a live country: the typed {id, jurisdiction} 404', async () => {
    const { result } = await call('lex_get_national_document', { jurisdiction: 'at', id: 'AT-NOR-999999' }, () => ({
      status: 404,
      body: { error: 'Document not found', code: 'NOT_FOUND', id: 'AT-NOR-999999', jurisdiction: 'AT' },
    }));
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/lex_list_national_documents/);
    expect(text).not.toMatch(/lex_resolve/);
    expect(text).not.toMatch(/lex_search\b/);
  });
});

describe('schema-level rejections (no network call)', () => {
  it('lex_national_semantic_legislation rejects a 1-2 character query', () => {
    const tool = byName.lex_national_semantic_legislation;
    expect(() => z.object(tool.inputSchema).parse({ jurisdiction: 'at', query: 'ab' })).toThrow();
    expect(() => z.object(tool.inputSchema).parse({ jurisdiction: 'at', query: 'abc' })).not.toThrow();
  });
});
