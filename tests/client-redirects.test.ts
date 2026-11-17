// Redirects answered by the API: followed on the API's own origin (and from
// http to https on its host), never to another host. Two local servers stand
// in for the API and for the other host; the client uses the real fetch.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LexAPIClient, type UpstreamAuth } from '../src/client.js';
import { describeError, LexAPITransportError } from '../src/errors.js';
import { runTool } from '../src/server.js';
import { tools } from '../src/tools.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { mockFetch } from './helpers.js';

interface Seen { method: string; path: string; key?: string; authorization?: string; client?: string; contentType?: string; body: string }

const KEY = 'lex_redirect_test_key';
const apiSeen: Seen[] = [];
const otherSeen: Seen[] = [];
let api: Server;
let other: Server;
let apiOrigin: string;
let otherOrigin: string;
/** path → what the API stand-in answers; anything else is a 200 echoing the request. */
let routes: Record<string, (req: IncomingMessage, n: number) => { status: number; location?: string; body?: unknown }>;
/** The API stand-in waits this long before each answer. */
let delayMs = 0;

function record(list: Seen[], req: IncomingMessage, body: string): void {
  list.push({
    method: req.method ?? '',
    path: req.url ?? '',
    key: req.headers['x-api-key'] as string | undefined,
    authorization: req.headers.authorization,
    client: req.headers['x-lexapi-client'] as string | undefined,
    contentType: req.headers['content-type'],
    body,
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      record(apiSeen, req, raw);
      const path = (req.url ?? '').split('?')[0];
      const hits = apiSeen.filter((s) => s.path.split('?')[0] === path).length;
      const answer = routes[path]?.(req, hits) ?? { status: 200, body: { success: true, method: req.method, path: req.url } };
      setTimeout(() => {
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        if (answer.location) res.setHeader('location', answer.location);
        res.end(JSON.stringify(answer.body ?? {}));
      }, delayMs);
    });
  });
  other = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      record(otherSeen, req, raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, from: 'other' }));
    });
  });
  apiOrigin = await listen(api);
  otherOrigin = await listen(other);
});

afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => other.close(() => r()));
});

beforeEach(() => {
  apiSeen.length = 0;
  otherSeen.length = 0;
  routes = {};
  delayMs = 0;
});

const client = (opts: Partial<ConstructorParameters<typeof LexAPIClient>[0]> = {}) => new LexAPIClient({
  apiKey: KEY, baseUrl: `${apiOrigin}/api/v1`, sleep: async () => {}, mode: 'stdio', tool: 'lex_info', ...opts,
});
const HEADER = `lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; tool=lex_info`;

describe('a redirect on the API\'s own origin', () => {
  it('is followed, with the credential and the client header', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      apiSeen.length = 0;
      routes = { '/api/v1/info': () => ({ status, location: '/api/v2/info?moved=1' }) };
      const res = await client().info();
      expect(res.body, String(status)).toMatchObject({ success: true, method: 'GET', path: '/api/v2/info?moved=1' });
      expect(apiSeen.map((s) => [s.method, s.path, s.key, s.client]), String(status)).toEqual([
        ['GET', '/api/v1/info', KEY, HEADER],
        ['GET', '/api/v2/info?moved=1', KEY, HEADER],
      ]);
    }
    expect(otherSeen).toHaveLength(0);
  });

  it('an absolute Location on the same origin, and a chain of redirects, are followed', async () => {
    routes = {
      '/api/v1/info': () => ({ status: 302, location: `${apiOrigin}/a` }),
      '/a': () => ({ status: 307, location: 'b' }),
      '/b': () => ({ status: 308, location: '/api/v1/done' }),
    };
    const res = await client().info();
    expect(res.body).toMatchObject({ path: '/api/v1/done' });
    expect(apiSeen.map((s) => s.path)).toEqual(['/api/v1/info', '/a', '/b', '/api/v1/done']);
    expect(apiSeen.every((s) => s.key === KEY)).toBe(true);
  });

  it('303 after a POST is a GET without the body; 301 and 302 too; 307 and 308 repeat the POST', async () => {
    for (const [status, method] of [[303, 'GET'], [301, 'GET'], [302, 'GET'], [307, 'POST'], [308, 'POST']] as const) {
      apiSeen.length = 0;
      routes = { '/api/v1/search': () => ({ status, location: '/api/v1/search2' }) };
      const res = await client().search({ query: 'data protection' });
      expect(res.body, String(status)).toMatchObject({ method, path: '/api/v1/search2' });
      expect(apiSeen[0], String(status)).toMatchObject({ method: 'POST', body: '{"query":"data protection"}', contentType: 'application/json' });
      expect(apiSeen[1].method, String(status)).toBe(method);
      expect(apiSeen[1].body, String(status)).toBe(method === 'POST' ? '{"query":"data protection"}' : '');
      expect(apiSeen[1].contentType, String(status)).toBe(method === 'POST' ? 'application/json' : undefined);
      expect(apiSeen[1].key).toBe(KEY);
    }
  });

  it('PUT and DELETE keep their method on 301, 302, 307 and 308, and become a GET on 303', async () => {
    for (const status of [301, 302, 307, 308, 303]) {
      apiSeen.length = 0;
      routes = { '/api/v1/webhooks/w1': () => ({ status, location: '/api/v1/webhooks/w2' }) };
      await client().updateWebhook('w1', { name: 'n' });
      await client().deleteWebhook('w1');
      const want = status === 303 ? 'GET' : undefined;
      expect(apiSeen.map((s) => s.method), String(status)).toEqual(['PUT', want ?? 'PUT', 'DELETE', want ?? 'DELETE']);
      expect(apiSeen[1].body, String(status)).toBe(status === 303 ? '' : '{"name":"n"}');
    }
  });

  it('a redirect loop stops after 5 redirects, and is not retried', async () => {
    routes = { '/api/v1/info': () => ({ status: 302, location: '/api/v1/info' }) };
    const err = await client({ maxRetries: 3 }).info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPITransportError);
    expect(err.message).toBe('the API answered with more than 5 redirects in a row');
    expect(err.timedOut).toBe(false);
    expect(apiSeen).toHaveLength(6);
  });

  it('a 3xx without a Location is the API\'s answer, as before', async () => {
    routes = { '/api/v1/info': () => ({ status: 302, body: { error: 'moved', code: 'MOVED' } }) };
    const err = await client().info().catch((e) => e);
    expect(err).toMatchObject({ name: 'LexAPIError', status: 302 });
    expect(apiSeen).toHaveLength(1);
  });

  it('retries still work around a redirect: a 502 at the target is retried from the start', async () => {
    routes = {
      '/api/v1/info': () => ({ status: 307, location: '/api/v1/info2' }),
      '/api/v1/info2': (_req, n) => (n === 1 ? { status: 502 } : { status: 200, body: { success: true, ok: 1 } }),
    };
    const res = await client().info();
    expect(res.body).toMatchObject({ ok: 1 });
    expect(apiSeen.map((s) => s.path)).toEqual(['/api/v1/info', '/api/v1/info2', '/api/v1/info', '/api/v1/info2']);
  });

  it('the call\'s deadline covers the redirects, and cancellation stops them', async () => {
    // Each answer takes 150 ms: the 400 ms deadline ends the call before the fifth redirect.
    delayMs = 150;
    routes = { '/api/v1/info': () => ({ status: 302, location: '/api/v1/info' }) };
    const slow = await client({ timeoutMs: 400, maxRetries: 0 }).info().catch((e) => e);
    expect(slow).toBeInstanceOf(LexAPITransportError);
    expect(slow).toMatchObject({ timedOut: true, message: 'no response within 0 s' });
    expect(apiSeen.length).toBeLessThan(5);
    delayMs = 0;

    apiSeen.length = 0;
    const ctl = new AbortController();
    routes = { '/api/v1/info': (_req, n) => { if (n === 2) ctl.abort(); return { status: 302, location: '/api/v1/info' }; } };
    const cancelled = await client().forCall({ signal: ctl.signal }).info().catch((e) => e);
    expect(cancelled).toMatchObject({ cancelled: true });
    expect(apiSeen.length).toBeLessThanOrEqual(3);
  });
});

describe('a redirect to another host', () => {
  it('is not followed: no request reaches the other host, and the error names its origin only', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      apiSeen.length = 0;
      routes = { '/api/v1/info': () => ({ status, location: `${otherOrigin}/api/v1/info?token=abc` }) };
      const err = await client({ maxRetries: 3 }).info().catch((e) => e);
      expect(err, String(status)).toBeInstanceOf(LexAPITransportError);
      expect(err.message).toBe(`the API answered with a redirect to another host (${otherOrigin}), which is not followed`);
      expect(apiSeen, String(status)).toHaveLength(1); // not retried
      const text = describeError(err);
      expect(text).toContain(otherOrigin);
      expect(text).toMatch(/^Redirect not followed: .* not retryable\./);
      expect(text).not.toMatch(/Could not reach|and retry/);
      for (const t of [err.message, text, String(err.stack)]) {
        expect(t).not.toContain(KEY);
        expect(t).not.toContain('token=abc');
      }
    }
    expect(otherSeen).toHaveLength(0);
  });

  it('is refused after same-origin redirects too, for a POST, and for other schemes and hosts', async () => {
    routes = {
      '/api/v1/search': () => ({ status: 307, location: '/hop' }),
      '/hop': () => ({ status: 307, location: `${otherOrigin}/api/v1/search` }),
    };
    const err = await client().search({ query: 'q' }).catch((e) => e);
    expect(err.message).toContain(`another host (${otherOrigin})`);
    expect(apiSeen.map((s) => s.path)).toEqual(['/api/v1/search', '/hop']);
    expect(otherSeen).toHaveLength(0);

    const port = new URL(apiOrigin).port;
    for (const location of [
      `http://localhost:${port}/api/v1/info`, // another name for the same machine is another host
      `https://127.0.0.1:${port}/api/v1/info`, // the same host and port over https is another origin
      `//${new URL(otherOrigin).host}/x`,
      'https://user:pw@other.example/x',
    ]) {
      apiSeen.length = 0;
      routes = { '/api/v1/info': () => ({ status: 302, location }) };
      const e = await client().info().catch((x) => x);
      expect(e, location).toBeInstanceOf(LexAPITransportError);
      expect(e.message, location).toMatch(/redirect to another host \(\S+\), which is not followed$/);
      expect(e.message, location).not.toContain('pw');
      expect(apiSeen, location).toHaveLength(1);
    }
    expect(otherSeen).toHaveLength(0);
  });

  it('a target that is not http or https is refused by its scheme, never as "(null)"', async () => {
    for (const [location, scheme] of [
      ['ftp://127.0.0.1/x', 'ftp:'],
      ['javascript:alert(1)', 'javascript:'],
      ['data:text/plain,secret-data', 'data:'],
      ['file:///etc/passwd', 'file:'],
      ['mailto:someone@other.example', 'mailto:'],
    ]) {
      apiSeen.length = 0;
      routes = { '/api/v1/info': () => ({ status: 302, location }) };
      const e = await client({ maxRetries: 3 }).info().catch((x) => x);
      expect(e, location).toBeInstanceOf(LexAPITransportError);
      expect(e.message, location).toBe(`the API answered with a redirect to a target that is not http or https (${scheme}), which is not followed`);
      expect(describeError(e), location).not.toMatch(/null|alert|secret-data|passwd|someone|and retry/);
      expect(apiSeen, location).toHaveLength(1); // not retried
    }
    expect(otherSeen).toHaveLength(0);
  });

  it('a same-origin target with a user name or password is refused at once, without them in the error', async () => {
    const { host } = new URL(apiOrigin);
    for (const location of [`http://user:pw-secret@${host}/api/v1/info2`, `http://user-secret@${host}/api/v1/info2`]) {
      apiSeen.length = 0;
      routes = { '/api/v1/info': () => ({ status: 302, location }) };
      const e = await client({ maxRetries: 3 }).info().catch((x) => x);
      expect(e, location).toBeInstanceOf(LexAPITransportError);
      expect(e.message, location).toBe(`the API answered with a redirect whose target carries a user name or password (${apiOrigin}), which is not followed`);
      expect(apiSeen.map((s) => s.path), location).toEqual(['/api/v1/info']); // one request: not followed, not retried
      const text = describeError(e);
      expect(text).toMatch(/^Redirect not followed: /);
      for (const t of [e.message, text]) expect(t).not.toMatch(/secret|and retry/);
    }
  });

  it('a redirect loop is described as not retryable too', async () => {
    routes = { '/api/v1/info': () => ({ status: 302, location: '/api/v1/info' }) };
    const text = describeError(await client().info().catch((x) => x));
    expect(text).toMatch(/^Redirect not followed: the API answered with more than 5 redirects in a row\. .* not retryable\./);
  });

  it('through a tool call: a tool error that names the origin, without the key', async () => {
    routes = { '/api/v1/info': () => ({ status: 302, location: `${otherOrigin}/api/v1/info` }) };
    const result = await runTool(tools.find((t) => t.name === 'lex_info')!, {}, client());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`redirect to another host (${otherOrigin})`);
    expect(result.content[0].text).not.toContain(KEY);
    expect(otherSeen).toHaveLength(0);
  });
});

describe('the OAuth credential behaves the same', () => {
  const auth = (): UpstreamAuth & { asked: number } => ({
    asked: 0,
    headers() { this.asked += 1; return { authorization: 'Bearer exchanged-api-token' }; },
  });

  it('same origin: followed with the Bearer token and no x-api-key', async () => {
    routes = { '/api/v1/info': () => ({ status: 307, location: '/api/v1/info2' }) };
    const a = auth();
    const res = await new LexAPIClient({ auth: a, baseUrl: `${apiOrigin}/api/v1`, mode: 'hosted', tool: 'lex_info' }).info();
    expect(res.body).toMatchObject({ path: '/api/v1/info2' });
    expect(apiSeen.map((s) => [s.path, s.authorization, s.key, s.client])).toEqual([
      ['/api/v1/info', 'Bearer exchanged-api-token', undefined, `lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_info`],
      ['/api/v1/info2', 'Bearer exchanged-api-token', undefined, `lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_info`],
    ]);
    expect(a.asked).toBe(1);
  });

  it('another host: refused, nothing sent there, the token is not in the error', async () => {
    routes = { '/api/v1/info': () => ({ status: 302, location: `${otherOrigin}/api/v1/info` }) };
    const err = await new LexAPIClient({ auth: auth(), baseUrl: `${apiOrigin}/api/v1` }).info().catch((e) => e);
    expect(err).toBeInstanceOf(LexAPITransportError);
    expect(describeError(err)).toContain(otherOrigin);
    expect(describeError(err)).not.toContain('exchanged-api-token');
    expect(otherSeen).toHaveLength(0);
  });
});

describe('http to https on the same host', () => {
  // A stand-in fetch: http://api.example.test answers with the redirect under test.
  const upgrade = (location: string) => mockFetch((c) => (c.url.protocol === 'http:' && c.url.pathname === '/api/v1/info'
    ? { status: 301, headers: { location } }
    : { body: { success: true, at: c.url.href } }));

  it('is followed, with the credential', async () => {
    for (const location of ['https://api.example.test/api/v1/info', 'https://api.example.test:443/api/v1/info']) {
      const m = upgrade(location);
      const res = await new LexAPIClient({ apiKey: KEY, baseUrl: 'http://api.example.test/api/v1', fetch: m.fetch }).info();
      expect(res.body).toMatchObject({ at: 'https://api.example.test/api/v1/info' });
      expect(m.calls.map((c) => [c.url.href, c.headers['x-api-key']])).toEqual([
        ['http://api.example.test/api/v1/info', KEY],
        ['https://api.example.test/api/v1/info', KEY],
      ]);
    }
  });

  it('every request is made with redirect: "manual"', async () => {
    const inits: RequestInit[] = [];
    const m = upgrade('https://api.example.test/api/v1/info');
    const spy = ((input: string | URL | Request, init?: RequestInit) => { inits.push(init ?? {}); return m.fetch(input, init); }) as typeof fetch;
    await new LexAPIClient({ apiKey: KEY, baseUrl: 'http://api.example.test/api/v1', fetch: spy }).info();
    expect(inits.map((i) => i.redirect)).toEqual(['manual', 'manual']);
  });

  it('another host, another port, a subdomain or a downgrade is not', async () => {
    const cases: Array<[string, string]> = [
      ['http://api.example.test/api/v1', 'https://www.api.example.test/api/v1/info'],
      ['http://api.example.test/api/v1', 'https://example.test/api/v1/info'],
      ['http://api.example.test/api/v1', 'https://api.example.test:8443/api/v1/info'],
      ['http://api.example.test:8080/api/v1', 'https://api.example.test/api/v1/info'],
      ['http://api.example.test/api/v1', 'http://api.example.test:8080/api/v1/info'],
      ['https://api.example.test/api/v1', 'http://api.example.test/api/v1/info2'],
      ['https://api.example.test/api/v1', 'https://api.example.test.evil.test/api/v1/info'],
    ];
    for (const [baseUrl, location] of cases) {
      const m = mockFetch((c) => (c.url.pathname === '/api/v1/info' ? { status: 302, headers: { location } } : { body: {} }));
      const err = await new LexAPIClient({ apiKey: KEY, baseUrl, fetch: m.fetch }).info().catch((e) => e);
      expect(err, location).toBeInstanceOf(LexAPITransportError);
      expect(err.message, location).toContain(`another host (${new URL(location).origin})`);
      expect(m.calls, location).toHaveLength(1);
    }
  });
});
