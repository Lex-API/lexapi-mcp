import { describe, expect, it } from 'vitest';

import { LexAPIClient } from '../src/client.js';
import { LexAPIError, LexAPITransportError, describeError } from '../src/errors.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { clientWith } from './helpers.js';

describe('LexAPIClient request building', () => {
  it('sends the key in x-api-key, a JSON body and a versioned User-Agent', async () => {
    const { client, calls } = clientWith(() => ({ body: { success: true } }));
    await client.search({ query: 'gdpr', maxPages: 2 });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url.toString()).toBe('https://api.example.test/api/v1/search');
    expect(c.headers['x-api-key']).toBe('lex_test_secret_key');
    expect(c.headers['content-type']).toBe('application/json');
    expect(c.headers['user-agent']).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
    expect(c.body).toEqual({ query: 'gdpr', maxPages: 2 });
  });

  it('builds query strings, joins arrays and drops empty values', async () => {
    const { client, calls } = clientWith(() => ({ body: {} }));
    await client.exportCorpus({ documentType: ['Regulation', 'Directive'], language: undefined, limit: 5, includeStubs: '' });
    expect(calls[0].url.pathname).toBe('/api/v1/export');
    expect(calls[0].url.searchParams.get('documentType')).toBe('Regulation,Directive');
    expect(calls[0].url.searchParams.get('limit')).toBe('5');
    expect(calls[0].url.searchParams.has('language')).toBe(false);
    expect(calls[0].url.searchParams.has('includeStubs')).toBe(false);
  });

  it('URL-encodes path segments (corrigendum CELEX with parentheses)', async () => {
    const { client, calls } = clientWith(() => ({ body: {} }));
    await client.citedBy('32008R1272R(01)', {});
    expect(calls[0].url.pathname).toBe('/api/v1/citations/cited-by/32008R1272R(01)');
    await client.getAtDate('32016R0679', '2026-06-15', { language: 'de' });
    expect(calls[1].url.pathname).toBe('/api/v1/documents/32016R0679/at/2026-06-15');
    expect(calls[1].url.searchParams.get('language')).toBe('de');
  });

  it('uses the documented paths for every endpoint', async () => {
    const { client, calls } = clientWith(() => ({ body: {} }));
    await client.info();
    await client.getDocument({});
    await client.getDocumentsBatch({});
    await client.getMetadata({});
    await client.getDocumentByUrl({});
    await client.recentDocuments({});
    await client.resolve({});
    await client.listVersions('X', {});
    await client.getVersion('X', 2, {});
    await client.semanticCaseLaw({});
    await client.semanticLegislation({});
    await client.extractCitations({});
    await client.cites('X', {});
    await client.citationNetwork('X', {});
    await client.citationPath('A', 'B', {});
    await client.related('X', {});
    await client.citationStats();
    await client.listWebhooks();
    await client.getWebhook('w1');
    await client.webhookDeliveries('w1', {});
    await client.createWebhook({});
    await client.updateWebhook('w1', {});
    await client.testWebhook('w1');
    expect(calls.map((c) => `${c.method} ${c.url.pathname.replace('/api/v1', '')}`)).toEqual([
      'GET /info',
      'POST /documentContent',
      'POST /documentContent/batch',
      'POST /documents/metadata',
      'POST /documents/url',
      'GET /documents/recent',
      'POST /resolve',
      'GET /documents/X/versions',
      'GET /documents/X/versions/2',
      'POST /search/semantic',
      'POST /legislation/semantic',
      'POST /citations/extract',
      'GET /citations/cites/X',
      'GET /citations/network/X',
      'GET /citations/path/A/B',
      'GET /citations/related/X',
      'GET /citations/stats',
      'GET /webhooks',
      'GET /webhooks/w1',
      'GET /webhooks/w1/deliveries',
      'POST /webhooks',
      'PUT /webhooks/w1',
      'POST /webhooks/w1/test',
    ]);
  });

  it('keeps only the response headers that matter', async () => {
    const { client } = clientWith(() => ({
      body: { ok: 1 },
      headers: { 'x-source': 'corpus', 'x-language-fallback': 'en', 'set-cookie': 'a=b', 'ratelimit-remaining': '3' },
    }));
    const res = await client.getDocument({ celexNumber: '32016R0679' });
    expect(res.headers).toEqual({ 'x-source': 'corpus', 'x-language-fallback': 'en' });
  });

  it('parses NDJSON exports into lines', async () => {
    const { client } = clientWith(() => ({
      raw: '{"_meta":{"totalMatching":2}}\n{"celex":"A"}\n{"celex":"B"}\n{"_done":{"written":2}}\n',
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }));
    const res = await client.exportCorpus({});
    expect(res.body.lines).toHaveLength(4);
  });

  it('handles 204 No Content (webhook delete)', async () => {
    const { client } = clientWith(() => ({ status: 204 }));
    const res = await client.deleteWebhook('w1');
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('rejects an empty key', () => {
    expect(() => new LexAPIClient({ apiKey: '  ' })).toThrow(/apiKey is required/);
  });
});

describe('LexAPIClient retries', () => {
  it('retries a 429 once when Retry-After is short', async () => {
    const { client, calls, sleeps } = clientWith((_c, n) =>
      n === 1 ? { status: 429, body: { error: 'Rate limit exceeded' }, headers: { 'retry-after': '2' } } : { body: { ok: true } });
    const res = await client.info();
    expect(res.body).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('does not sleep on a long Retry-After; surfaces it instead', async () => {
    const { client, calls, sleeps } = clientWith(() => ({
      status: 429,
      body: { error: 'Rate limit exceeded', message: 'You can make up to 15 requests per minute', retryAfter: 42 },
      headers: { 'retry-after': '42' },
    }));
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPIError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(42);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries 500/502/503 once, never 504', async () => {
    const a = clientWith((_c, n) => (n === 1 ? { status: 502, body: {} } : { body: { ok: 1 } }));
    expect((await a.client.info()).body).toEqual({ ok: 1 });
    expect(a.calls).toHaveLength(2);

    const b = clientWith(() => ({ status: 504, body: { success: false, error: { code: 'TIMEOUT', message: 'Upstream EUR-Lex fetch timed out' } } }));
    const err = await b.client.getDocument({}).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    expect(b.calls).toHaveLength(1);
  });

  it('never retries 402 or 400', async () => {
    const { client, calls } = clientWith(() => ({ status: 402, body: { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted' } } }));
    await expect(client.semanticCaseLaw({ query: 'x' })).rejects.toMatchObject({ status: 402, code: 'CREDITS_EXHAUSTED' });
    expect(calls).toHaveLength(1);
  });

  it('does not auto-retry side-effecting calls (create / test / delete webhook)', async () => {
    const { client, calls } = clientWith(() => ({ status: 500, body: { error: 'Failed to create webhook' } }));
    await expect(client.createWebhook({ name: 'x' })).rejects.toBeInstanceOf(LexAPIError);
    await expect(client.testWebhook('w')).rejects.toBeInstanceOf(LexAPIError);
    await expect(client.deleteWebhook('w')).rejects.toBeInstanceOf(LexAPIError);
    expect(calls).toHaveLength(3);
  });

  it('turns network failures into a transport error without leaking the key', async () => {
    const client = new LexAPIClient({
      apiKey: 'lex_super_secret',
      fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
      sleep: async () => {},
    });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPITransportError);
    expect(err.timedOut).toBe(false);
    expect(describeError(err)).not.toContain('lex_super_secret');
  });

  it('reports a timeout as such', async () => {
    const client = new LexAPIClient({
      apiKey: 'lex_k',
      timeoutMs: 5000,
      fetch: (async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }) as typeof fetch,
    });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPITransportError);
    expect(err.timedOut).toBe(true);
    expect(describeError(err)).toMatch(/did not answer in time/);
  });
});
