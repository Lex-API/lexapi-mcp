import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runTool } from '../src/server.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';
import { tools, type ToolDef } from '../src/tools.js';
import { clientWith, parseText } from './helpers.js';

const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;

async function call(name: string, args: Record<string, unknown>, reply: Parameters<typeof clientWith>[0]) {
  const tool = byName[name];
  const parsed = z.object(tool.inputSchema).parse(args);
  const { client, calls } = clientWith(reply);
  const result = await runTool(tool, parsed, client);
  return { result, calls, data: result.isError ? undefined : parseText(result), text: result.content[0].text as string };
}

const ok = (name: string, args: unknown) => z.object(byName[name].inputSchema).safeParse(args).success;

const NOTE = 'Measures are those the member state notified to the Commission for this act. A notification is not a finding that the measure transposes the act, or transposes it completely.';

function measure(overrides: Record<string, unknown> = {}) {
  return {
    id: null, resolved: null, resolution: null, resolutionBasis: null,
    provenance: 'cellar-nim', citationType: 'transposition',
    title: 'Ley Orgánica 7/2021, de 26 de mayo', typeAct: 'Ley Orgánica',
    officialJournal: { name: 'Boletín Oficial del Estado', number: '126/2021', date: '2021-05-27' },
    reference: 'BOE-A-2021-8806', eli: null, link: 'https://www.boe.es/x.pdf',
    cellar: { id: 'cellar-uuid', celex: '72016L0680ESP_202101234', commissionReference: null, dateDocument: '2021-05-27', dateNotification: '2021-06-02', entryIntoForce: '2021-06-16' },
    ...overrides,
  };
}

function transpositionBody(countries: Array<{ code: string; n: number; live?: boolean }>, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    document: { id: '32016L0680', celexNumber: '32016L0680', jurisdiction: 'EU', documentKind: 'act', title: 'Directive (EU) 2016/680' },
    source: { cellar: { syncedAt: '2026-12-01T03:10:00.000Z', measures: 333, attribution: 'Source: Publications Office of the European Union' }, lanes: null },
    note: NOTE,
    jurisdictions: countries.map((c) => ({
      jurisdiction: c.code,
      live: c.live ?? false,
      counts: { measures: c.n, resolved: null },
      measures: Array.from({ length: c.n }, (_, i) => measure({ reference: `${c.code}-${i}` })),
    })),
    truncated: false,
    credits: { remaining: 9000, limit: 10000 },
    ...extra,
  };
}

describe('graph filters (API 2.11.0)', () => {
  it('serialise as comma-separated lists, from an array, one value or "a,b"', async () => {
    const { calls } = await call('lex_cited_by', {
      celexNumber: '32016R0679',
      citationType: ['amendment', 'repeal'],
      provenance: 'cellar,notice+cellar',
      jurisdictions: ['EU', 'at'],
      resolution: 'id',
    }, () => ({ body: { success: true, targetDocument: '32016R0679', citedBy: [] } }));
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      citationType: 'amendment,repeal',
      provenance: 'cellar,notice+cellar',
      jurisdictions: 'eu,at',
      resolution: 'id',
      limit: '50',
      offset: '0',
    });
  });

  it('a single citationType is still sent as before', async () => {
    const { calls } = await call('lex_cites', { celexNumber: '32016R0679', citationType: 'transposition' }, () => ({
      body: { success: true, sourceDocument: '32016R0679', cites: [] },
    }));
    expect(calls[0].url.searchParams.get('citationType')).toBe('transposition');
  });

  it('validates values before any call', () => {
    expect(ok('lex_cited_by', { celexNumber: '32016L0680', citationType: 'transposition' })).toBe(true);
    expect(ok('lex_cited_by', { celexNumber: '32016L0680', citationType: 'cites' })).toBe(false); // gone since API 2.10.0
    expect(ok('lex_cited_by', { celexNumber: '32016L0680', citationType: [] })).toBe(false);
    expect(ok('lex_cites', { celexNumber: '32016L0680', provenance: ['cellar-nim', 'source', 'resolver'] })).toBe(true);
    expect(ok('lex_cites', { celexNumber: '32016L0680', provenance: 'cellar,eurlex' })).toBe(false);
    expect(ok('lex_citation_network', { celexNumber: '32016L0680', resolution: ['id', 'key', 'abbreviation', 'text-pattern'] })).toBe(true);
    expect(ok('lex_citation_network', { celexNumber: '32016L0680', resolution: 'fuzzy' })).toBe(false);
    expect(ok('lex_related', { celexNumber: '32016L0680', jurisdictions: 'eu,de' })).toBe(true);
    expect(ok('lex_related', { celexNumber: '32016L0680', jurisdictions: ['aut'] })).toBe(false);
    expect(ok('lex_citation_path', { from: 'AT-NOR-1', to: '32016L0680', jurisdictions: ['at', 'eu'] })).toBe(true);
    // unresolved exists on /cites and /network only
    expect(Object.keys(byName.lex_cites.inputSchema)).toContain('unresolved');
    expect(Object.keys(byName.lex_citation_network.inputSchema)).toContain('unresolved');
    expect(Object.keys(byName.lex_cited_by.inputSchema)).not.toContain('unresolved');
  });

  it('lex_citation_path and lex_related forward every filter', async () => {
    const filters = { citationType: ['reference'], provenance: ['notice'], jurisdictions: ['eu'], resolution: ['key'] };
    const want = { citationType: 'reference', provenance: 'notice', jurisdictions: 'eu', resolution: 'key' };

    const p = await call('lex_citation_path', { from: '62018CJ0311', to: '32016R0679', ...filters }, () => ({
      body: { success: true, from: '62018CJ0311', to: '32016R0679', found: false, maxDepth: 3, path: [] },
    }));
    expect(Object.fromEntries(p.calls[0].url.searchParams)).toEqual({ maxDepth: '3', ...want });

    const r = await call('lex_related', { celexNumber: '32016R0679', ...filters }, () => ({
      body: { success: true, celexNumber: '32016R0679', related: [] },
    }));
    expect(Object.fromEntries(r.calls[0].url.searchParams)).toEqual({ limit: '10', ...want });
  });
});

describe('edge provenance, node identity, countsSource', () => {
  it('lex_cited_by keeps totalEdges / countsSource and aggregates provenance per group', async () => {
    const { data } = await call('lex_cited_by', { celexNumber: '32016L0680', includeNational: true }, () => ({
      body: {
        success: true, includeNational: true, targetDocument: '32016L0680', totalCitations: 2, totalEdges: 3, countsSource: 'stats',
        limit: 50, offset: 0,
        citedBy: [
          {
            id: 'AT-NOR-10001597', celexNumber: 'AT-NOR-10001597', jurisdiction: 'AT', documentKind: 'act', title: 'Datenschutzgesetz', citationCount: 2,
            citations: [
              { citationType: 'transposition', provenance: 'source', resolution: 'id', contextSnippet: null },
              { citationType: 'transposition', provenance: 'cellar-nim', resolution: null, contextSnippet: null },
            ],
          },
          {
            id: '32018R1725', celexNumber: '32018R1725', jurisdiction: 'EU', documentKind: 'act', title: 'Regulation (EU) 2018/1725', citationCount: 1,
            citations: [{ citationType: 'reference', provenance: 'notice', resolution: null, contextSnippet: 'Directive (EU) 2016/680' }],
          },
        ],
      },
    }));
    expect(data.totalEdges).toBe(3);
    expect(data.countsSource).toBe('stats');
    expect(data.citedBy[0]).toEqual({
      celex: 'AT-NOR-10001597', jurisdiction: 'AT', documentKind: 'act', title: 'Datenschutzgesetz',
      types: ['transposition'], provenance: ['source', 'cellar-nim'], resolution: ['id'], count: 2,
    });
    // EU nodes do not repeat jurisdiction "EU"
    expect(data.citedBy[1]).toEqual({
      celex: '32018R1725', documentKind: 'act', title: 'Regulation (EU) 2018/1725',
      types: ['reference'], provenance: ['notice'], count: 1, context: 'Directive (EU) 2016/680',
    });
  });

  it('lex_citation_network aggregates edgeDetails and keeps paging.countsSource', async () => {
    const { data } = await call('lex_citation_network', { celexNumber: '32016R0679' }, () => ({
      body: {
        success: true, document: '32016R0679',
        network: {
          celexNumber: '32016R0679', citesCount: 1, citedByCount: 0, citedBy: [],
          cites: [{
            id: '31995L0046', celexNumber: '31995L0046', jurisdiction: 'EU', documentKind: 'act', title: 'Directive 95/46/EC', count: 1, types: ['repeal'],
            edgeDetails: [{ citationType: 'repeal', provenance: 'notice+cellar', resolution: null }],
          }],
        },
        paging: { limit: 50, offset: 0, citesTotal: 1, citedByTotal: 0, citesEdgeTotal: 1, citedByEdgeTotal: 0, countsSource: 'counted' },
      },
    }));
    expect(data.cites[0]).toEqual({ celex: '31995L0046', documentKind: 'act', title: 'Directive 95/46/EC', types: ['repeal'], count: 1, provenance: ['notice+cellar'] });
    expect(data.paging.countsSource).toBe('counted');
  });

  it('unresolved=true is forwarded; the list is bounded and unresolvedTruncated kept', async () => {
    const unresolved = Array.from({ length: 130 }, (_, i) => ({
      kind: 'norm', text: `StGB §${i} ${'x'.repeat(400)}`, parsedKey: { code: 'StGB', candidates: ['AT-NOR-1', 'AT-NOR-2'] }, status: 'not-held', targetId: null,
    }));
    const { calls, data } = await call('lex_cites', { celexNumber: 'AT-NOR-10001597', unresolved: true }, () => ({
      body: { success: true, sourceDocument: 'AT-NOR-10001597', cites: [], includeNational: true, unresolved, unresolvedTruncated: false },
    }));
    expect(calls[0].url.searchParams.get('unresolved')).toBe('true');
    expect(data.unresolved).toHaveLength(100);
    expect(data.unresolved[0]).toEqual({ kind: 'norm', text: expect.stringMatching(/^StGB §0 x+…$/), status: 'not-held' });
    expect(data.unresolved[0].text.length).toBe(200);
    expect(data.unresolvedTruncated).toBe(false);
    expect(data.unresolvedNote).toMatch(/30 more/);

    const n = await call('lex_citation_network', { celexNumber: 'AT-NOR-10001597', unresolved: true }, () => ({
      body: { success: true, document: 'AT-NOR-10001597', network: { cites: [], citedBy: [] }, paging: {}, unresolved: unresolved.slice(0, 2), unresolvedTruncated: true },
    }));
    expect(n.calls[0].url.searchParams.get('unresolved')).toBe('true');
    expect(n.data.unresolved).toHaveLength(2);
    expect(n.data.unresolvedTruncated).toBe(true);
    expect(n.data).not.toHaveProperty('unresolvedNote');
  });

  it('path and related nodes carry jurisdiction / documentKind', async () => {
    const p = await call('lex_citation_path', { from: 'AT-NOR-1', to: '32016L0680' }, () => ({
      body: {
        success: true, from: 'AT-NOR-1', to: '32016L0680', found: true, pathLength: 1, maxDepth: 3,
        path: [
          { id: 'AT-NOR-1', celexNumber: 'AT-NOR-1', jurisdiction: 'AT', documentKind: 'act', title: 'DSG', titleSource: 'corpus' },
          { id: '32016L0680', celexNumber: '32016L0680', jurisdiction: 'EU', documentKind: 'act', title: 'LED' },
        ],
      },
    }));
    expect(p.data.path).toEqual([
      { celex: 'AT-NOR-1', jurisdiction: 'AT', documentKind: 'act', title: 'DSG' },
      { celex: '32016L0680', documentKind: 'act', title: 'LED' },
    ]);

    const r = await call('lex_related', { celexNumber: '32016R0679' }, () => ({
      body: { success: true, celexNumber: '32016R0679', related: [{ id: '62018CJ0311', celexNumber: '62018CJ0311', jurisdiction: 'EU', documentKind: 'decision', title: 'Schrems II', sharedCount: 3, sharedTargets: ['A'] }] },
    }));
    expect(r.data.related[0]).toEqual({ celex: '62018CJ0311', documentKind: 'decision', title: 'Schrems II', sharedCount: 3, sharedTargets: ['A'] });
  });

  it('lex_citation_stats passes byJurisdiction / byProvenance / transposition through', async () => {
    const stats = {
      totalCitations: 10, uniqueSourceDocuments: 5, uniqueTargetDocuments: 4, mostCited: [], mostCiting: [],
      byJurisdiction: { EU: { asSource: 8, asTarget: 10 }, AT: { asSource: 2, asTarget: 0 } },
      byProvenance: { notice: 6, 'cellar-nim': 2, source: 2 },
      transposition: { measures: 40, resolved: 12, byCountry: { AT: { measures: 40, resolved: 12 } } },
    };
    const { data } = await call('lex_citation_stats', { includeNational: true }, () => ({ body: { success: true, includeNational: true, stats } }));
    expect(data.stats).toEqual(stats);
  });
});

describe('lex_transposition', () => {
  it('calls the route with jurisdictions / resolvedOnly and always keeps the note and the attribution', async () => {
    const { calls, data } = await call('lex_transposition', { celexNumber: 'celex:32016l0680', jurisdictions: 'ES,cz', resolvedOnly: true }, () => ({
      body: transpositionBody([{ code: 'ES', n: 1 }]),
    }));
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.pathname).toBe('/api/v1/citations/transposition/32016L0680');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ jurisdictions: 'es,cz', resolvedOnly: 'true' });
    expect(data.note).toBe(NOTE);
    expect(data.source.cellar.attribution).toMatch(/Publications Office/);
    expect(data.document).toEqual({ celex: '32016L0680', documentKind: 'act', title: 'Directive (EU) 2016/680' });
    expect(data.truncated).toBe(false);
    expect(data).not.toHaveProperty('credits');
    // A measure: holdings nulls and the opaque Cellar id dropped, the record kept.
    expect(data.jurisdictions[0]).toEqual({
      jurisdiction: 'ES', live: false, counts: { measures: 1, resolved: null },
      measures: [{
        provenance: 'cellar-nim', citationType: 'transposition', title: 'Ley Orgánica 7/2021, de 26 de mayo', typeAct: 'Ley Orgánica',
        officialJournal: { name: 'Boletín Oficial del Estado', number: '126/2021', date: '2021-05-27' },
        reference: 'ES-0', link: 'https://www.boe.es/x.pdf',
        cellar: { celex: '72016L0680ESP_202101234', dateDocument: '2021-05-27', dateNotification: '2021-06-02', entryIntoForce: '2021-06-16' },
      }],
    });
    expect(data.shown).toEqual({ offset: 0, returned: 1, total: 1 });
    expect(data).not.toHaveProperty('more');
  });

  it('keeps the holdings fields when joined (BUSINESS+, live country)', async () => {
    const { data } = await call('lex_transposition', { celexNumber: '32016L0680' }, () => ({
      body: {
        ...transpositionBody([]),
        includeNational: true,
        source: { cellar: { syncedAt: null, measures: 1, attribution: 'Source: Publications Office of the European Union' }, lanes: ['AT'] },
        jurisdictions: [{
          jurisdiction: 'AT', live: true, counts: { measures: 2, resolved: 2 },
          measures: [
            measure({ id: 'AT-NOR-10001597', resolved: true, resolution: 'key', resolutionBasis: { keyKind: 'bgbl', key: 'BGBl. I Nr. 120/2017' } }),
            measure({ id: 'AT-NOR-2', resolved: true, resolution: 'id', provenance: 'source', cellar: null }),
          ],
        }],
      },
    }));
    expect(data.includeNational).toBe(true);
    expect(data.source.lanes).toEqual(['AT']);
    expect(data.jurisdictions[0].measures[0]).toMatchObject({ id: 'AT-NOR-10001597', resolved: true, resolution: 'key', resolutionBasis: { keyKind: 'bgbl', key: 'BGBl. I Nr. 120/2017' } });
    expect(data.jurisdictions[0].measures[1]).toMatchObject({ id: 'AT-NOR-2', provenance: 'source' });
    expect(data.jurisdictions[0].measures[1]).not.toHaveProperty('cellar');
  });

  it('surfaces termsRequired', async () => {
    const { data } = await call('lex_transposition', { celexNumber: '32016L0680' }, () => ({
      body: { ...transpositionBody([{ code: 'AT', n: 1, live: true }]), includeNational: false, termsRequired: true },
    }));
    expect(data.termsRequired).toBe(true);
    expect(data.includeNational).toBe(false);
  });

  it('bounds the measures with limit / offset across countries; every country keeps its counts', async () => {
    const body = transpositionBody([{ code: 'CZ', n: 3 }, { code: 'ES', n: 4 }, { code: 'SI', n: 2 }]);
    const first = await call('lex_transposition', { celexNumber: '32016L0680', limit: 4 }, () => ({ body }));
    expect(first.data.jurisdictions.map((c: any) => [c.jurisdiction, c.counts.measures, (c.measures ?? []).map((m: any) => m.reference)])).toEqual([
      ['CZ', 3, ['CZ-0', 'CZ-1', 'CZ-2']],
      ['ES', 4, ['ES-0']],
      ['SI', 2, []],
    ]);
    expect(first.data.shown).toEqual({ offset: 0, returned: 4, total: 9 });
    expect(first.data.more).toBe('Measures 1–4 of 9 shown. Call again with offset 4 (another 5 credits), or narrow with jurisdictions.');

    const second = await call('lex_transposition', { celexNumber: '32016L0680', limit: 4, offset: 4 }, () => ({ body }));
    expect(second.calls[0].url.searchParams.has('offset')).toBe(false); // applied here, not sent
    expect(second.calls[0].url.searchParams.has('limit')).toBe(false);
    expect(second.data.jurisdictions.flatMap((c: any) => (c.measures ?? []).map((m: any) => m.reference))).toEqual(['ES-1', 'ES-2', 'ES-3', 'SI-0']);
    expect(second.data.more).toMatch(/offset 8/);

    const last = await call('lex_transposition', { celexNumber: '32016L0680', limit: 4, offset: 8 }, () => ({ body }));
    expect(last.data.shown).toEqual({ offset: 8, returned: 1, total: 9 });
    expect(last.data).not.toHaveProperty('more');
  });

  it('truncates long notified titles', async () => {
    const { data } = await call('lex_transposition', { celexNumber: '32016L0680' }, () => ({
      body: { ...transpositionBody([]), jurisdictions: [{ jurisdiction: 'DE', live: false, counts: { measures: 1, resolved: null }, measures: [measure({ title: 'T'.repeat(1000) })] }] },
    }));
    expect(data.jurisdictions[0].measures[0].title).toHaveLength(300);
  });

  it('validates inputs', () => {
    expect(ok('lex_transposition', { celexNumber: '32016L0680', jurisdictions: ['el', 'uk', 'eu'] })).toBe(true);
    expect(ok('lex_transposition', { celexNumber: '32016L0680', jurisdictions: 'esp' })).toBe(false);
    expect(ok('lex_transposition', { celexNumber: '32016L0680', limit: 2001 })).toBe(false);
    expect(ok('lex_transposition', { celexNumber: 'GDPR!' })).toBe(false);
  });

  it('a 404 for something that is not an EU act; a 400 names the parameter and its allowed values', async () => {
    const nf = await call('lex_transposition', { celexNumber: '62018CJ0311' }, () => ({
      status: 404, body: { success: false, code: 'NOT_FOUND', error: 'Not an EU act: 62018CJ0311' },
    }));
    expect(nf.result.isError).toBe(true);
    expect(nf.text).toMatch(/Not an EU act: 62018CJ0311/);

    const bad = await call('lex_transposition', { celexNumber: '32016L0680', jurisdictions: ['xx'] }, () => ({
      status: 400, body: { success: false, code: 'INVALID_PARAMS', error: 'Unknown jurisdictions value: xx', param: 'jurisdictions', allowed: ['at', 'be', 'eu'] },
    }));
    expect(bad.result.isError).toBe(true);
    expect(bad.text).toMatch(/INVALID_PARAMS/);
    expect(bad.text).toContain('"param":"jurisdictions"');
    expect(bad.text).toContain('"allowed":["at","be","eu"]');
  });
});

describe('lex_counterparts', () => {
  function via(code: string, n: number) {
    return {
      euAct: { id: code, celexNumber: code, jurisdiction: 'EU', documentKind: 'act', title: `Directive ${code}`, notifiedMeasures: 333 },
      edge: { citationType: 'transposition', provenance: 'source', resolution: 'id' },
      counterparts: Array.from({ length: n }, (_, i) => ({
        jurisdiction: i % 2 ? 'ES' : 'SI', id: i === n - 1 ? null : `SI-${i}`, resolved: i !== n - 1, title: `Measure ${i}`,
        citationType: 'transposition', provenance: i === 0 ? 'source' : 'cellar-nim', rank: i === 0 ? 1 : i === n - 1 ? 3 : 2,
      })),
      truncated: false,
    };
  }

  it('calls the route and shapes ranked counterparts compactly', async () => {
    const { calls, data } = await call('lex_counterparts', { id: 'at-nor-10001597', jurisdictions: ['si', 'es'] }, () => ({
      body: {
        success: true, includeNational: true,
        document: { id: 'AT-NOR-10001597', celexNumber: 'AT-NOR-10001597', jurisdiction: 'AT', documentKind: 'act', title: 'Datenschutzgesetz' },
        via: [via('32016L0680', 3)],
        truncated: false,
      },
    }));
    expect(calls[0].url.pathname).toBe('/api/v1/citations/counterparts/AT-NOR-10001597');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ jurisdictions: 'si,es' });
    expect(data.document).toEqual({ celex: 'AT-NOR-10001597', jurisdiction: 'AT', documentKind: 'act', title: 'Datenschutzgesetz' });
    expect(data.via[0].euAct).toEqual({ celex: '32016L0680', documentKind: 'act', title: 'Directive 32016L0680', notifiedMeasures: 333 });
    expect(data.via[0].edge).toEqual({ citationType: 'transposition', provenance: 'source', resolution: 'id' });
    expect(data.via[0].counterparts).toEqual([
      { jurisdiction: 'SI', id: 'SI-0', resolved: true, title: 'Measure 0', citationType: 'transposition', provenance: 'source', rank: 1 },
      { jurisdiction: 'ES', id: 'SI-1', resolved: true, title: 'Measure 1', citationType: 'transposition', provenance: 'cellar-nim', rank: 2 },
      // rank 3: not held — no id, resolved: false kept
      { jurisdiction: 'SI', resolved: false, title: 'Measure 2', citationType: 'transposition', provenance: 'cellar-nim', rank: 3 },
    ]);
    expect(data.note).toMatch(/not a finding that the measure transposes the act/);
    expect(data.truncated).toBe(false);
    expect(data).not.toHaveProperty('more');
  });

  it('an EU act as id: one via entry, edge null', async () => {
    const { calls, data } = await call('lex_counterparts', { id: '32016L0680' }, () => ({
      body: { success: true, document: { id: '32016L0680', celexNumber: '32016L0680', jurisdiction: 'EU', documentKind: 'act' }, via: [{ ...via('32016L0680', 1), edge: null }], truncated: false },
    }));
    expect(calls[0].url.pathname).toBe('/api/v1/citations/counterparts/32016L0680');
    expect([...calls[0].url.searchParams.keys()]).toEqual([]);
    expect(data.via[0]).not.toHaveProperty('edge');
  });

  it('bounds counterparts per act (limit) and EU acts per call (25, offset)', async () => {
    const body = {
      success: true, document: { id: 'AT-NOR-1', celexNumber: 'AT-NOR-1', jurisdiction: 'AT' },
      via: Array.from({ length: 30 }, (_, i) => via(`3201${String(i).padStart(2, '0')}L0001`, 15)),
      truncated: false,
    };
    const first = await call('lex_counterparts', { id: 'AT-NOR-1' }, () => ({ body }));
    expect(first.data.via).toHaveLength(25);
    expect(first.data.via[0].counterparts).toHaveLength(10);
    expect(first.data.via[0].more).toMatch(/5 more counterparts/);
    expect(first.data.more).toBe('EU acts 1–25 of 30 shown. Call again with offset 25 (another 20 credits).');

    const second = await call('lex_counterparts', { id: 'AT-NOR-1', offset: 25, limit: 200 }, () => ({ body }));
    expect(second.data.via).toHaveLength(5);
    expect(second.data.via[0].euAct.celex).toBe('320125L0001');
    expect(second.data.via[0].counterparts).toHaveLength(15);
    expect(second.data.via[0]).not.toHaveProperty('more');
    expect(second.data).not.toHaveProperty('more');
  });

  it('below BUSINESS: 403 TIER_FORBIDDEN, not retried', async () => {
    const { result, calls, text } = await call('lex_counterparts', { id: '32016L0680' }, () => ({
      status: 403, body: { success: false, code: 'TIER_FORBIDDEN', error: 'Counterparts require a BUSINESS plan or higher', upgradeUrl: '/pricing' },
    }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(text).toMatch(/plan or subscription does not allow/);
  });

  it('403 NATIONAL_TERMS_NOT_ACCEPTED points at the dashboard acceptance', async () => {
    const { text } = await call('lex_counterparts', { id: 'AT-NOR-1' }, () => ({
      status: 403,
      body: { success: false, code: 'NATIONAL_TERMS_NOT_ACCEPTED', error: 'Accept the national-source terms first', termsVersion: '2026-10', acceptUrl: 'https://lex-api.com/dashboard#terms', termsUrl: 'https://lex-api.com/terms' },
    }));
    expect(text).toMatch(/accept the national-source terms/);
    expect(text).toContain('https://lex-api.com/dashboard#terms');
  });

  it('503 TIMEOUT: refunded, narrow with jurisdictions', async () => {
    const { result, text } = await call('lex_counterparts', { id: 'AT-NOR-1' }, () => ({
      status: 503, body: { success: false, code: 'TIMEOUT', error: 'Counterparts lookup exceeded 20000ms', partial: true, partialReason: 'TIMEOUT', timeoutMs: 20000 },
    }));
    expect(result.isError).toBe(true);
    expect(text).toMatch(/LexAPI error 503 \(TIMEOUT\)/);
    expect(text).toMatch(/nothing was charged/);
    expect(text).toMatch(/jurisdictions/);
  });

  it('a national id of a country that is not live: 404 guided to lex_national_coverage', async () => {
    const { text } = await call('lex_counterparts', { id: 'ES-NOR-1' }, () => ({
      status: 404, body: { success: false, code: 'NOT_FOUND', error: 'Document not found: ES-NOR-1' },
    }));
    expect(text).toMatch(/lex_national_coverage/);
  });
});

describe('honest descriptions', () => {
  it('transposition: a notification is not a finding; every plan; 5 credits', () => {
    const d = byName.lex_transposition.description;
    expect(d).toMatch(/not a finding that the measure transposes the act, or transposes it completely/);
    expect(d).toMatch(/Every plan/);
    expect(d).toMatch(/5 credits/);
    expect(d).toMatch(/live countries only/);
    expect(byName.lex_transposition.annotations.readOnlyHint).toBe(true);
  });

  it('counterparts: BUSINESS+, live countries only, 20 credits, not a finding', () => {
    const d = byName.lex_counterparts.description;
    expect(d).toMatch(/BUSINESS, SCALE and ENTERPRISE only/);
    expect(d).toMatch(/Only live countries are returned/);
    expect(d).toMatch(/lex_national_coverage/);
    expect(d).toMatch(/20 credits/);
    expect(d).toMatch(/not a finding/);
  });

  it('the cellar-nim filter value is described as a notification', () => {
    const schema = z.toJSONSchema(z.object(byName.lex_cited_by.inputSchema), { io: 'input' }) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.provenance.description).toMatch(/notified measure, not a finding of transposition/);
  });

  it('server instructions say the same', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/lex_transposition/);
    expect(SERVER_INSTRUCTIONS).toMatch(/not findings that a measure transposes the act/);
  });
});
