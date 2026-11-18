// National asOf labels (API 2.29.0), the snapshot of a document on a date
// (API 2.28.0), Retry-After on 5xx, and provenance.sourceUrl.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LexAPIClient } from '../src/client.js';
import { describeError, LexAPIError } from '../src/errors.js';
import { runTool, SERVER_INSTRUCTIONS } from '../src/server.js';
import { nationalAsOfCaveat } from '../src/shape.js';
import { tools, type ToolDef } from '../src/tools.js';
import { mockFetch, parseText } from './helpers.js';

const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;
const BASE = 'http://127.0.0.1:9/api/v1';

type Reply = Parameters<typeof mockFetch>[0];

function localClient(reply: Reply, opts: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const m = mockFetch(reply);
  const sleeps: number[] = [];
  const client = new LexAPIClient({
    apiKey: 'lex_test_key',
    baseUrl: BASE,
    fetch: m.fetch,
    sleep: opts.sleep ?? (async (ms) => { sleeps.push(ms); }),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { client, calls: m.calls, sleeps };
}

async function call(name: string, args: Record<string, unknown>, reply: Reply) {
  const tool = byName[name];
  const parsed = z.object(tool.inputSchema).parse(args);
  const { client, calls, sleeps } = localClient(reply);
  const result = await runTool(tool, parsed, client);
  for (const c of calls) expect(c.url.origin).toBe('http://127.0.0.1:9');
  const text = result.content[0].text as string;
  return { result, calls, sleeps, text, data: result.isError ? undefined : parseText(result) };
}

// ── National asOf ────────────────────────────────────────────────────
const ATTR = 'Data source: RIS.';

function hit(ref: string, extra: Record<string, unknown>) {
  return {
    law_id: 'AT-NOR-20000001', documentId: 'AT-NOR-20000001', jurisdiction: 'AT', score: 0.8123,
    law_title: 'Datenschutzgesetz', article_ref: ref, section: null, language: 'de',
    in_force: true, valid_from: '2018-05-25', valid_to: null, law_type: null,
    snippet: `Wortlaut ${ref}`,
    document: { id: 'AT-NOR-20000001', jurisdiction: 'AT', documentKind: 'act', title: 'Datenschutzgesetz', documentType: 'Bundesgesetz', provenance: { sourceUrl: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Gesetzesnummer=20000001' } },
    attribution: ATTR,
    ...extra,
  };
}

const RESOLVED = hit('§ 1', {
  asOf: '2020-06-01', asOfResolved: true,
  asOfVersion: { kind: 'current_unit', validFrom: '2018-05-25', validTo: null, sourceId: 'NOR40000001', checkedAt: '2026-10-30' },
});
const REASONS = ['provision_amended_since', 'no_longer_in_force', 'provision_dates_unknown', 'asof_not_available'] as const;
const unresolved = (reason: string, ref: string) => hit(ref, { asOf: '2020-06-01', asOfResolved: false, asOfReason: reason });

const LABELS: Record<string, string> = {
  provision_amended_since: "Today's wording, not established as the text on 2020-06-01: the provision was amended or added after that date; LexAPI cannot return the earlier wording.",
  no_longer_in_force: "Today's wording, not established as the text on 2020-06-01: the provision or its act was no longer in force on that date.",
  provision_dates_unknown: "Today's wording, not established as the text on 2020-06-01: the dates of the provision's current wording are unknown.",
  asof_not_available: "Today's wording, not established as the text on 2020-06-01: LexAPI holds no per-provision dates for this country.",
};

describe('lex_national_semantic_legislation: asOf', () => {
  const body = {
    success: true, jurisdiction: 'AT', resultCount: 5,
    results: [RESOLVED, ...REASONS.map((r, i) => unresolved(r, `§ ${i + 2}`))],
    asOf: '2020-06-01',
    asOfSummary: { liveFetches: 0, unresolved: 4 },
    attribution: ATTR,
  };

  it('is sent, and the labels are kept: the exact output', async () => {
    const { calls, data } = await call('lex_national_semantic_legislation', { jurisdiction: 'at', query: 'Auskunft über eigene Daten', asOf: '2020-06-01' }, () => ({ body }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/api/v1/at/legislation/semantic');
    expect(calls[0].body).toEqual({ query: 'Auskunft über eigene Daten', asOf: '2020-06-01', limit: 10 });
    const common = {
      law_id: 'AT-NOR-20000001', documentId: 'AT-NOR-20000001', jurisdiction: 'AT', documentKind: 'act', law_title: 'Datenschutzgesetz',
      documentType: 'Bundesgesetz', score: 0.812, language: 'de', in_force: true, valid_from: '2018-05-25',
      sourceUrl: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Gesetzesnummer=20000001', attribution: ATTR,
    };
    expect(data).toEqual({
      jurisdiction: 'AT',
      asOf: '2020-06-01',
      asOfSummary: { unresolved: 4 },
      resultCount: 5,
      results: [
        { ...common, article_ref: '§ 1', asOf: '2020-06-01', asOfResolved: true, asOfVersion: { kind: 'current_unit', validFrom: '2018-05-25', validTo: null, sourceId: 'NOR40000001', checkedAt: '2026-10-30' }, snippet: 'Wortlaut § 1' },
        ...REASONS.map((r, i) => ({ ...common, article_ref: `§ ${i + 2}`, asOf: '2020-06-01', asOfResolved: false, asOfReason: r, asOfLabel: LABELS[r], snippet: `Wortlaut § ${i + 2}` })),
      ],
      attribution: ATTR,
      asOfCaveat: {
        note: "Unresolved hits carry today's wording, which is not established as the text on 2020-06-01. asOf never returns earlier wording.",
        amendedSince: ['AT-NOR-20000001 § 2 (provision_amended_since)'],
        notInForce: ['AT-NOR-20000001 § 3 (no_longer_in_force)'],
        datesUnknown: ['AT-NOR-20000001 § 4 (provision_dates_unknown)'],
        notAvailable: ['AT-NOR-20000001 § 5 (asof_not_available)'],
        guidance: [
          'amendedSince: amended or added after 2020-06-01; LexAPI cannot return the wording that applied on that date.',
          'notInForce: no longer in force on 2020-06-01 — that is the answer for them.',
          "datesUnknown: the dates of today's wording are unknown, so whether it applied on 2020-06-01 is not established.",
          'notAvailable: LexAPI holds no per-provision dates for this country.',
        ],
      },
    });
  });

  it('an unresolved hit keeps today\'s text (as on the EU tool), and its label comes before it', async () => {
    const withText = { ...body, results: [{ ...unresolved('provision_amended_since', '§ 9'), text: 'Heutiger Wortlaut' }] };
    const { text, data } = await call('lex_national_semantic_legislation', { jurisdiction: 'at', query: 'Auskunft', asOf: '2020-06-01', include: ['text'] }, () => ({ body: withText }));
    expect(data.results[0].text).toBe('Heutiger Wortlaut');
    expect(text.indexOf('"asOfLabel"')).toBeLessThan(text.indexOf('"text"'));
    expect(text.indexOf('"asOfLabel"')).toBeLessThan(text.indexOf('"snippet"'));
  });

  it('no national reason is grouped as "the version in force could not be read"', async () => {
    const { text } = await call('lex_national_semantic_legislation', { jurisdiction: 'at', query: 'Auskunft', asOf: '2020-06-01' }, () => ({ body }));
    expect(text).not.toMatch(/could not be read|unavailable:/);
  });

  it('a reason this version does not know: labelled, grouped as other', async () => {
    const { data } = await call('lex_national_semantic_legislation', { jurisdiction: 'es', query: 'protección de datos', asOf: '2020-06-01' }, () => ({
      body: { ...body, jurisdiction: 'ES', results: [unresolved('some_new_reason', 'art. 1')] },
    }));
    expect(data.results[0].asOfLabel).toBe("Today's wording, not established as the text on 2020-06-01: whether it applied on that date was not established.");
    expect(data.asOfCaveat.other).toEqual(['AT-NOR-20000001 art. 1 (some_new_reason)']);
    expect(data.asOfCaveat.guidance).toEqual(["other: whether today's wording applied on 2020-06-01 was not established (see asOfReason)."]);
  });

  it('an API that does not label hits: every hit is labelled unresolved, with a note', async () => {
    const { data } = await call('lex_national_semantic_legislation', { jurisdiction: 'at', query: 'Auskunft', asOf: '2020-06-01' }, () => ({
      body: { success: true, jurisdiction: 'AT', results: [hit('§ 1', {})], attribution: ATTR },
    }));
    expect(data.results[0]).toMatchObject({ asOf: '2020-06-01', asOfResolved: false, asOfLabel: "Today's wording, not established as the text on 2020-06-01: whether it applied on that date was not established." });
    expect(data.asOfNote).toBe('The API returned no asOf labels for these hits (LexAPI API 2.29.0 or later labels them).');
  });

  it('without asOf: nothing is sent and no label is added', async () => {
    const { calls, data } = await call('lex_national_semantic_legislation', { jurisdiction: 'at', query: 'Auskunft' }, () => ({
      body: { success: true, jurisdiction: 'AT', results: [hit('§ 1', {})], attribution: ATTR },
    }));
    expect(calls[0].body).not.toHaveProperty('asOf');
    for (const k of ['asOf', 'asOfResolved', 'asOfLabel', 'asOfReason']) expect(data.results[0]).not.toHaveProperty(k);
    expect(data).not.toHaveProperty('asOfCaveat');
    expect(data).not.toHaveProperty('asOfNote');
  });

  it('asOf is validated as on the EU tool: a calendar date', () => {
    const schema = z.object(byName.lex_national_semantic_legislation.inputSchema);
    const ok = (asOf: unknown) => schema.safeParse({ jurisdiction: 'at', query: 'Auskunft', asOf }).success;
    expect(ok('2020-06-01')).toBe(true);
    expect(ok('1800-01-01')).toBe(true);
    for (const bad of ['2020-02-30', '2020-6-1', '2020/06/01', '20200601', '', 20200601, null]) expect(ok(bad), String(bad)).toBe(false);
    const eu = z.object(byName.lex_semantic_legislation.inputSchema);
    for (const v of ['2020-06-01', '2020-02-30', '2020/06/01']) {
      expect(ok(v), v).toBe(eu.safeParse({ query: 'x', asOf: v }).success);
    }
  });

  it('description, cost and server instructions', () => {
    const d = byName.lex_national_semantic_legislation.description;
    expect(d).toContain('asOf labels each hit for a date and never returns earlier wording');
    expect(d).toContain('the hit keeps today\'s text under asOfLabel, not established as the text for the date');
    expect(d).toContain('other countries answer asof_not_available');
    expect(d).toContain('asOf adds no cost. Cost: 5 credits.');
    expect(SERVER_INSTRUCTIONS).toContain('For national law, asOf (lex_national_semantic_legislation) only labels whether today\'s wording already applied on the date; it never returns earlier wording.');
    const schema = z.toJSONSchema(z.object(byName.lex_national_semantic_legislation.inputSchema), { io: 'input' }) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.asOf.description).toMatch(/1800-01-01 to today \(UTC\)/);
  });
});

// Property: over generated answers, no hit text or snippet reaches the
// model without either asOfResolved: true from the API or the label.
describe('property: an unresolved national hit is never shown without its label', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const pickOf = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const RESOLVED_VALUES = [true, false, undefined, null, 'true', 1, 'yes'] as const;
  const REASON_VALUES = [...REASONS, 'unknown_reason', undefined, null, 42, '', 'x'.repeat(300), 'constructor', '__proto__'] as const;

  it('holds for 300 generated answers', async () => {
    const r = rng(20261118);
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(r() * 6);
      const hits = Array.from({ length: n }, (_, i) => {
        const h: Record<string, unknown> = hit(`§ ${i}`, {});
        const resolved = pickOf(r, RESOLVED_VALUES);
        if (resolved !== undefined) h.asOfResolved = resolved;
        const reason = pickOf(r, REASON_VALUES);
        if (reason !== undefined) h.asOfReason = reason;
        if (r() < 0.5) h.text = `Text ${i}`;
        if (r() < 0.3) h.asOfVersion = { kind: 'current_unit', validFrom: '2010-01-01' };
        return h;
      });
      const echo = r() < 0.8;
      const reply = { body: { success: true, jurisdiction: 'AT', results: hits, ...(echo ? { asOf: '2020-06-01' } : {}), attribution: ATTR } };
      const { data } = await call('lex_national_semantic_legislation', { jurisdiction: 'at', query: 'Auskunft', asOf: '2020-06-01', include: ['text'] }, () => reply);
      data.results.forEach((out: Record<string, unknown>, i: number) => {
        const shown = typeof out.text === 'string' || typeof out.snippet === 'string';
        expect(shown).toBe(true);
        if (hits[i].asOfResolved === true) {
          expect(out.asOfResolved).toBe(true);
          expect(out).not.toHaveProperty('asOfLabel');
        } else {
          expect(out.asOfResolved, JSON.stringify(hits[i])).toBe(false);
          expect(String(out.asOfLabel)).toMatch(/^Today's wording, not established as the text on 2020-06-01: /);
          const keys = Object.keys(out);
          expect(keys.indexOf('asOfLabel')).toBeLessThan(keys.indexOf('snippet'));
          expect(data.asOfCaveat.note).toMatch(/not established as the text on 2020-06-01/);
        }
      });
      const unresolvedCount = hits.filter((h) => h.asOfResolved !== true).length;
      const listed = ['amendedSince', 'notInForce', 'datesUnknown', 'notAvailable', 'other']
        .reduce((sum, g) => sum + ((data.asOfCaveat?.[g] as unknown[] | undefined)?.length ?? 0), 0);
      expect(listed).toBe(unresolvedCount);
    }
  });
});

describe('nationalAsOfCaveat', () => {
  it('only asOfResolved: true counts as resolved', () => {
    const c = nationalAsOfCaveat([
      { law_id: 'A', asOfResolved: 'true', asOfReason: 'asof_not_available' },
      { law_id: 'B', asOfResolved: 1 },
      { law_id: 'C', asOfResolved: true },
    ], '2020-06-01');
    expect(c).toMatchObject({ notAvailable: ['A (asof_not_available)'], other: ['B (unknown)'] });
    expect(nationalAsOfCaveat([{ law_id: 'C', asOfResolved: true }], '2020-06-01')).toBeUndefined();
  });
});

// ── The snapshot of a document on a date ─────────────────────────────
describe('lex_get_document_version / lex_document_versions: snapshot fields', () => {
  it('by date: kind, observedFrom / observedUntil, dateInFuture and the in-force pointer', async () => {
    const { data } = await call('lex_get_document_version', { celexNumber: '32016R0679', date: '2026-04-01' }, () => ({
      headers: { 'x-warning': 'date is in the future' },
      body: {
        success: true, celex: '32016R0679', language: 'en', kind: 'observation_snapshot', asOf: '2026-04-01', dateInFuture: true,
        semantics: 'Versions are LexAPI observation snapshots…',
        inForceLookup: { method: 'POST', path: '/api/v1/legislation/as-of' },
        document: {
          version: 2, isCurrent: false, contentHash: 'abc', fetchedAt: '2026-03-15T08:00:00.000Z',
          observedFrom: '2026-03-15T08:00:00.000Z', observedUntil: '2026-06-01T09:00:00.000Z',
          title: 'GDPR', provenance: { sourceUrl: 'https://eur-lex.europa.eu/x' },
        },
      },
    }));
    expect(data).toEqual({
      celex: '32016R0679', language: 'en', snapshotDate: '2026-04-01', kind: 'observation_snapshot', dateInFuture: true,
      warning: 'date is in the future', version: 2, isCurrent: false, observedFrom: '2026-03-15T08:00:00.000Z', observedUntil: '2026-06-01T09:00:00.000Z',
      fetchedAt: '2026-03-15T08:00:00.000Z', title: 'GDPR',
      semantics: 'Observation snapshots (as fetched by LexAPI), not the law in force on a date.',
      inForceLookup: 'lex_legislation_as_of gives the version of this EU act for a date.',
    });
  });

  it('the version list keeps observedFrom', async () => {
    const { data } = await call('lex_document_versions', { celexNumber: '32016R0679' }, () => ({
      body: {
        success: true, celex: '32016R0679', currentVersion: 2, trackedSince: '2026-01-10T08:00:00.000Z',
        versions: [
          { version: 2, isCurrent: true, contentHash: 'abcdef0123456789', fetchedAt: '2026-06-01T09:00:00.000Z', observedFrom: '2026-06-01T09:00:00.000Z' },
          { version: 1, isCurrent: false, contentHash: '0123456789abcdef', fetchedAt: '2026-01-10T08:00:00.000Z', observedFrom: null },
        ],
      },
    }));
    expect(data.versions).toEqual([
      { version: 2, isCurrent: true, observedFrom: '2026-06-01T09:00:00.000Z', fetchedAt: '2026-06-01T09:00:00.000Z', contentHash: 'abcdef012345' },
      { version: 1, fetchedAt: '2026-01-10T08:00:00.000Z', contentHash: '0123456789ab' },
    ]);
  });

  it('descriptions: fetch snapshots, not the law in force, and where that is', () => {
    for (const name of ['lex_document_versions', 'lex_get_document_version']) {
      const d = byName[name].description;
      expect(d, name).toMatch(/NOT the law in force on (a|that) date \(lex_legislation_as_of gives the version of an EU act for a date\)/);
      expect(d, name).toMatch(/observedFrom/);
    }
    expect(byName.lex_get_document_version.description).toContain('is a 404 (boundary_unknown) listing the candidate versions, not charged. Cost: 1 credit.');
  });
});

describe('a 404 from the snapshot on a date', () => {
  const BOUNDARY = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The snapshot of 32016R0679 (en) held on 2026-04-01 cannot be established.',
      details: {
        reason: 'boundary_unknown',
        candidates: [
          { version: 3, fetchedAt: '2026-06-01T09:00:00.000Z', observedFrom: '2026-06-01T09:00:00.000Z' },
          { version: 2, fetchedAt: '2026-05-20T09:00:00.000Z', observedFrom: null },
          { version: 'x' },
        ],
        candidatesTruncated: true,
      },
    },
  };

  it('boundary_unknown: the document is held, the candidates are listed, nothing was charged', async () => {
    const { result, text, calls } = await call('lex_get_document_version', { celexNumber: '32016R0679', date: '2026-04-01' }, () => ({ status: 404, body: BOUNDARY }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(text).toBe('LexAPI error 404 (NOT_FOUND, boundary_unknown): LexAPI holds this document, but cannot establish which of its stored versions was current on the requested date, so it returns none. This is not a "document not found" answer. Candidate versions: version 3 (observedFrom 2026-06-01T09:00:00.000Z); version 2 (start not recorded); more exist, not listed. lex_get_document_version reads each by its version number. This call was not charged. The same call is answered the same way.');
    expect(text).not.toMatch(/Check the identifier|lex_resolve/);
  });

  it('boundary_unknown without candidates', () => {
    const t = describeError(new LexAPIError(404, 'NOT_FOUND', 'x', { reason: 'boundary_unknown', candidates: [] }));
    expect(t).toBe('LexAPI error 404 (NOT_FOUND, boundary_unknown): LexAPI holds this document, but cannot establish which of its stored versions was current on the requested date, so it returns none. This is not a "document not found" answer. The API listed no candidate version; lex_document_versions lists the stored versions. This call was not charged. The same call is answered the same way.');
  });

  it('before_tracking: where the history starts', async () => {
    const { text } = await call('lex_get_document_version', { celexNumber: '32016R0679', date: '2020-01-01' }, () => ({
      status: 404,
      body: { success: false, error: { code: 'NOT_FOUND', message: '32016R0679 (en) was not yet in the corpus on 2020-01-01', details: { reason: 'before_tracking', trackedSince: '2026-01-10T08:00:00.000Z', inForceLookup: { method: 'POST', path: '/api/v1/legislation/as-of' } } } },
    }));
    expect(text).toBe("LexAPI error 404 (NOT_FOUND, before_tracking): LexAPI's history of this document starts at 2026-01-10T08:00:00.000Z; it holds no snapshot from before then. The document itself is held: lex_document_versions lists its snapshots. For the version of the EU act for a date, lex_legislation_as_of answers. These snapshots are LexAPI's fetch history, not the law in force on a date. This answer costs 1 credit.");
    const plain = describeError(new LexAPIError(404, 'NOT_FOUND', 'x', { reason: 'before_tracking', trackedSince: 'not a time' }));
    expect(plain).toContain("LexAPI's history of this document starts after the requested date;");
    expect(plain).not.toContain('lex_legislation_as_of');
  });

  it('other 404s keep their texts', () => {
    const missing = describeError(new LexAPIError(404, 'NOT_FOUND', 'No corpus entry for 32016R0679 (en).'));
    expect(missing).toBe('LexAPI error 404 (NOT_FOUND): No corpus entry for 32016R0679 (en). Not retryable as-is. Check the identifier (lex_resolve turns URLs, ELIs and ECLIs into CELEX numbers; lex_search finds documents by title). A not-found answer costs at most 1 credit.');
    const route = describeError(new LexAPIError(404, 'NOT_FOUND', 'Unknown API endpoint: GET /api/v1/x', { reason: 'unknown_endpoint' }));
    expect(route).not.toMatch(/boundary_unknown|before_tracking|holds this document/);
    expect(route).toMatch(/route itself is wrong/);
    // The reason counts only on the API's own NOT_FOUND code.
    expect(describeError(new LexAPIError(404, 'HTTP_404', 'x', { reason: 'boundary_unknown' }))).not.toMatch(/holds this document/);
  });
});

// ── Retry-After on 5xx ────────────────────────────────────────────────
const UPSTREAM_502 = { success: false, error: { code: 'UPSTREAM_ERROR', message: 'EUR-Lex returned an error page' } };

describe('Retry-After on 500/502/503', () => {
  it('a 502 with Retry-After: 10 is retried after 10 s, also on a billed POST', async () => {
    const { calls, sleeps, data } = await call('lex_get_document', { celexNumber: '32016R0679', include: ['metadata'] }, (_c, n) => (n === 1
      ? { status: 502, headers: { 'retry-after': '10' }, body: UPSTREAM_502 }
      : { body: { success: true, document: { celex: '32016R0679', title: 'GDPR', content: { metadata: {} } } } }));
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(sleeps).toEqual([10_000]);
    expect(data.celex).toBe('32016R0679');
  });

  it('a 502 without Retry-After keeps the 1 s backoff', async () => {
    const { calls, sleeps } = await call('lex_get_document', { celexNumber: '32016R0679' }, (_c, n) => (n === 1
      ? { status: 502, body: UPSTREAM_502 }
      : { body: { success: true, document: { celex: '32016R0679' } } }));
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('a second 502 with Retry-After: 10 is returned with the wait in the text', async () => {
    const { result, text, calls, sleeps } = await call('lex_get_document', { celexNumber: '32016R0679' }, () => ({ status: 502, headers: { 'retry-after': '10' }, body: UPSTREAM_502 }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([10_000]);
    expect(text).toBe('LexAPI error 502 (UPSTREAM_ERROR): EUR-Lex returned an error page. An upstream service (EUR-Lex or the semantic index) returned an error; failed calls are refunded. LexAPI answers the same call with the same error for 10 s (Retry-After): retry after that.');
  });

  it('a wait longer than the server sleeps on is not slept on', async () => {
    const { text, calls, sleeps } = await call('lex_get_metadata', { celexNumber: '32016R0679' }, () => ({ status: 502, headers: { 'retry-after': '30' }, body: UPSTREAM_502 }));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(text).toContain('for 30 s (Retry-After): retry after that.');
  });

  it('a wait that does not fit in the call\'s deadline is not slept on', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const m = mockFetch(() => { t += 45_000; return { status: 502, headers: { 'retry-after': '10' }, body: UPSTREAM_502 }; });
    const client = new LexAPIClient({ apiKey: 'lex_k', baseUrl: BASE, fetch: m.fetch, timeoutMs: 55_000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    const err = await client.getDocument({ celexNumber: '32016R0679' }).catch((e) => e);
    expect(err).toBeInstanceOf(LexAPIError);
    expect(err.retryAfterSeconds).toBe(10);
    expect(m.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('500 and 503 honour it too; a 503 TIMEOUT and a side-effecting call are still not retried', async () => {
    for (const status of [500, 503]) {
      const m = mockFetch((_c, n) => (n === 1 ? { status, headers: { 'retry-after': '3' }, body: { error: 'x' } } : { body: { ok: 1 } }));
      const sleeps: number[] = [];
      const client = new LexAPIClient({ apiKey: 'lex_k', baseUrl: BASE, fetch: m.fetch, sleep: async (ms) => { sleeps.push(ms); } });
      expect((await client.info()).body).toEqual({ ok: 1 });
      expect(sleeps, String(status)).toEqual([3000]);
    }
    const timeout = localClient(() => ({ status: 503, headers: { 'retry-after': '2' }, body: { code: 'TIMEOUT', error: 'Timed out' } }));
    await expect(timeout.client.counterparts('AT-NOR-1')).rejects.toBeInstanceOf(LexAPIError);
    expect(timeout.calls).toHaveLength(1);
    const create = localClient(() => ({ status: 502, headers: { 'retry-after': '1' }, body: { error: 'x' } }));
    await expect(create.client.createWebhook({ name: 'x' })).rejects.toBeInstanceOf(LexAPIError);
    expect(create.calls).toHaveLength(1);
  });

  it('other 5xx texts name the wait when there is one', () => {
    expect(describeError(new LexAPIError(500, 'INTERNAL', 'Boom', undefined, 4))).toBe('LexAPI error 500 (INTERNAL): Boom. LexAPI had a server error; server failures are refunded. Retry after 4 s (Retry-After); if it persists, status is at https://lex-api.com/status.');
    expect(describeError(new LexAPIError(500, 'INTERNAL', 'Boom'))).toBe('LexAPI error 500 (INTERNAL): Boom. LexAPI had a server error; server failures are refunded. Retry once; if it persists, status is at https://lex-api.com/status.');
    expect(describeError(new LexAPIError(502, 'UPSTREAM_ERROR', 'x'))).toBe('LexAPI error 502 (UPSTREAM_ERROR): x. An upstream service (EUR-Lex or the semantic index) returned an error. Retry later; failed calls are refunded.');
  });
});

// ── provenance.sourceUrl ─────────────────────────────────────────────
describe('provenance.sourceUrl', () => {
  it('on a document read, when it is not the EUR-Lex link already shown', async () => {
    const doc = (sourceUrl: unknown) => ({ body: { success: true, document: { celex: '32016R0679', urls: { html: 'https://eur-lex.europa.eu/a' }, provenance: { sourceUrl }, inForce: true, content: { metadata: {} } } } });
    const differs = await call('lex_get_document', { celexNumber: '32016R0679', include: ['metadata'] }, () => doc('https://eur-lex.europa.eu/b'));
    expect(differs.data).toMatchObject({ url: 'https://eur-lex.europa.eu/a', sourceUrl: 'https://eur-lex.europa.eu/b', inForce: true });
    const same = await call('lex_get_document', { celexNumber: '32016R0679', include: ['metadata'] }, () => doc('https://eur-lex.europa.eu/a'));
    expect(same.data).not.toHaveProperty('sourceUrl');
    for (const bad of ['javascript:alert(1)', 'ftp://x', 5, null, 'https://a b']) {
      const r = await call('lex_get_document', { celexNumber: '32016R0679', include: ['metadata'] }, () => doc(bad));
      expect(r.data, String(bad)).not.toHaveProperty('sourceUrl');
    }
  });

  it('on EU semantic hits and national documents', async () => {
    const eu = await call('lex_semantic_legislation', { query: 'erasure' }, () => ({
      body: { results: [{ law_id: '32016R0679', article_ref: 'art_17', inForce: true, provenance: { sourceUrl: 'https://eur-lex.europa.eu/x' } }] },
    }));
    expect(eu.data.results[0]).toMatchObject({ inForce: true, sourceUrl: 'https://eur-lex.europa.eu/x' });
    const nat = await call('lex_get_national_document', { jurisdiction: 'nl', id: 'NL-BWBR0005537' }, () => ({
      body: { success: true, document: { id: 'NL-BWBR0005537', jurisdiction: 'NL', provenance: { sourceUrl: 'https://wetten.overheid.nl/BWBR0005537' }, attribution: 'Source: BWB.', content: null } },
    }));
    expect(nat.data.sourceUrl).toBe('https://wetten.overheid.nl/BWBR0005537');
  });
});
