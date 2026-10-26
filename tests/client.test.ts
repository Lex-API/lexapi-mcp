import { describe, expect, it } from 'vitest';

import { combineSignals, LexAPIClient } from '../src/client.js';
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
    expect(() => new LexAPIClient({ apiKey: '  ' })).toThrow(/API key is missing/);
  });

  it('S4: rejects a malformed key without echoing it', () => {
    let msg = '';
    try { new LexAPIClient({ apiKey: 'lex_SECRET123\nlex_other' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/whitespace or control characters/);
    expect(msg).not.toContain('SECRET123');
  });

  it('S4: never forwards the runtime error text (undici quotes header values)', async () => {
    const client = new LexAPIClient({
      apiKey: 'lex_ok',
      fetch: (async () => { throw new TypeError('Headers.append: "lex_ok_SECRET" is an invalid header value.'); }) as typeof fetch,
      sleep: async () => {},
    });
    const err = await client.info().catch((e) => e);
    expect(describeError(err)).not.toContain('SECRET');
    expect(describeError(err)).toMatch(/invalid request header/);
    const refused = new LexAPIClient({
      apiKey: 'lex_ok',
      fetch: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch,
      sleep: async () => {},
    });
    expect(describeError(await refused.info().catch((e) => e))).toMatch(/network error ECONNREFUSED/);
  });

  it('S3: the call signal aborts the upstream request and is not retried', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const base = new LexAPIClient({
      apiKey: 'lex_ok',
      fetch: ((_u: unknown, init: RequestInit) => {
        calls++;
        return new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      }) as typeof fetch,
      sleep: async () => {},
    });
    const p = base.forCall({ signal: ctl.signal }).info().catch((e) => e);
    ctl.abort();
    const err = await p;
    expect(err).toBeInstanceOf(LexAPITransportError);
    expect(err.cancelled).toBe(true);
    expect(calls).toBe(1);
  });

  it('S3: default timeout stays under the 60 s MCP client default; forCall overrides it', () => {
    const c = new LexAPIClient({ apiKey: 'lex_ok' });
    expect(c.timeout).toBeLessThan(60_000);
    expect(c.forCall({ timeoutMs: 120_000 }).timeout).toBe(120_000);
  });
});

describe('F3: one deadline per call', () => {
  it('no 429 sleep when it would end past the deadline', async () => {
    let t = 0;
    const sleeps: number[] = [];
    let n = 0;
    const client = new LexAPIClient({
      apiKey: 'lex_k', timeoutMs: 55_000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
      fetch: (async () => { n++; t += 50_000; return new Response('{"error":"Rate limit exceeded"}', { status: 429, headers: { 'retry-after': '5' } }); }) as typeof fetch,
    });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPIError);
    expect(err.status).toBe(429);
    expect(n).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('no retry after a late network error; the error is reported instead', async () => {
    let t = 0;
    let n = 0;
    const client = new LexAPIClient({
      apiKey: 'lex_k', timeoutMs: 55_000, now: () => t, sleep: async (ms) => { t += ms; },
      fetch: (async () => { n++; t += 54_000; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }) as typeof fetch,
    });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPITransportError);
    expect(n).toBe(1);
  });

  it('retries early failures inside the deadline, and each attempt only gets what remains', async () => {
    let t = 0;
    const budgets: number[] = [];
    const client = new LexAPIClient({
      apiKey: 'lex_k', timeoutMs: 55_000, now: () => t, sleep: async (ms) => { t += ms; },
      fetch: (async (_u: unknown, init: RequestInit) => {
        budgets.push(t);
        t += 10_000;
        void init;
        return budgets.length === 1 ? new Response('{}', { status: 503 }) : new Response('{"ok":1}', { status: 200 });
      }) as typeof fetch,
    });
    expect((await client.info()).body).toEqual({ ok: 1 });
    expect(budgets).toEqual([0, 11_000]); // second attempt starts 10 s + 1 s backoff in
  });

  it('fails fast once the whole-call deadline has passed', async () => {
    let t = 0;
    let n = 0;
    const client = new LexAPIClient({
      apiKey: 'lex_k', timeoutMs: 5_000, maxRetries: 3, now: () => t, sleep: async (ms) => { t += ms; },
      fetch: (async () => { n++; t += 4_000; return new Response('{}', { status: 500 }); }) as typeof fetch,
    });
    await expect(client.info()).rejects.toBeInstanceOf(LexAPIError);
    expect(n).toBe(1); // 4 s used, a 1 s backoff would leave < 2 s
  });
});

describe('F6: combineSignals fallback (Node < 20.3, no AbortSignal.any)', () => {
  it('removes its listeners when disposed', () => {
    const any = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;
    try {
      const added: string[] = [];
      const removed: string[] = [];
      const fake = (name: string) => ({
        aborted: false,
        addEventListener: (_t: string, _f: unknown) => { added.push(name); },
        removeEventListener: (_t: string, _f: unknown) => { removed.push(name); },
      }) as unknown as AbortSignal;
      const c = combineSignals(fake('call'), fake('timeout'));
      expect(added).toEqual(['call', 'timeout']);
      c.dispose();
      expect(removed.sort()).toEqual(['call', 'timeout']);
    } finally {
      (AbortSignal as any).any = any;
    }
  });

  it('still aborts when either signal fires', () => {
    const any = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;
    try {
      const a = new AbortController();
      const c = combineSignals(a.signal, new AbortController().signal);
      a.abort();
      expect(c.signal.aborted).toBe(true);
    } finally {
      (AbortSignal as any).any = any;
    }
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
