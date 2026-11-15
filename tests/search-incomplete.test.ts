import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runTool } from '../src/server.js';
import { tools, type ToolDef } from '../src/tools.js';
import { clientWith, parseText } from './helpers.js';

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

describe('partial national semantic answers', () => {
  it('case law keeps partial / partialReason / hint', async () => {
    const { data } = await call('lex_national_semantic_case_law', { jurisdiction: 'at', query: 'Datenschutz' }, () => ({
      body: { ...EMPTY, jurisdiction: 'AT', partial: true, partialReason: 'SEARCH_INCOMPLETE', hint: 'A retry may return a complete answer.' },
    }));
    expect(data.partial).toBe(true);
    expect(data.partialReason).toBe('SEARCH_INCOMPLETE');
    expect(data.hint).toMatch(/retry/);
  });

  it('legislation keeps partial / partialReason; a complete answer has neither', async () => {
    const partial = await call('lex_national_semantic_legislation', { jurisdiction: 'de', query: 'Haftung' }, () => ({
      body: { ...EMPTY, jurisdiction: 'DE', partial: true, partialReason: 'SEARCH_INCOMPLETE' },
    }));
    expect(partial.data.partial).toBe(true);
    expect(partial.data.partialReason).toBe('SEARCH_INCOMPLETE');

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
    const { result, calls, sleeps, data } = await call('lex_national_semantic_case_law', { jurisdiction: 'cz', query: 'náhrada škody' }, (_c, n) =>
      n === 1 ? { status: 503, body: INCOMPLETE_503, headers: { 'retry-after': '10' } } : { body: EMPTY });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([10_000]);
    expect(data.jurisdiction).toBe('CZ');
  });

  it('when it keeps coming back: says NOT "no matches", gives the wait, never a rate limit', async () => {
    const { result, calls, text } = await call('lex_national_semantic_case_law', { jurisdiction: 'cz', query: 'náhrada škody' }, () => ({
      status: 503, body: INCOMPLETE_503, headers: { 'retry-after': '10' },
    }));
    expect(result.isError).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    expect(text).toMatch(/LexAPI error 503 \(NATIONAL_SEMANTIC_UNAVAILABLE\)/);
    expect(text).toMatch(/NOT a "no matches" answer/);
    expect(text).toMatch(/Retry in 10 s/);
    expect(text).not.toMatch(/rate limit/i);
  });

  it('without a wait (repeatedly incomplete): not retried, says to try later or rephrase', async () => {
    const { result, calls, sleeps, text } = await call('lex_national_semantic_legislation', { jurisdiction: 'cz', query: 'náhrada škody' }, (_c, n) =>
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
