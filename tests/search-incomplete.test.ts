import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runTool } from '../src/server.js';
import { tools, type ToolDef } from '../src/tools.js';
import { LexAPIClient } from '../src/client.js';
import { describeError, LexAPIError } from '../src/errors.js';
import { clientWith, mockFetch, parseText } from './helpers.js';

const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;

async function call(name: string, args: Record<string, unknown>, reply: Parameters<typeof clientWith>[0]) {
  const tool = byName[name];
  const parsed = z.object(tool.inputSchema).parse(args);
  const { client, calls, sleeps } = clientWith(reply);
  const result = await runTool(tool, parsed, client);
  const text = result.content[0].text as string;
  return { result, calls, sleeps, text, data: result.isError ? undefined : parseText(result) };
}

const INCOMPLETE_503 = {
  success: false,
  code: 'NATIONAL_SEMANTIC_UNAVAILABLE',
  error: 'National semantic search incomplete',
  message: 'The Czech Republic (CZ) semantic index could not complete this search in time and there is nothing left to return.',
  jurisdiction: 'CZ',
  partialReason: 'SEARCH_INCOMPLETE',
  retryAfter: 10,
};

const REPEATED_503 = {
  success: false,
  code: 'NATIONAL_SEMANTIC_UNAVAILABLE',
  error: 'National semantic search incomplete',
  message: 'The Czech Republic (CZ) semantic index has repeatedly been unable to complete this search.',
  jurisdiction: 'CZ',
  partialReason: 'SEARCH_INCOMPLETE',
};

const UNREACHABLE_422 = {
  success: false,
  code: 'NATIONAL_SEMANTIC_FILTER_UNREACHABLE',
  error: 'National semantic search cannot cover these filters',
  message: 'The Germany (DE) semantic index cannot search this slice completely.',
  jurisdiction: 'DE',
  partialReason: 'SEARCH_INCOMPLETE',
};

const EMPTY = { success: true, jurisdiction: 'CZ', resultCount: 0, results: [] };

const CASE_LAW_HIT = {
  documentId: 'AT-JUD-OGH-1', jurisdiction: 'AT', score: 0.81, court: 'OGH', snippet: 'Der Oberste Gerichtshof …',
  metadata: { celex_id: 'AT-JUD-OGH-1' },
  document: { id: 'AT-JUD-OGH-1', jurisdiction: 'AT', documentKind: 'decision', title: null, documentType: 'Entscheidungstext (Justiz)' },
  attribution: 'Source: RIS.',
};

const LEGISLATION_HIT = {
  law_id: 'DE-1', documentId: 'DE-1', jurisdiction: 'DE', score: 0.7, snippet: 's',
  law_title: 'Bundesdatenschutzgesetz', article_ref: '§ 1', section: null, language: 'de',
  in_force: true, valid_from: null, valid_to: null, law_type: null,
  document: { id: 'DE-1', jurisdiction: 'DE', documentKind: 'act', title: 'Bundesdatenschutzgesetz', documentType: 'Gesetz' },
  attribution: 'Source: gesetze-im-internet.de.',
};

/** A client on a fake clock: each sleep advances it. */
function clockedClient(handler: Parameters<typeof mockFetch>[0], timeoutMs: number) {
  let t = 0;
  const m = mockFetch(handler);
  const sleeps: number[] = [];
  const client = new LexAPIClient({
    apiKey: 'lex_test_secret_key',
    baseUrl: 'https://api.example.test/api/v1',
    fetch: m.fetch,
    timeoutMs,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  return { client, calls: m.calls, sleeps };
}

describe('partial national semantic answers', () => {
  it('case law keeps partial / partialReason / hint', async () => {
    const { data } = await call('lex_national_semantic_case_law', { jurisdiction: 'at', query: 'Datenschutz' }, () => ({
      body: { ...EMPTY, jurisdiction: 'AT', resultCount: 1, results: [CASE_LAW_HIT], partial: true, partialReason: 'SEARCH_INCOMPLETE', hint: 'A retry may return a complete answer.' },
    }));
    expect(data.partial).toBe(true);
    expect(data.partialReason).toBe('SEARCH_INCOMPLETE');
    expect(data.hint).toMatch(/retry/);
    expect(data.results).toHaveLength(1);
  });

  it('legislation keeps partial / partialReason; a complete answer has neither', async () => {
    const partial = await call('lex_national_semantic_legislation', { jurisdiction: 'de', query: 'Haftung' }, () => ({
      body: { ...EMPTY, jurisdiction: 'DE', resultCount: 1, results: [LEGISLATION_HIT], partial: true, partialReason: 'SEARCH_INCOMPLETE' },
    }));
    expect(partial.data.partial).toBe(true);
    expect(partial.data.partialReason).toBe('SEARCH_INCOMPLETE');
    expect(partial.data.results).toHaveLength(1);

    const complete = await call('lex_national_semantic_legislation', { jurisdiction: 'de', query: 'Haftung' }, () => ({ body: EMPTY }));
    expect(complete.data.partial).toBeUndefined();
    expect(complete.data.partialReason).toBeUndefined();
  });

  it('both tool descriptions say results may be incomplete', () => {
    for (const name of ['lex_national_semantic_case_law', 'lex_national_semantic_legislation']) {
      expect(byName[name].description).toMatch(/SEARCH_INCOMPLETE/);
      expect(byName[name].description).toMatch(/incomplete/);
    }
  });
});

describe('503 NATIONAL_SEMANTIC_UNAVAILABLE + SEARCH_INCOMPLETE', () => {
  it('is retried once after Retry-After, and is not a rate-limit message', async () => {
    const { result, calls, sleeps, data } = await call('lex_national_semantic_case_law', { jurisdiction: 'cz', query: 'liability for damage' }, (_c, n) =>
      n === 1 ? { status: 503, body: INCOMPLETE_503, headers: { 'retry-after': '10' } } : { body: EMPTY });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([10_000]);
    expect(data.jurisdiction).toBe('CZ');
  });

  it('when it keeps coming back: retried once only, says NOT "no matches", gives the wait, never a rate limit', async () => {
    const { result, calls, text } = await call('lex_national_semantic_case_law', { jurisdiction: 'cz', query: 'liability for damage' }, () => ({
      status: 503, body: INCOMPLETE_503, headers: { 'retry-after': '10' },
    }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(text).toMatch(/LexAPI error 503 \(NATIONAL_SEMANTIC_UNAVAILABLE\)/);
    expect(text).toMatch(/NOT a "no matches" answer/);
    expect(text).toMatch(/Retry in 10 s/);
    expect(text).not.toMatch(/rate limit/i);
  });

  it('falls back to the body retryAfter when the header is missing', async () => {
    const { result, calls, sleeps } = await call('lex_national_semantic_case_law', { jurisdiction: 'cz', query: 'liability for damage' }, (_c, n) =>
      n === 1 ? { status: 503, body: { ...INCOMPLETE_503, retryAfter: 3 } } : { body: EMPTY });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('a wait above 10 s is not slept on; the message still gives it', async () => {
    const { result, calls, sleeps, text } = await call('lex_national_semantic_case_law', { jurisdiction: 'cz', query: 'liability for damage' }, (_c, n) =>
      n === 1 ? { status: 503, body: { ...INCOMPLETE_503, retryAfter: 30 }, headers: { 'retry-after': '30' } } : { body: EMPTY });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(text).toMatch(/Retry in 30 s/);
  });

  it('is not retried when too little of the deadline would be left after the wait', async () => {
    // 20 s deadline − 10 s wait leaves 10 s: below the minimum for a full attempt.
    const { client, calls, sleeps } = clockedClient((_c, n) =>
      n === 1 ? { status: 503, body: INCOMPLETE_503, headers: { 'retry-after': '10' } } : { body: EMPTY }, 20_000);
    const err = await client.nationalSemanticCaseLaw('CZ', { query: 'liability for damage' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LexAPIError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(describeError(err)).toMatch(/Retry in 10 s/);

    // With a longer deadline the same answer is retried once.
    const ok = clockedClient((_c, n) =>
      n === 1 ? { status: 503, body: INCOMPLETE_503, headers: { 'retry-after': '10' } } : { body: EMPTY }, 55_000);
    await ok.client.nationalSemanticCaseLaw('CZ', { query: 'liability for damage' });
    expect(ok.calls).toHaveLength(2);
    expect(ok.sleeps).toEqual([10_000]);
  });

  it('without a wait (repeatedly incomplete): not retried, says to try later or rephrase', async () => {
    const { result, calls, sleeps, text } = await call('lex_national_semantic_legislation', { jurisdiction: 'cz', query: 'liability for damage' }, (_c, n) =>
      n === 1 ? { status: 503, body: REPEATED_503 } : { body: EMPTY });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(text).toMatch(/repeatedly/);
    expect(text).toMatch(/rephrase/);
    expect(text).not.toMatch(/rate limit/i);
  });

  it('a plain 503 with Retry-After and a retryAfter body is a server error, not a rate limit', async () => {
    const { result, calls, text } = await call('lex_counterparts', { id: 'AT-NOR-1' }, () => ({
      status: 503, body: { success: false, error: 'Service unavailable', retryAfter: 5 }, headers: { 'retry-after': '5' },
    }));
    expect(result.isError).toBe(true);
    expect(calls.length).toBeGreaterThan(1); // the existing 503 backoff policy
    expect(text).toMatch(/LexAPI error 503/);
    expect(text).toMatch(/server error/);
    expect(text).not.toMatch(/rate limit/i);
  });
});

describe('422 NATIONAL_SEMANTIC_FILTER_UNREACHABLE', () => {
  it('is not retried and says to rephrase or change the filters', async () => {
    const { result, calls, text } = await call('lex_national_semantic_legislation', { jurisdiction: 'de', query: 'Haftung', filters: { inForce: true } }, (_c, n) =>
      n === 1 ? { status: 422, body: UNREACHABLE_422 } : { body: EMPTY });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(text).toMatch(/LexAPI error 422 \(NATIONAL_SEMANTIC_FILTER_UNREACHABLE\)/);
    expect(text).toMatch(/for DE/);
    expect(text).toMatch(/NOT a "no matches" answer/);
    expect(text).toMatch(/rephrase the query, or change or drop the filters/);
    expect(text).toMatch(/nothing was charged/);
  });
});

describe('lex_resolve verified / eli-cellar', () => {
  it('passes verified and resolvedVia through, and the description explains them', async () => {
    const { data } = await call('lex_resolve', { identifier: 'http://data.europa.eu/eli/dec/2019/166/oj' }, () => ({
      body: {
        success: true, identifier: 'http://data.europa.eu/eli/dec/2019/166/oj', identifierType: 'eli',
        resolvedVia: 'eli-cellar', verified: true, celex: '32019D0003(01)', urls: {},
      },
    }));
    expect(data.resolvedVia).toBe('eli-cellar');
    expect(data.verified).toBe(true);
    expect(byName.lex_resolve.description).toMatch(/eli-cellar/);
    expect(byName.lex_resolve.description).toMatch(/verified: false/);
  });
});
