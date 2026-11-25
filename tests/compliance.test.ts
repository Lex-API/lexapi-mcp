// lex_compliance_checklist and the MCP prompts (#412 prototype).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOPICS } from '../src/compliance.js';
import { createLexServer, runTool } from '../src/server.js';
import { tools, type ToolDef } from '../src/tools.js';
import { clientWith, parseText, type Call } from './helpers.js';

const tool = tools.find((t) => t.name === 'lex_compliance_checklist') as ToolDef;
const path = (c: Call) => c.url.pathname.replace('/api/v1', '');

const coverage = (live = true) => ({ body: { success: true, jurisdictions: [{ code: 'SI', live, sources: [{ attribution: 'Vir: PISRS, CC BY 4.0' }] }] } });

function happy(c: Call) {
  const p = path(c);
  if (p === '/national/coverage') return coverage();
  if (p.startsWith('/citations/transposition/')) {
    return { body: { success: true, document: { title: 'Directive X' }, source: { cellar: { attribution: 'Publications Office' } }, jurisdictions: [{ jurisdiction: 'SI', measures: [{ id: 'SI-PRED-ZAKO5944', title: 'ZDR-1', officialJournal: { name: 'Uradni list RS', number: '21/2013', date: '2013-03-13' }, cellar: { dateNotification: '2014-05-10' } }] }] } };
  }
  if (p.startsWith('/citations/cited-by/')) {
    return { body: { success: true, citedBy: [
      // The API's shape: one group per citing document, its edges under citations.
      { celexNumber: '32010L0001', title: 'old', citations: [{ citationType: 'amendment' }] },
      { celexNumber: '32024L0002', title: 'new', citations: [{ citationType: 'amendment' }] },
      { celexNumber: '32019L1152R(01)', citations: [{ citationType: 'corrigendum' }] },
    ], relationSync: { status: 'refreshed' } } };
  }
  if (p === '/si/legislation/semantic') {
    return { body: { success: true, results: [{ law_id: 'SI-PRED-ZAKO5944', law_title: 'ZDR-1', article_ref: '31', score: 0.8, in_force: true, text: 'Pogodba o zaposlitvi mora vsebovati ...' }] } };
  }
  return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'x' } } };
}

async function run(args: Record<string, unknown>, reply: (c: Call) => unknown) {
  const { client, calls } = clientWith(reply as never, { maxRetries: 0 });
  const result = await runTool(tool, z.object(tool.inputSchema).parse(args), client);
  return { result, calls, data: result.isError ? undefined : parseText(result) };
}

describe('lex_compliance_checklist', () => {
  it('collects acts, notified measures, recorded changes and national provisions', async () => {
    const { data, calls } = await run({ topic: 'employment_contract', jurisdiction: 'SI' }, happy);
    const t = TOPICS.employment_contract;
    expect(calls.filter((c) => path(c).startsWith('/citations/transposition/'))).toHaveLength(t.acts.length);
    expect(calls.filter((c) => path(c) === '/si/legislation/semantic')).toHaveLength(t.nationalQueries.si.length);
    expect(data.jurisdiction).toBe('SI');
    expect(data.euActs[0].notifiedMeasures.shown[0]).toMatchObject({ id: 'SI-PRED-ZAKO5944', officialJournal: 'Uradni list RS 21/2013', notified: '2014-05-10' });
    expect(data.euActs[0].recordedChanges.amendments.newest.map((e: { celex: string }) => e.celex)).toEqual(['32024L0002', '32010L0001']);
    expect(data.euActs[0].recordedChanges.corrigenda).toBe(1);
    // One provision found by every search is listed once, with every query that found it.
    expect(data.nationalProvisions).toHaveLength(1);
    expect(data.nationalProvisions[0].matchedQueries).toHaveLength(t.nationalQueries.si.length);
    expect(data.nationalSearch.queryLanguage).toBe('national');
    expect(data.nationalAttribution).toEqual(['Vir: PISRS, CC BY 4.0']);
    expect(data.incomplete).toBeUndefined();
  });

  it('a country without its own searches falls back to English ones; focus runs first', async () => {
    const reply = (c: Call) => (path(c) === '/national/coverage'
      ? { body: { success: true, jurisdictions: [{ code: 'AT', live: true }] } }
      : path(c) === '/at/legislation/semantic' ? { body: { success: true, results: [] } } : happy(c));
    const { data, calls } = await run({ topic: 'gdpr', jurisdiction: 'at', focus: 'Videoüberwachung' }, reply);
    expect(data.nationalSearch.queryLanguage).toBe('english_fallback');
    expect(data.nationalSearch.queries[0]).toBe('Videoüberwachung');
    expect((calls.find((c) => path(c) === '/at/legislation/semantic')?.body as { query: string }).query).toBe('Videoüberwachung');
  });

  it('a country that is not live: national calls are not run, EU changes still are', async () => {
    const { data, calls } = await run({ topic: 'nis2', jurisdiction: 'si' }, (c) => (path(c) === '/national/coverage' ? coverage(false) : happy(c)));
    expect(calls.some((c) => path(c).startsWith('/citations/transposition/') || path(c).endsWith('/legislation/semantic'))).toBe(false);
    expect(data.incomplete).toBe(true);
    expect(data.sources.filter((s: { status: string }) => s.status === 'not_run').every((s: { reason: string }) => s.reason === 'not_live')).toBe(true);
    expect(data.euActs[0].recordedChanges).toBeDefined();
  });

  it('once credits run out no further call starts, and the stop is named', async () => {
    let n = 0;
    const reply = (c: Call) => {
      if (path(c) === '/national/coverage') return coverage();
      n++;
      return n === 1 ? happy(c) : { status: 402, body: { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted' } } };
    };
    const { data } = await run({ topic: 'gdpr', jurisdiction: 'si' }, reply);
    expect(data.stopped.reason).toBe('credits_exhausted');
    expect(data.sources.some((s: { status: string }) => s.status === 'not_run')).toBe(true);
  });
});

describe('prompts', () => {
  async function connect(opts = {}) {
    const { client: api } = clientWith(happy as never);
    const server = createLexServer(api, opts);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(b);
    return c;
  }

  it('lists the three prompts, and each names the checklist, its topic and the disclaimer', async () => {
    const c = await connect();
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['check_gdpr_documentation', 'check_nis2_applicability', 'review_employment_contract']);
    const topics: Record<string, string> = { review_employment_contract: 'employment_contract', check_gdpr_documentation: 'gdpr', check_nis2_applicability: 'nis2' };
    for (const [name, topic] of Object.entries(topics)) {
      const p = await c.getPrompt({ name, arguments: {} });
      const text = (p.messages[0].content as { text: string }).text;
      expect(text).toContain(`topic "${topic}" and jurisdiction "si"`);
      expect(text).toContain('not legal advice');
      expect(text).toContain('does not establish that anyone complies');
    }
  });

  it('takes the jurisdiction and the user\'s text as given; a bad code falls back to si', async () => {
    const c = await connect();
    const at = await c.getPrompt({ name: 'review_employment_contract', arguments: { jurisdiction: 'AT', contract: 'Dienstvertrag …' } });
    const text = (at.messages[0].content as { text: string }).text;
    expect(text).toContain('jurisdiction "at"');
    expect(text).toContain('Dienstvertrag …');
    const bad = await c.getPrompt({ name: 'check_nis2_applicability', arguments: { jurisdiction: 'slovenia' } });
    expect((bad.messages[0].content as { text: string }).text).toContain('jurisdiction "si"');
  });

  it('an OAuth connection without lex:read gets no prompts', async () => {
    const c = await connect({ scopes: new Set(['lex:webhooks']) });
    expect(c.getServerCapabilities()?.prompts).toBeDefined();
    expect((await c.listPrompts()).prompts).toEqual([]);
  });
});
