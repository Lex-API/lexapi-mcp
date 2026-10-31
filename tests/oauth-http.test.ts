// The hosted server with OAuth on, end to end over HTTP against the local
// mock authorization server + API (tests/oauth-mock.ts): metadata, the
// challenge, exchange, bad tokens, revocation and API keys, plus PRM CORS,
// mixed-traffic isolation, read-only mode, Origin validation, gated
// exchange failures and log hygiene.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createHttpServer } from '../src/http-server.js';
import { tools } from '../src/tools.js';
import { CLIENT_SECRET, newSigningKey, publicKeyBytes, RESOURCE, signJwt, startMockAs, type MockAs } from './oauth-mock.js';

const CHALLENGE = 'Bearer realm="lexapi", resource_metadata="https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1", scope="lex"';
const KEY = `lex_test_${'ab'.repeat(32)}`;

let as: MockAs;
const servers: Server[] = [];
const issued: string[] = [];
const logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

async function start(extraEnv: Record<string, string> = {}, opts: { oauthOff?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = {
    LEXAPI_BASE_URL: as.apiBase,
    ...(opts.oauthOff ? {} : { LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer }),
    ...extraEnv,
  };
  const http = createHttpServer({ env });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  servers.push(http);
  return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, http };
}

function mint(opts: Parameters<MockAs['mint']>[0] = {}) {
  const t = as.mint(opts);
  issued.push(t);
  return t;
}

async function rpc(base: string, headers: Record<string, string>, method: string, params: unknown = {}, httpMethod = 'POST') {
  const r = await fetch(`${base}/v1`, {
    method: httpMethod,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    ...(httpMethod === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) } : {}),
  });
  const text = await r.text();
  const data = text.match(/^data: (.*)$/m);
  let json: any;
  try { json = JSON.parse(data ? data[1] : text); } catch { json = undefined; }
  return { status: r.status, headers: r.headers, text, json };
}

const INIT = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } };
const info = (base: string, headers: Record<string, string>) => rpc(base, headers, 'tools/call', { name: 'lex_info', arguments: {} });
const toolJson = (r: { json: any }) => JSON.parse(r.json.result.content[0].text);
const exchangesSince = (n: number) => as.seen.slice(n).filter((s) => s.path === '/oauth/token').length;
const apiCallsSince = (n: number) => as.seen.slice(n).filter((s) => s.path.startsWith('/api/v1/'));

beforeAll(async () => {
  as = await startMockAs();
  for (const m of ['error', 'warn', 'log'] as const) logSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
});

afterAll(async () => {
  // Nothing this suite did may have put a token or the client secret in a log line.
  const logged = logSpies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
  for (const t of issued) expect(logged).not.toContain(t);
  for (const s of as.seen) {
    if (s.authorization?.startsWith('Bearer ')) expect(logged).not.toContain(s.authorization.slice(7));
  }
  expect(logged).not.toContain(CLIENT_SECRET);
  for (const s of logSpies) s.mockRestore();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  await as.close();
});

describe('Protected Resource Metadata (RFC 9728)', () => {
  it('serves the same document at the path-inserted and root URLs, CORS *, cacheable', async () => {
    const { base } = await start();
    const want = {
      resource: RESOURCE,
      authorization_servers: [as.issuer],
      scopes_supported: ['lex'],
      bearer_methods_supported: ['header'],
      resource_name: 'LexAPI MCP server',
      resource_documentation: 'https://lex-api.com/docs#mcp-oauth',
    };
    for (const path of ['/.well-known/oauth-protected-resource/v1', '/.well-known/oauth-protected-resource']) {
      // A browser client on any origin (not in LEXAPI_MCP_ALLOWED_ORIGINS) can read it.
      const r = await fetch(`${base}${path}`, { headers: { origin: 'https://claude.ai', 'mcp-protocol-version': '2025-11-25' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(await r.json()).toEqual(want);
      const pre = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'GET', 'access-control-request-headers': 'mcp-protocol-version' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe('*');
      expect(pre.headers.get('access-control-allow-headers')).toMatch(/MCP-Protocol-Version/i);
      const head = await fetch(`${base}${path}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect((await fetch(`${base}${path}`, { method: 'POST' })).status).toBe(405);
    }
  });

  it('with OAuth off there is no metadata (0.3.0 behaviour)', async () => {
    const { base } = await start({}, { oauthOff: true });
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/v1`)).status).toBe(404);
    expect((await fetch(`${base}/health`).then((r) => r.json())).oauth).toBe(false);
  });
});

describe('the 401 challenge', () => {
  it('keyless initialize → 401 with exactly the expected header and body; every method on /v1', async () => {
    const { base } = await start();
    const r = await rpc(base, {}, 'initialize', INIT);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.json).toEqual({ error: 'unauthorized', error_description: 'Sign in with LexAPI or send an API key' });
    for (const m of ['GET', 'DELETE']) {
      const g = await rpc(base, {}, '', {}, m);
      expect(g.status).toBe(401);
      expect(g.headers.get('www-authenticate')).toBe(CHALLENGE);
    }
    // Readable by an allowed browser client.
    const { base: b2 } = await start({ LEXAPI_MCP_ALLOWED_ORIGINS: 'https://inspector.example' });
    const br = await rpc(b2, { origin: 'https://inspector.example' }, 'initialize', INIT);
    expect(br.status).toBe(401);
    expect(br.headers.get('access-control-expose-headers')).toMatch(/WWW-Authenticate/);
    expect(br.headers.get('access-control-allow-origin')).toBe('https://inspector.example');
  });

  it('a non-Bearer Authorization (Basic) is "no credential" → the challenge', async () => {
    const { base } = await start();
    const r = await rpc(base, { authorization: 'Basic dXNlcjpwYXNz' }, 'initialize', INIT);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  it('with OAuth off the keyless answer is 0.3.0’s, unchanged', async () => {
    const { base } = await start({}, { oauthOff: true });
    const r = await rpc(base, {}, 'initialize', INIT);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer realm="lexapi"');
    expect(r.json.error.code).toBe('unauthorized');
    expect(r.json.error.message).toMatch(/Missing API key/);
    // 0.3.0 order: a GET is a 405 before auth.
    expect((await rpc(base, {}, '', {}, 'GET')).status).toBe(405);
  });
});

describe('exchange once, call the API with the API token, never pass the inbound token through', () => {
  it('an SDK client connects (no exchange), a tool call exchanges once, the next one hits the cache', async () => {
    const { base } = await start();
    const token = mint({ sub: 'u_accept' });
    const start0 = as.seen.length;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/v1`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'oauth-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(tools.length);
    expect(exchangesSince(start0)).toBe(0); // initialize / tools/list need no API token

    const r1 = await client.callTool({ name: 'lex_info', arguments: {} });
    expect(JSON.parse((r1.content as any)[0].text).service).toBe('user:u_accept');
    expect(exchangesSince(start0)).toBe(1);
    const afterFirst = as.seen.length;
    const r2 = await client.callTool({ name: 'lex_get_document', arguments: { celexNumber: '32016R0679' } });
    expect(r2.isError).toBeFalsy();
    expect(exchangesSince(afterFirst)).toBe(0);
    await client.close();

    const apiCalls = apiCallsSince(start0);
    expect(apiCalls).toHaveLength(2);
    const apiToken = apiCalls[0].authorization!.replace(/^Bearer /, '');
    for (const c of apiCalls) {
      expect(c.authorization).toBe(`Bearer ${apiToken}`);
      expect(c.apiKey).toBeUndefined();
    }
    // The inbound token went nowhere but the token endpoint's subject_token.
    for (const s of as.seen.slice(start0)) {
      expect(s.authorization ?? '').not.toContain(token);
      if (s.path !== '/oauth/token') expect(s.body).not.toContain(token);
    }
    const claims = JSON.parse(Buffer.from(apiToken.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ aud: as.apiAudience, sub: 'u_accept' });
  });
});

describe('bad tokens → 401 invalid_token', () => {
  it('wrong aud (incl. the API audience), expired, unknown key, HS256, alg none, wrong typ', async () => {
    const { base } = await start();
    const now = Math.floor(Date.now() / 1000);
    const k = as.keys[0];
    const goodPayload = JSON.parse(Buffer.from(mint().split('.')[1], 'base64url').toString());
    const bad: Array<[string, string]> = [
      [mint({ claims: { aud: 'https://other.example/mcp' } }), 'wrong audience'],
      [mint({ claims: { aud: as.apiAudience } }), 'wrong audience'],
      [mint({ claims: { iat: now - 2000, exp: now - 120 } }), 'token expired'],
      [mint({ key: newSigningKey() }), 'unknown signing key'],
      [signJwt({ alg: 'HS256', typ: 'at+jwt', kid: k.kid }, goodPayload, publicKeyBytes(k)), 'unsupported algorithm'],
      [signJwt({ alg: 'none', typ: 'at+jwt', kid: k.kid }, goodPayload) + 'x', 'unsupported algorithm'],
      [mint({ header: { typ: 'JWT' } }), 'not an access token'],
      [mint({ claims: { iss: 'https://evil.example' } }), 'wrong issuer'],
    ];
    const before = as.seen.length;
    for (const [token, why] of bad) {
      issued.push(token);
      const r = await rpc(base, { authorization: `Bearer ${token}` }, 'initialize', INIT);
      expect(r.status, why).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token", error_description="${why}"`);
      expect(r.json).toEqual({ error: 'invalid_token', error_description: why });
    }
    expect(exchangesSince(before)).toBe(0);
    expect(apiCallsSince(before)).toHaveLength(0);
  });

  it('JWKS unreachable at cold start → 503 without a challenge (no re-auth storm)', async () => {
    as.jwksDown = true;
    try {
      const { base } = await start();
      const r = await rpc(base, { authorization: `Bearer ${mint()}` }, 'initialize', INIT);
      expect(r.status).toBe(503);
      expect(r.headers.get('www-authenticate')).toBeNull();
    } finally {
      as.jwksDown = false;
    }
  });
});

describe('revocation', () => {
  it('next call → API 401 → re-exchange 400 → the MCP client gets HTTP 401 invalid_token', async () => {
    const { base } = await start();
    const token = mint({ sub: 'u_rev', gid: 'g_rev' });
    const ok = await info(base, { authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(toolJson(ok).service).toBe('user:u_rev');

    as.revoke('g_rev');
    const before = as.seen.length;
    const r = await info(base, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(new RegExp(`^${CHALLENGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, error="invalid_token", error_description="subject_token rejected: grant revoked"$`));
    // The sequence on the wire: cached API token refused, one re-exchange, refused.
    const seq = as.seen.slice(before).map((s) => s.path);
    expect(seq).toEqual(['/api/v1/info', '/oauth/token']);

    // And with an SDK client the request fails with 401 (the client would now refresh / re-authorize).
    const client = new Client({ name: 'oauth-test', version: '1.0.0' });
    const err = await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      .then(() => client.callTool({ name: 'lex_info', arguments: {} }))
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/invalid_token|401|Unauthorized/i);
    expect(String(err?.message ?? err)).not.toContain(token);
  });
});

describe('API keys keep working and never touch the token endpoint', () => {
  it('x-api-key, Bearer lex_test_…, x-api-key winning over a Bearer JWT; malformed keys as before', async () => {
    const { base } = await start();
    const before = as.seen.length;
    const viaHeader = await info(base, { 'x-api-key': KEY });
    expect(toolJson(viaHeader).service).toBe(`key:${KEY}`);
    const viaBearer = await info(base, { authorization: `Bearer ${KEY}` });
    expect(toolJson(viaBearer).service).toBe(`key:${KEY}`);
    const both = await info(base, { 'x-api-key': 'lex_good_both', authorization: `Bearer ${mint()}` });
    expect(toolJson(both).service).toBe('key:lex_good_both');
    expect(exchangesSince(before)).toBe(0);
    for (const c of apiCallsSince(before)) expect(c.authorization).toBeUndefined();

    // A wrong key: still the API's 401 as a tool error, still no exchange.
    const wrong = await info(base, { authorization: `Bearer lex_live_${'0'.repeat(63)}x` });
    expect(wrong.status).toBe(200);
    expect(wrong.json.result.isError).toBe(true);
    expect(exchangesSince(before)).toBe(0);

    // A malformed x-api-key is refused locally — with OAuth on, the challenge points at sign-in.
    const malformed = await rpc(base, { 'x-api-key': 'lex_a lex_b' }, 'initialize', INIT);
    expect(malformed.status).toBe(401);
    expect(malformed.json.error.code).toBe('malformed_api_key');
    expect(malformed.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token", error_description="x-api-key is not a LexAPI API key"`);
    // An authenticated (API-key) GET is still 405.
    expect((await rpc(base, { 'x-api-key': KEY }, '', {}, 'GET')).status).toBe(405);
  });
});

describe('exchange misconfiguration, repeated API refusal, clock skew', () => {
  it('an exchange 400 without the "subject_token rejected: " prefix → 500 and a log line, never a 401 challenge', async () => {
    const { base } = await start();
    const spy = logSpies[0];
    const before = spy.mock.calls.length;
    as.tokenOverrides.push({ status: 400, body: { error: 'invalid_request', error_description: 'requested_token_type must be urn:ietf:params:oauth:token-type:access_token' } });
    const r = await info(base, { authorization: `Bearer ${mint({ sub: 'acc8' })}` });
    expect(r.status).toBe(500);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(spy.mock.calls.slice(before).flat().join('\n')).toMatch(/OAUTH CONFIGURATION PROBLEM/);
  });

  it('API 401 → re-exchange succeeds → API 401 again → one tool error + a log line; no challenge, no second re-exchange', async () => {
    const apiOnly401 = (async (u: string | URL, i?: RequestInit) => (String(u).includes('/api/v1/')
      ? new Response('{"error":"Invalid access token","message":"replica mid-deploy"}', { status: 401, headers: { 'www-authenticate': 'Bearer realm="lexapi", error="invalid_token", error_description="replica mid-deploy"' } })
      : fetch(u, i))) as typeof fetch;
    const http = createHttpServer({ env: { LEXAPI_BASE_URL: as.apiBase, LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer }, fetch: apiOnly401 });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    servers.push(http);
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const spy = logSpies[0];
    const logBefore = spy.mock.calls.length;
    const before = as.seen.length;
    const r = await info(base, { authorization: `Bearer ${mint({ sub: 'acc9' })}` });
    expect(r.status).toBe(200);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(r.json.result.isError).toBe(true);
    expect(exchangesSince(before)).toBe(2); // the first exchange + exactly one re-exchange
    expect(spy.mock.calls.slice(logBefore).flat().join('\n')).toMatch(/refused an exchanged token twice/);
  });

  it('a token whose exp passed 6 s ago → 401 invalid_token locally, no exchange', async () => {
    const { base } = await start();
    const now = Math.floor(Date.now() / 1000);
    const before = as.seen.length;
    const r = await info(base, { authorization: `Bearer ${mint({ claims: { iat: now - 900, exp: now - 6 } })}` });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token", error_description="token expired"`);
    expect(exchangesSince(before)).toBe(0);
  });
});

describe('per-request isolation (mixed API-key + OAuth traffic)', () => {
  it('60 concurrent calls from 10 OAuth users and 10 API keys each see only their own identity', async () => {
    const { base, http } = await start();
    const users = Array.from({ length: 10 }, (_, i) => ({ id: `iso_u${i}`, token: mint({ sub: `iso_u${i}` }) }));
    const keys = Array.from({ length: 10 }, (_, i) => `lex_good_iso_${i}`);
    const jobs: Array<{ headers: Record<string, string>; want: string }> = [];
    for (let round = 0; round < 3; round++) {
      users.forEach((u) => jobs.push({ headers: { authorization: `Bearer ${u.token}` }, want: `user:${u.id}` }));
      keys.forEach((k) => jobs.push({ headers: round % 2 ? { 'x-api-key': k } : { authorization: `Bearer ${k}` }, want: `key:${k}` }));
    }
    jobs.sort(() => Math.random() - 0.5);
    const before = as.seen.length;
    const results = await Promise.all(jobs.map((j) => info(base, j.headers).then((r) => ({ r, j }))));
    for (const { r, j } of results) {
      expect(r.status).toBe(200);
      expect(toolJson(r).service).toBe(j.want);
    }
    // One exchange per OAuth user (concurrent requests share it), none for keys.
    expect(exchangesSince(before)).toBe(10);
    expect(http.oauth!.exchanger.size).toBeGreaterThanOrEqual(10);
    // API-key calls carried no bearer; OAuth calls carried no key.
    for (const c of apiCallsSince(before)) expect(Boolean(c.apiKey) !== Boolean(c.authorization)).toBe(true);
  });
});

describe('modes and guards with OAuth on', () => {
  it('read-only mode hides and refuses webhook writes for OAuth callers', async () => {
    const { base } = await start({ LEXAPI_MCP_READ_ONLY: 'true' });
    const auth = { authorization: `Bearer ${mint({ sub: 'ro' })}` };
    const list = await rpc(base, auth, 'tools/list');
    const names = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('lex_delete_webhook');
    expect(names).not.toContain('lex_extract_citations');
    const call = await rpc(base, auth, 'tools/call', { name: 'lex_delete_webhook', arguments: { id: 'x' } });
    expect(call.json.result?.isError ?? Boolean(call.json.error)).toBe(true);
  });

  it('Origin validation still applies to /v1 (403 for unlisted browser origins)', async () => {
    const { base } = await start({ LEXAPI_MCP_ALLOWED_ORIGINS: 'https://ok.example' });
    const auth = { authorization: `Bearer ${mint()}` };
    expect((await rpc(base, { ...auth, origin: 'https://evil.example' }, 'tools/list')).status).toBe(403);
    const ok = await rpc(base, { ...auth, origin: 'https://ok.example' }, 'tools/list');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ok.example');
  });

  it('exchange misconfiguration → HTTP 503 / 500 (no re-auth challenge); 429 → an actionable tool error', async () => {
    const { base } = await start();
    const auth = { authorization: `Bearer ${mint({ sub: 'cfg' })}` };
    as.tokenOverrides.push({ status: 401, body: { error: 'invalid_client', error_description: 'client authentication failed' } });
    const a = await info(base, auth);
    expect(a.status).toBe(503);
    expect(a.headers.get('www-authenticate')).toBeNull();
    as.tokenOverrides.push({ status: 400, body: { error: 'invalid_target', error_description: 'resource must be …' } });
    const b = await info(base, auth);
    expect(b.status).toBe(500);
    as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable', error_description: 'Too many requests. Retry after 9 s.' }, headers: { 'retry-after': '9' } });
    const c = await info(base, auth);
    expect(c.status).toBe(200);
    expect(c.json.result.isError).toBe(true);
    expect(c.json.result.content[0].text).toMatch(/Wait 9 s/);
    // The next call works again once the backoff has passed.
    const { base: b2 } = await start();
    expect(toolJson(await info(b2, auth)).service).toBe('user:cfg');
  });

  it('responses on the OAuth path are never cacheable; health reports OAuth on', async () => {
    const { base } = await start();
    const r = await info(base, { authorization: `Bearer ${mint()}` });
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('cache-control')).toMatch(/private/);
    expect((await fetch(`${base}/health`).then((x) => x.json())).oauth).toBe(true);
  });

  it('a half-configured env refuses to start', () => {
    expect(() => createHttpServer({ env: { LEXAPI_OAUTH_CLIENT_SECRET: 'too-short' } })).toThrow(/at least 32/);
  });
});
