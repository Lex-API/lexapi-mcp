// Security regression tests for the OAuth mode. Everything runs against the
// local mock authorization server (tests/oauth-mock.ts); tests/setup.ts
// refuses non-local hosts and fails any test that lets an inbound credential
// reach /api/v1.
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASE_URL } from '../src/client.js';
import { classifyCredential, clientIp, MAX_CREDENTIAL_LENGTH } from '../src/credentials.js';
import { createHttpServer, PROXY_MISMATCH_ALERT_MS, SSE_KEEP_ALIVE_MS, toWebRequest } from '../src/http-server.js';
import { readCappedText, ResponseTooLargeError } from '../src/oauth/body.js';
import { EXCHANGE_DEADLINE_MS, ExchangeError, LIMITS, subjectKey, TokenExchanger } from '../src/oauth/exchange.js';
import {
  InvalidTokenError, JWKS_MAX_STALE_MS, JWKS_MIN_TTL_MS, JWKS_RETRY_MIN_MS, JwksCache, JwksUnavailableError,
  looksLikeJwt, MAX_TOKEN_LENGTH, verifyAccessToken,
} from '../src/oauth/jwt.js';
import { clientFromEnv, PROGRESS_INTERVAL_MS } from '../src/server.js';
import { CLIENT_ID, CLIENT_SECRET, newSigningKey, RESOURCE, startMockAs, type MockAs } from './oauth-mock.js';

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const KEY = `lex_test_${'cd'.repeat(32)}`;
const HEALTH_TOKEN = 'operator-health-token-0123456789abcdef';

let as: MockAs;
const servers: Server[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  as = await startMockAs();
  logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  const logged = logSpy.mock.calls.flat().map(String).join('\n');
  expect(logged).not.toContain(CLIENT_SECRET);
  logSpy.mockRestore();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  await as.close();
});

async function start(extraEnv: Record<string, string> = {}, opts: { oauthOff?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = {
    LEXAPI_BASE_URL: as.apiBase,
    ...(opts.oauthOff ? {} : { LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer }),
    LEXAPI_MCP_HEALTH_TOKEN: HEALTH_TOKEN,
    ...extraEnv,
  };
  const http = createHttpServer({ env });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  servers.push(http);
  return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, http };
}

async function call(base: string, headers: Record<string, string>) {
  const r = await fetch(`${base}/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lex_info', arguments: {} } }),
  });
  const text = await r.text();
  const data = text.match(/^data: (.*)$/m);
  let json: any;
  try { json = JSON.parse(data ? data[1] : text); } catch { json = undefined; }
  return { status: r.status, www: r.headers.get('www-authenticate'), json };
}

const since = (n: number) => as.seen.slice(n);
const tokenCalls = (n: number) => since(n).filter((s) => s.path === '/oauth/token').length;
const apiCalls = (n: number) => since(n).filter((s) => s.path.startsWith('/api/v1/'));
const expOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp as number;

/** The other valid ECDSA form of the same signature (s → n − s): same signed bytes, different string. */
function malleate(token: string): string {
  const [h, p, s] = token.split('.');
  const sig = Buffer.from(s, 'base64url');
  const sv = BigInt(`0x${sig.subarray(32).toString('hex')}`);
  const s2 = Buffer.from((P256_N - sv).toString(16).padStart(64, '0'), 'hex');
  return `${h}.${p}.${Buffer.concat([sig.subarray(0, 32), s2]).toString('base64url')}`;
}

/** The same signature segment with unused trailing bits set (decodes to the same bytes). */
function trailingBitVariant(token: string): string {
  const [h, p, s] = token.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(s[s.length - 1]);
  return `${h}.${p}.${s.slice(0, -1)}${alphabet[last ^ 0b0001]}`;
}

const exchanger = (o: Partial<ConstructorParameters<typeof TokenExchanger>[0]> = {}) => new TokenExchanger({
  tokenEndpoint: `${as.issuer}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiAudience: as.apiAudience,
  sleep: async () => {}, ...o,
});

describe('refused exchanges cannot drain the shared exchange budget', () => {
  it('a revoked token replayed 20× serially and 50× concurrently costs ONE exchange (negative cache)', async () => {
    const { base } = await start();
    const t = as.mint({ sub: 's1_attacker', gid: 'g_s1_attacker' });
    as.revoke('g_s1_attacker');
    const before = as.seen.length;
    for (let i = 0; i < 20; i++) {
      const r = await call(base, { authorization: `Bearer ${t}` });
      expect(r.status).toBe(401);
      expect(r.www).toMatch(/error="invalid_token", error_description="subject_token rejected: grant revoked"/);
    }
    const rs = await Promise.all(Array.from({ length: 50 }, () => call(base, { authorization: `Bearer ${t}` })));
    expect(rs.every((r) => r.status === 401)).toBe(true);
    expect(tokenCalls(before)).toBe(1);
  });

  it('the s → n−s twin of a token shares its cache entries; non-canonical base64url is refused locally', async () => {
    const t = as.mint({ sub: 's1_twin', gid: 'g_s1_twin' });
    const twin = malleate(t);
    expect(twin).not.toBe(t);
    // ECDSA signers may emit either form, so both are genuine: both verify…
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json` });
    await expect(verifyAccessToken(twin, { issuer: as.issuer, audience: RESOURCE, jwks })).resolves.toBeTruthy();
    // …but they are ONE token for every cache and limit.
    expect(subjectKey(twin)).toBe(subjectKey(t));
    as.revoke('g_s1_twin');
    const ex = exchanger();
    await expect(ex.getApiToken(t, expOf(t))).rejects.toMatchObject({ kind: 'invalid_token' });
    await expect(ex.getApiToken(twin, expOf(twin))).rejects.toMatchObject({ kind: 'invalid_token' });
    expect(ex.exchanges).toBe(1);
    // Trailing-bit variants (16 spellings of one signature) never get as far as an exchange.
    await expect(verifyAccessToken(trailingBitVariant(t), { issuer: as.issuer, audience: RESOURCE, jwks })).rejects.toThrow('malformed token');
    const { base } = await start();
    const before = as.seen.length;
    const r = await call(base, { authorization: `Bearer ${trailingBitVariant(as.mint())}` });
    expect(r.status).toBe(401);
    expect(tokenCalls(before)).toBe(0);
  });

  it('the negative cache is bounded and ends with the token (exp + leeway)', async () => {
    let t = Date.now();
    const ex = exchanger({ maxEntries: 2, now: () => t });
    const refused = Array.from({ length: 3 }, (_, i) => {
      const tok = as.mint({ sub: `neg_${i}`, gid: `g_neg_${i}` });
      as.revoke(`g_neg_${i}`);
      return tok;
    });
    for (const r of refused) await expect(ex.getApiToken(r, expOf(r))).rejects.toMatchObject({ kind: 'invalid_token' });
    expect(ex.negativeSize).toBe(2);
    // Remembered while the token lives…
    const n = ex.exchanges;
    await expect(ex.getApiToken(refused[2], expOf(refused[2]))).rejects.toMatchObject({ kind: 'invalid_token' });
    expect(ex.exchanges).toBe(n);
    // …and forgotten once it has expired (it is refused locally from then on anyway).
    t = (expOf(refused[2]) + 6) * 1000;
    await ex.getApiToken(refused[2], expOf(refused[2])).catch(() => {});
    expect(ex.exchanges).toBe(n + 1);
  });

  it('per-token limit: a token whose exchanges keep failing (not cacheable) is cut off locally', async () => {
    let requests = 0;
    const ex = exchanger({ fetch: (async () => { requests++; return new Response('{"error":"server_error"}', { status: 500 }); }) as typeof fetch });
    const t = as.mint();
    for (let i = 0; i < 6; i++) await expect(ex.getApiToken(t, expOf(t))).rejects.toMatchObject({ kind: 'upstream' });
    const sent = requests;
    const err = await ex.getApiToken(t, expOf(t)).catch((e) => e);
    expect(err).toBeInstanceOf(ExchangeError);
    expect(err).toMatchObject({ kind: 'rate_limited' });
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(requests).toBe(sent);
    expect(ex.stats().locallyLimited).toBe(1);
  });

  it('per-IP limit: a flood from one address throttles refused accounts, never a clean one', async () => {
    const ex = exchanger({ limits: { refusedPerIpPerMin: 3 } });
    const IP = '203.0.113.7';
    const revokedToken = (sub: string, gid: string) => {
      const t = as.mint({ sub, gid });
      as.revoke(gid);
      return t;
    };
    for (let i = 0; i < 3; i++) {
      const t = revokedToken(`s1_ip_${i}`, `g_s1_ip_${i}`);
      await expect(ex.getApiToken(t, expOf(t), undefined, { ip: IP, sub: `s1_ip_${i}` })).rejects.toMatchObject({ kind: 'invalid_token' });
    }
    expect(ex.exchanges).toBe(3);
    // An already-refused account minting fresh tokens from that address gets no further exchange.
    for (let j = 0; j < 3; j++) {
      const t = revokedToken('s1_ip_0', `g_s1_ip_0_${j}`);
      await expect(ex.getApiToken(t, expOf(t), undefined, { ip: IP, sub: 's1_ip_0' })).rejects.toMatchObject({ kind: 'rate_limited' });
    }
    expect(ex.exchanges).toBe(3);
    // A user with no refusal of their own, from the SAME address, is never stopped by the address.
    const clean = as.mint({ sub: 's1_ip_clean' });
    expect(await ex.getApiToken(clean, expOf(clean), undefined, { ip: IP, sub: 's1_ip_clean' })).toMatch(/\./);
    // The refused account from another address is limited only by its own per-user count.
    const elsewhere = revokedToken('s1_ip_1', 'g_s1_ip_1_b');
    await expect(ex.getApiToken(elsewhere, expOf(elsewhere), undefined, { ip: '198.51.100.1', sub: 's1_ip_1' })).rejects.toMatchObject({ kind: 'invalid_token' });
  });

  it('per-user limit on refused exchanges (independent of the address)', async () => {
    const ex = exchanger({ limits: { refusedPerSubPer10Min: 2 } });
    for (let i = 0; i < 2; i++) {
      const t = as.mint({ sub: 's1_sub', gid: `g_s1_sub_${i}` });
      as.revoke(`g_s1_sub_${i}`);
      await expect(ex.getApiToken(t, expOf(t), undefined, { sub: 's1_sub', ip: `192.0.2.${i}` })).rejects.toMatchObject({ kind: 'invalid_token' });
    }
    const t = as.mint({ sub: 's1_sub', gid: 'g_s1_sub_x' });
    await expect(ex.getApiToken(t, expOf(t), undefined, { sub: 's1_sub', ip: '192.0.2.99' })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(ex.exchanges).toBe(2);
  });

  it('429 temporarily_unavailable + Retry-After: every new exchange waits it out, then ONE probe goes first (no stampede)', async () => {
    let t = 1_000_000;
    let release!: () => void;
    let hold: Promise<void> | null = null;
    let requests = 0;
    const f = (async (u: string, i: RequestInit) => {
      requests++;
      if (hold) await hold;
      return fetch(u, i);
    }) as typeof fetch;
    const ex = exchanger({ now: () => t, fetch: f });
    const cached = as.mint({ sub: 'rl_cached' });
    const apiToken = await ex.getApiToken(cached, expOf(cached));
    as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable', error_description: 'Too many requests. Retry after 7 s.' }, headers: { 'retry-after': '7' } });
    const first = as.mint({ sub: 'rl_first' });
    const e1 = await ex.getApiToken(first, expOf(first)).catch((e) => e);
    expect(e1).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 7 });
    const sent = requests;
    // During the backoff: no request at all, the remaining wait is reported; cached tokens keep working.
    t += 3_000;
    const others = Array.from({ length: 5 }, (_, i) => as.mint({ sub: `rl_other_${i}` }));
    for (const o of others) await expect(ex.getApiToken(o, expOf(o))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 4 });
    expect(requests).toBe(sent);
    expect(await ex.getApiToken(cached, expOf(cached))).toBe(apiToken);
    expect(ex.stats().backoffSeconds).toBe(4);
    // Backoff over: one probe goes out, the rest are held back until it answers.
    t += 5_000;
    hold = new Promise<void>((r) => { release = r; });
    const probe = ex.getApiToken(others[0], expOf(others[0]));
    const rest = await Promise.all(others.slice(1).map((o) => ex.getApiToken(o, expOf(o)).catch((e) => e)));
    expect(rest.every((e) => e instanceof ExchangeError && e.kind === 'rate_limited')).toBe(true);
    expect(requests).toBe(sent + 1);
    release();
    hold = null;
    expect(await probe).toMatch(/\./);
    // Recovered: normal exchanges again.
    expect(await ex.getApiToken(others[1], expOf(others[1]))).toMatch(/\./);
  });

  it('over HTTP at hops=0 behind ONE proxy address: 31 refused accounts do not lock out a new user (no global lockout)', async () => {
    // Every request comes from 127.0.0.1 — exactly what a server sees behind a
    // proxy with LEXAPI_MCP_TRUST_PROXY_HOPS left at 0.
    const { base } = await start();
    const before = as.seen.length;
    for (let i = 0; i < 31; i++) {
      const t = as.mint({ sub: `r21_${i}`, gid: `g_r21_${i}` });
      as.revoke(`g_r21_${i}`);
      expect((await call(base, { authorization: `Bearer ${t}` })).status).toBe(401);
    }
    expect(tokenCalls(before)).toBe(31);
    const innocent = await call(base, { authorization: `Bearer ${as.mint({ sub: 'r21_innocent', gid: 'g_r21_innocent' })}` });
    expect(innocent.status).toBe(200);
    expect(innocent.json.result.isError).toBeFalsy();
    expect(JSON.parse(innocent.json.result.content[0].text).service).toBe('user:r21_innocent');
    // The flood is still throttled: refused accounts get no further exchange from that address.
    const mark = as.seen.length;
    for (let j = 0; j < 5; j++) {
      const t = as.mint({ sub: 'r21_0', gid: `g_r21_0_${j}` });
      as.revoke(`g_r21_0_${j}`);
      const r = await call(base, { authorization: `Bearer ${t}` });
      expect(r.json.result.content[0].text).toMatch(/rate limited/);
    }
    expect(tokenCalls(mark)).toBe(0);
  });

  it('over HTTP the per-IP limit keys on the client address (X-Forwarded-For with LEXAPI_MCP_TRUST_PROXY_HOPS=1)', async () => {
    const saved = LIMITS.refusedPerIpPerMin;
    LIMITS.refusedPerIpPerMin = 2;
    try {
      const { base } = await start({ LEXAPI_MCP_TRUST_PROXY_HOPS: '1' });
      const revoked = (sub: string, gid: string) => {
        const t = as.mint({ sub, gid });
        as.revoke(gid);
        return t;
      };
      const before = as.seen.length;
      for (let i = 0; i < 2; i++) expect((await call(base, { authorization: `Bearer ${revoked(`ip_http_${i}`, `g_ip_http_${i}`)}`, 'x-forwarded-for': '203.0.113.9' })).status).toBe(401);
      // A refused account from that address, behind a spoofed left entry, is held back…
      const limited = await call(base, { authorization: `Bearer ${revoked('ip_http_0', 'g_ip_http_0b')}`, 'x-forwarded-for': 'spoofed, 203.0.113.9' });
      expect(limited.status).toBe(200);
      expect(limited.json.result.content[0].text).toMatch(/rate limited/);
      expect(tokenCalls(before)).toBe(2);
      // …the same account from another address is not (the address is what counts).
      expect((await call(base, { authorization: `Bearer ${revoked('ip_http_0', 'g_ip_http_0c')}`, 'x-forwarded-for': '198.51.100.20' })).status).toBe(401);
      expect(tokenCalls(before)).toBe(3);
    } finally {
      LIMITS.refusedPerIpPerMin = saved;
    }
  });

  it('503 temporarily_unavailable backs off too (gated as a 503, never a re-auth)', async () => {
    let t = 2_000_000;
    const ex = exchanger({ now: () => t });
    as.tokenOverrides.push({ status: 503, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '3' } });
    const a = as.mint();
    await expect(ex.getApiToken(a, expOf(a))).rejects.toMatchObject({ kind: 'unavailable', retryAfterSeconds: 3 });
    const before = ex.exchanges;
    t += 1_000;
    const b = as.mint();
    await expect(ex.getApiToken(b, expOf(b))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(ex.exchanges).toBe(before);
  });
});

describe('client authentication refused (429s after repeated invalid_client)', () => {
  it('a 401 invalid_client is a config alarm (503), and the 429s that follow say why', async () => {
    const before = logSpy.mock.calls.length;
    const ex = exchanger();
    as.tokenOverrides.push({ status: 401, body: { error: 'invalid_client', error_description: 'client authentication failed' }, headers: { 'www-authenticate': 'Basic realm="lexapi"' } });
    const a = as.mint();
    await expect(ex.getApiToken(a, expOf(a))).rejects.toMatchObject({ kind: 'client_auth' });
    as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable', error_description: 'Too many requests. Retry after 840 s.' }, headers: { 'retry-after': '840' } });
    const b = as.mint();
    await expect(ex.getApiToken(b, expOf(b))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 300 });
    const lines = logSpy.mock.calls.slice(before).flat().join('\n');
    expect(lines).toMatch(/client authentication refused/);
    expect(lines).toMatch(/follows refused client authentication: check LEXAPI_OAUTH_CLIENT_SECRET/);
    expect(ex.stats()).toMatchObject({ clientAuthErrors: 1, rateLimited: 1 });
  });
});

describe('the inbound token never reaches /api/v1, and bad Bearers are challenged', () => {
  it('a padded token, an oversized token, and a token in x-api-key are refused with 401 and never forwarded', async () => {
    const { base } = await start();
    const t = as.mint({ sub: 's2' });
    const big = as.mint({ sub: 's2_big', claims: { pad: 'a'.repeat(9000) } });
    const before = as.seen.length;
    for (const headers of <Array<Record<string, string>>>[
      { authorization: `Bearer ${t}=` },
      { authorization: `Bearer ${t}==` },
      { authorization: `Bearer ${big}` },
      { 'x-api-key': t },
      { 'x-api-key': ` ${t} ` },
      { 'x-api-key': `${t}=` },
      { 'x-api-key': t, authorization: `Bearer ${KEY}` },
    ]) {
      const r = await call(base, headers);
      expect(r.status, JSON.stringify(Object.keys(headers))).toBe(401);
      expect(r.www).toMatch(/error="invalid_token"/);
    }
    expect(apiCalls(before)).toHaveLength(0);
    expect(tokenCalls(before)).toBe(0);
  });

  it('a garbage Bearer gets HTTP 401 invalid_token (not 200 + a tool error)', async () => {
    const { base } = await start();
    const before = as.seen.length;
    for (const v of ['not-a-key', 'abc', 'lex_live_abc.def', 'Zm9v', `${'a'.repeat(MAX_CREDENTIAL_LENGTH + 10)}`]) {
      const r = await call(base, { authorization: `Bearer ${v}` });
      expect(r.status, v.slice(0, 20)).toBe(401);
      expect(r.www).toMatch(/resource_metadata=.*error="invalid_token", error_description="malformed token"/);
    }
    expect(since(before)).toHaveLength(0);
  });

  it('with OAuth off a token-shaped credential is refused too (0.3.0 response shape), never forwarded as a key', async () => {
    const { base } = await start({}, { oauthOff: true });
    const t = as.mint({ sub: 's2_off' });
    const before = as.seen.length;
    for (const headers of <Array<Record<string, string>>>[{ authorization: `Bearer ${t}` }, { 'x-api-key': t }, { authorization: `Bearer ${'a'.repeat(MAX_CREDENTIAL_LENGTH + 1)}` }]) {
      const r = await call(base, headers);
      expect(r.status).toBe(401);
      expect(r.www).toBe('Bearer realm="lexapi", error="invalid_token"');
      expect(r.json.error.code).toBe('malformed_api_key');
    }
    expect(since(before)).toHaveLength(0);
    // Keys still work, with OAuth off as before.
    expect(JSON.parse((await call(base, { authorization: `Bearer ${KEY}` })).json.result.content[0].text).service).toBe(`key:${KEY}`);
    expect(JSON.parse((await call(base, { 'x-api-key': `  ${KEY}  ` })).json.result.content[0].text).service).toBe(`key:${KEY}`);
  });

  it('classification table (OAuth on / off)', () => {
    const req = (headers: Record<string, string>) => ({ headers, socket: {} }) as unknown as IncomingMessage;
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln';
    const on = (h: Record<string, string>) => classifyCredential(req(h), true);
    const off = (h: Record<string, string>) => classifyCredential(req(h), false);
    expect(on({})).toEqual({ kind: 'none' });
    expect(on({ authorization: 'Basic dXNlcjpwYXNz' })).toEqual({ kind: 'none' });
    expect(on({ authorization: `Bearer ${KEY}` })).toEqual({ kind: 'apiKey', key: KEY });
    expect(on({ authorization: `bearer   ${KEY}   ` })).toEqual({ kind: 'apiKey', key: KEY });
    expect(on({ authorization: `Bearer ${jwt}` })).toEqual({ kind: 'oauth', token: jwt });
    expect(on({ authorization: 'Bearer not-a-key' })).toEqual({ kind: 'oauth', token: 'not-a-key' });
    expect(on({ authorization: `Bearer ${'x'.repeat(MAX_CREDENTIAL_LENGTH + 20)}` })).toMatchObject({ kind: 'rejected', reason: 'too_long' });
    expect(on({ 'x-api-key': KEY, authorization: `Bearer ${jwt}` })).toEqual({ kind: 'apiKey', key: KEY });
    expect(on({ 'x-api-key': jwt })).toMatchObject({ kind: 'rejected', header: 'x-api-key', reason: 'token_as_api_key' });
    expect(on({ 'x-api-key': 'garbage' })).toMatchObject({ kind: 'rejected', reason: 'not_an_api_key' });
    expect(on({ 'x-api-key': 'k'.repeat(MAX_CREDENTIAL_LENGTH + 1) })).toMatchObject({ kind: 'rejected', reason: 'too_long' });
    expect(off({ authorization: `Bearer ${KEY}` })).toEqual({ kind: 'apiKey', key: KEY });
    expect(off({ 'x-api-key': 'legacy-key-shape' })).toEqual({ kind: 'apiKey', key: 'legacy-key-shape' });
    expect(off({ authorization: `Bearer ${jwt}` })).toMatchObject({ kind: 'rejected', reason: 'token_as_api_key' });
    expect(off({ 'x-api-key': jwt })).toMatchObject({ kind: 'rejected', reason: 'token_as_api_key' });
    expect(off({ authorization: `Bearer ${'k'.repeat(MAX_CREDENTIAL_LENGTH + 20)}` })).toMatchObject({ kind: 'rejected', reason: 'too_long' });
  });

  it('client address for the per-IP limit: socket peer, or the N-th X-Forwarded-For entry from the right', () => {
    const req = (xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '10.0.0.5' } }) as unknown as IncomingMessage;
    expect(clientIp(req('1.2.3.4'), 0)).toBe('10.0.0.5');
    expect(clientIp(req('spoofed, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(req('spoofed, 1.2.3.4, 172.16.0.1'), 2)).toBe('1.2.3.4');
    expect(clientIp(req(), 1)).toBe('10.0.0.5');
  });
});

describe('JWKS: never block on a refetch while usable keys exist', () => {
  const keysDoc = () => JSON.stringify({ keys: [as.keys[0].jwk] });

  it('a HANGING issuer after expiry adds no latency: stale keys answer at once, one background fetch at a time', async () => {
    let t = 0;
    let hang = false;
    let fetches = 0;
    const f = (async (_u: string, init: RequestInit) => {
      fetches++;
      if (!hang) return new Response(keysDoc(), { status: 200, headers: { 'cache-control': 'max-age=300' } });
      return await new Promise<Response>((_r, rej) => (init.signal as AbortSignal).addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))));
    }) as typeof fetch;
    const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', fetch: f, now: () => t });
    await jwks.getKey(as.keys[0].kid);
    hang = true;
    t = 301_000;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
      expect(Date.now() - t0).toBeLessThan(200);
      t += 5_001;
    }
    expect(fetches).toBe(2); // the initial fetch + ONE background refresh still hanging
  });

  it('the retry gate is measured from the END of a failed fetch, with backoff', async () => {
    let t = 0;
    let fail = false;
    let fetches = 0;
    const f = (async () => {
      fetches++;
      if (!fail) return new Response(keysDoc(), { status: 200, headers: { 'cache-control': 'max-age=300' } });
      t += 5_000; // the failed attempt took the whole timeout
      throw new DOMException('timeout', 'TimeoutError');
    }) as typeof fetch;
    const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', fetch: f, now: () => t });
    await jwks.getKey(as.keys[0].kid);
    fail = true;
    t = 301_000;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(fetches).toBe(2);
    // The failed attempt ended at 306 s: nothing new before 306 + 5 s.
    t += JWKS_RETRY_MIN_MS - 1;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(fetches).toBe(2);
    t += 1;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(fetches).toBe(3);
    // Second consecutive failure: the gap doubles (10 s from its end).
    t += 2 * JWKS_RETRY_MIN_MS - 1;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(fetches).toBe(3);
    t += 1;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(fetches).toBe(4);
  });

  it('a JWKS answering 200 without a usable key is an outage (503), not a reason to refuse every token', async () => {
    for (const doc of [{ keys: [] }, { keys: [{ kty: 'oct', k: 'AAAA', kid: 'x' }] }, { keys: [{ ...as.keys[0].jwk, alg: 'RS256' }] }]) {
      const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', fetch: (async () => new Response(JSON.stringify(doc), { status: 200 })) as typeof fetch });
      await expect(verifyAccessToken(as.mint(), { issuer: as.issuer, audience: RESOURCE, jwks })).rejects.toBeInstanceOf(JwksUnavailableError);
    }
    // An empty refresh never wipes a good cached set.
    let t = 0;
    let empty = false;
    const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', now: () => t, fetch: (async () => new Response(empty ? '{"keys":[]}' : keysDoc(), { status: 200 })) as typeof fetch });
    await jwks.getKey(as.keys[0].kid);
    empty = true;
    t += JWKS_MIN_TTL_MS + 1;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
  });

  it('a published key that carries private parts (d) is never used', async () => {
    const leaked = newSigningKey();
    const priv = { ...(leaked.privateKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'leaked', use: 'sig', alg: 'ES256' };
    const doc = JSON.stringify({ keys: [as.keys[0].jwk, priv] });
    const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', fetch: (async () => new Response(doc, { status: 200 })) as typeof fetch });
    await expect(verifyAccessToken(as.mint({ key: { ...leaked, kid: 'leaked' } }), { issuer: as.issuer, audience: RESOURCE, jwks })).rejects.toThrow('unknown signing key');
    await expect(verifyAccessToken(as.mint(), { issuer: as.issuer, audience: RESOURCE, jwks })).resolves.toBeTruthy();
  });

  it('over HTTP: an empty JWKS is a 503 without a challenge', async () => {
    const http = createHttpServer({
      env: { LEXAPI_BASE_URL: as.apiBase, LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer },
      fetch: (async (u: string, i: RequestInit) => (String(u).endsWith('/jwks.json') ? new Response('{"keys":[]}', { status: 200 }) : fetch(u, i))) as typeof fetch,
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    servers.push(http);
    const r = await call(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, { authorization: `Bearer ${as.mint()}` });
    expect(r.status).toBe(503);
    expect(r.www).toBeNull();
  });

  it('a stale set is trusted for at most JWKS_MAX_STALE_MS past its TTL, then 503', async () => {
    let t = 0;
    let down = false;
    const jwks = new JwksCache({
      url: 'http://127.0.0.1:1/jwks', now: () => t,
      fetch: (async () => { if (down) throw new TypeError('down'); return new Response(keysDoc(), { status: 200, headers: { 'cache-control': 'max-age=300' } }); }) as typeof fetch,
    });
    await jwks.getKey(as.keys[0].kid);
    down = true;
    t = 300_000 + JWKS_MAX_STALE_MS - 1;
    expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
    await jwks.settled();
    t = 300_000 + JWKS_MAX_STALE_MS + JWKS_RETRY_MIN_MS * 4;
    await expect(jwks.getKey(as.keys[0].kid)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('max-age=0 is clamped to the 5-minute minimum (no refetch storm)', async () => {
    let t = 0;
    let fetches = 0;
    const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', now: () => t, fetch: (async () => { fetches++; return new Response(keysDoc(), { status: 200, headers: { 'cache-control': 'max-age=0' } }); }) as typeof fetch });
    await jwks.getKey(as.keys[0].kid);
    for (let i = 0; i < 10; i++) {
      t += 10_000;
      await jwks.getKey(as.keys[0].kid);
      await jwks.settled();
    }
    expect(fetches).toBe(1);
    t = JWKS_MIN_TTL_MS;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(fetches).toBe(2);
  });

  it('the JWKS fetch refuses redirects; JWKS and exchange both pass redirect: "error"', async () => {
    const inits: RequestInit[] = [];
    const spy = (async (u: string, i: RequestInit) => { inits.push(i); return fetch(u, i); }) as typeof fetch;
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json`, fetch: spy });
    await jwks.getKey(as.keys[0].kid);
    const ex = exchanger({ fetch: spy });
    const s = as.mint();
    await ex.getApiToken(s, expOf(s));
    expect(inits.map((i) => i.redirect)).toEqual(['error', 'error']);
    // And a real redirect makes the fetch fail (503 path), it is not followed.
    const redirecting = new JwksCache({ url: `${as.issuer}/redirect-to-jwks` });
    as.redirects.set('/redirect-to-jwks', `${as.issuer}/.well-known/jwks.json`);
    await expect(redirecting.getKey(as.keys[0].kid)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('an oversized JWKS is refused, and the cap is enforced while streaming', async () => {
    let pulledBytes = 0;
    const huge = () => new ReadableStream<Uint8Array>({
      pull(c) {
        const chunk = new TextEncoder().encode(' '.repeat(16 * 1024));
        pulledBytes += chunk.byteLength;
        if (pulledBytes > 4_000_000) c.close();
        else c.enqueue(chunk);
      },
    });
    const jwks = new JwksCache({ url: 'http://127.0.0.1:1/jwks', fetch: (async () => new Response(huge(), { status: 200 })) as typeof fetch });
    const logged = logSpy.mock.calls.length;
    await expect(jwks.getKey(as.keys[0].kid)).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(logSpy.mock.calls.slice(logged).flat().join('\n')).toMatch(/JWKS document too large/);
    expect(pulledBytes).toBeLessThan(200_000);
    // A valid key padded past 64 KiB is still refused (the cap is real, not just for junk).
    const padded = JSON.stringify({ keys: [as.keys[0].jwk], pad: 'x'.repeat(70 * 1024) });
    const j2 = new JwksCache({ url: 'http://127.0.0.1:1/jwks', fetch: (async () => new Response(padded, { status: 200 })) as typeof fetch });
    await expect(j2.getKey(as.keys[0].kid)).rejects.toBeInstanceOf(JwksUnavailableError);
    // The shared reader.
    pulledBytes = 0;
    await expect(readCappedText(new Response(huge()), 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulledBytes).toBeLessThan(100_000);
    await expect(readCappedText(new Response('x'.repeat(10), { headers: { 'content-length': '999999' } }), 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(await readCappedText(new Response('hello'), 1024)).toBe('hello');
  });

  it('an oversized token-endpoint answer is not buffered (treated as an unreadable error)', async () => {
    let pulledBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulledBytes += 16 * 1024;
        if (pulledBytes > 4_000_000) c.close();
        else c.enqueue(new Uint8Array(16 * 1024).fill(32));
      },
    });
    const ex = exchanger({ fetch: (async () => new Response(body, { status: 400 })) as typeof fetch });
    const s = as.mint();
    await expect(ex.getApiToken(s, expOf(s))).rejects.toMatchObject({ kind: 'config' });
    expect(pulledBytes).toBeLessThan(200_000);
  });
});

describe('configuration failures are visible and never trigger re-auth', () => {
  it('only a "subject_token rejected" 400 is the user’s (401); any other invalid_request / invalid_grant is ours (500, logged, counted)', async () => {
    const { base } = await start();
    const auth = { authorization: `Bearer ${as.mint({ sub: 's4' })}` };
    const errorsBefore = logSpy.mock.calls.length;
    for (const body of [
      { error: 'invalid_request', error_description: 'subject_token_type must be urn:ietf:params:oauth:token-type:access_token' },
      { error: 'invalid_request', error_description: 'client_id in the body does not match the Basic credentials' },
      { error: 'invalid_request', error_description: 'grant_type is required' },
      { error: 'invalid_grant', error_description: 'invalid authorization code' },
      { error: 'invalid_request' },
    ]) {
      as.tokenOverrides.push({ status: 400, body });
      const r = await call(base, auth);
      expect(r.status, JSON.stringify(body)).toBe(500);
      expect(r.www).toBeNull();
    }
    const health = await fetch(`${base}/health`).then((x) => x.json());
    expect(health.oauth).toBe(true);
    expect(health.oauthAlerts).toMatchObject({ configErrors: true, clientAuthErrors: false });
    const op = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }).then((x) => x.json());
    expect(op.oauthStats.exchange.configErrors).toBe(5);
    expect(op.oauthStats.exchange.userTokenRejected).toBe(0);
    const lines = logSpy.mock.calls.slice(errorsBefore).flat().map(String).join('\n');
    expect(lines).toMatch(/OAUTH CONFIGURATION PROBLEM: token exchange refused our request \(invalid_request\)/);
    // The prefix is exact and belongs to invalid_request only.
    for (const body of [
      { error: 'invalid_grant', error_description: 'subject_token rejected: session ended' },
      { error: 'invalid_request', error_description: 'Subject_token rejected: session ended' },
      { error: 'invalid_request', error_description: 'subject_token rejected session ended' },
      { error: 'invalid_request', error_description: ' subject_token rejected: x' },
    ]) {
      as.tokenOverrides.push({ status: 400, body });
      const r = await call(base, { authorization: `Bearer ${as.mint({ sub: 's4_near_miss' })}` });
      expect(r.status, JSON.stringify(body)).toBe(500);
    }
    // The user's own rejection still challenges, and is counted apart.
    as.tokenOverrides.push({ status: 400, body: { error: 'invalid_request', error_description: 'subject_token rejected: session ended' } });
    const r = await call(base, { authorization: `Bearer ${as.mint({ sub: 's4_user' })}` });
    expect(r.status).toBe(401);
    expect(r.www).toMatch(/error="invalid_token", error_description="subject_token rejected: session ended"/);
    const h2 = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }).then((x) => x.json());
    expect(h2.oauthStats.exchange.userTokenRejected).toBe(1);
    expect(h2.oauthStats.exchange.configErrors).toBe(9);
    expect(JSON.stringify(h2)).not.toMatch(/eyJ|lex_|s4_user/);
  });

  it('a second API 401 after a re-exchange is a tool error and a log line, not a 401 to the client', async () => {
    const http = createHttpServer({
      env: { LEXAPI_BASE_URL: as.apiBase, LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer },
      fetch: (async (u: string, i: RequestInit) => (String(u).includes('/api/v1/')
        ? new Response('{"error":"Invalid access token"}', { status: 401, headers: { 'www-authenticate': 'Bearer realm="lexapi", error="invalid_token"' } })
        : fetch(u, i))) as typeof fetch,
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    servers.push(http);
    const before = logSpy.mock.calls.length;
    const r = await call(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, { authorization: `Bearer ${as.mint({ sub: 's4_twice' })}` });
    expect(r.status).toBe(200);
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toMatch(/refused this connection/);
    expect(logSpy.mock.calls.slice(before).flat().join('\n')).toMatch(/refused an exchanged token twice/);
  });
});

describe('configuration, timing and the MCP layer', () => {
  it('the API-key path resolves LEXAPI_BASE_URL exactly as 0.3.0 (the LEXAPI_API_BASE alias does not touch it)', () => {
    const base = (env: NodeJS.ProcessEnv) => (clientFromEnv(KEY, env) as unknown as { baseUrl: string }).baseUrl;
    expect(base({ LEXAPI_API_BASE: 'http://127.0.0.1:9/api/v1' })).toBe(DEFAULT_BASE_URL);
    expect(base({ LEXAPI_BASE_URL: 'http://127.0.0.1:9/api/v1/' })).toBe('http://127.0.0.1:9/api/v1');
    expect(() => createHttpServer({ env: { LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer, LEXAPI_BASE_URL: 'http://localhost:1/api/v1' } })).toThrow(/issuer's origin/);
  });

  it('an exchange always finishes before the first frame that commits the response', async () => {
    expect(EXCHANGE_DEADLINE_MS).toBeLessThan(PROGRESS_INTERVAL_MS);
    expect(EXCHANGE_DEADLINE_MS).toBeLessThan(SSE_KEEP_ALIVE_MS);
    // A token endpoint that never answers: both attempts fit in the deadline.
    const hang = (async (_u: string, i: RequestInit) => new Promise<Response>((_r, rej) => (i.signal as AbortSignal).addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))))) as typeof fetch;
    const ex = exchanger({ fetch: hang, deadlineMs: 400, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const s = as.mint();
    const t0 = Date.now();
    await expect(ex.getApiToken(s, expOf(s))).rejects.toMatchObject({ kind: 'upstream' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('the MCP layer never sees authorization / x-api-key / cookie', () => {
    const req = {
      url: '/v1', method: 'POST',
      headers: { authorization: 'Bearer secret.jwt.value', 'x-api-key': KEY, cookie: 'a=b', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    } as unknown as IncomingMessage;
    const web = toWebRequest(req);
    expect(web.headers.get('authorization')).toBeNull();
    expect(web.headers.get('x-api-key')).toBeNull();
    expect(web.headers.get('cookie')).toBeNull();
    expect(web.headers.get('mcp-protocol-version')).toBe('2025-11-25');
  });

  it('the token length cap', () => {
    const seg = (n: number) => 'a'.repeat(n);
    expect(looksLikeJwt(`${seg(10)}.${seg(10)}.${seg(MAX_TOKEN_LENGTH - 22)}`)).toBe(true);
    expect(looksLikeJwt(`${seg(10)}.${seg(10)}.${seg(MAX_TOKEN_LENGTH - 21)}`)).toBe(false);
  });

  it('a long but valid-shaped token over HTTP is refused before any key lookup or exchange', async () => {
    const { base, http } = await start();
    const big = as.mint({ sub: 'big', claims: { pad: 'p'.repeat(MAX_TOKEN_LENGTH) } });
    const before = as.seen.length;
    const r = await call(base, { authorization: `Bearer ${big}` });
    expect(r.status).toBe(401);
    expect(since(before)).toHaveLength(0);
    expect(http.oauth!.jwks.fetches).toBe(0);
  });
});

describe('verify(): unknown kid while the issuer is failing → 503, not 401', () => {
  it('cannot tell a rotated key from a forged kid during an outage, so it does not refuse the token', async () => {
    let t = 0;
    let down = false;
    const jwks = new JwksCache({
      url: 'http://127.0.0.1:1/jwks', now: () => t,
      fetch: (async () => { if (down) throw new TypeError('down'); return new Response(JSON.stringify({ keys: [as.keys[0].jwk] }), { status: 200 }); }) as typeof fetch,
    });
    await jwks.getKey(as.keys[0].kid);
    down = true;
    t += 61_000;
    const rotated = newSigningKey();
    await expect(verifyAccessToken(as.mint({ key: rotated }), { issuer: as.issuer, audience: RESOURCE, jwks, now: () => Date.now() })).rejects.toBeInstanceOf(JwksUnavailableError);
    // The failure gate then holds: the next unknown kid is a 503 too, without a fetch.
    await expect(jwks.getKey('another')).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(InvalidTokenError).toBeDefined();
  });
});

describe('cache ordering, proxy hops, throttle recovery, /health disclosure', () => {
  it('local signature verification precedes ANY cache lookup — a victim’s header.payload with a forged signature never reaches their API token', async () => {
    const { base, http } = await start();
    const victim = as.mint({ sub: 'r20_victim', gid: 'g_r20_victim' });
    const [h, p] = victim.split('.');
    const forged = `${h}.${p}.${Buffer.alloc(64, 7).toString('base64url')}`;
    // Forged first: refused locally, nothing cached either way.
    const before = as.seen.length;
    const f1 = await call(base, { authorization: `Bearer ${forged}` });
    expect(f1.status).toBe(401);
    expect(f1.www).toMatch(/error_description="invalid signature"/);
    expect(http.oauth!.exchanger.negativeSize).toBe(0);
    // The victim signs in: their API token is now cached under subjectKey(header.payload).
    const ok = await call(base, { authorization: `Bearer ${victim}` });
    expect(JSON.parse(ok.json.result.content[0].text).service).toBe('user:r20_victim');
    expect(http.oauth!.exchanger.size).toBe(1);
    const mark = as.seen.length;
    for (const sig of [Buffer.alloc(64, 7), Buffer.alloc(64, 0xff)]) {
      const r = await call(base, { authorization: `Bearer ${h}.${p}.${sig.toString('base64url')}` });
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ error: 'invalid_token', error_description: 'invalid signature' });
    }
    expect(apiCalls(mark)).toHaveLength(0);
    expect(tokenCalls(before)).toBe(1);
  });

  it('an X-Forwarded-For shorter than the hop count is warned about (once, rate-limited), flagged on /health, and never shows an address', async () => {
    const { base, http } = await start({ LEXAPI_MCP_TRUST_PROXY_HOPS: '2' });
    expect(http.clientAddressMode).toBe('X-Forwarded-For, entry 2 from the right (LEXAPI_MCP_TRUST_PROXY_HOPS=2)');
    const before = logSpy.mock.calls.length;
    for (let i = 0; i < 3; i++) await call(base, { authorization: `Bearer ${as.mint({ sub: `r22_${i}` })}`, 'x-forwarded-for': '198.51.100.77' });
    const warnings = logSpy.mock.calls.slice(before).flat().map(String).filter((l: string) => /X-Forwarded-For has 1 entry but LEXAPI_MCP_TRUST_PROXY_HOPS=2/.test(l));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('198.51.100.77');
    const pub = await fetch(`${base}/health`).then((x) => x.json());
    expect(pub.oauthAlerts.proxyHopsMismatch).toBe(true);
    // The deploy check: the operator view reports how the address was derived for THIS request.
    const op = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}`, 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } });
    const opText = await op.text();
    expect(JSON.parse(opText).clientAddress).toEqual({ mode: 'x-forwarded-for', trustProxyHops: 2, xffEntriesThisRequest: 2, derivedFrom: 'x-forwarded-for', shortXffRequests: 3 });
    expect(opText).not.toMatch(/203\.0\.113\.5|10\.0\.0\.1|127\.0\.0\.1/);
    const short = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }).then((x) => x.json());
    expect(short.clientAddress).toMatchObject({ xffEntriesThisRequest: 0, derivedFrom: 'socket' });
    // hops=0: the mode says so.
    const { http: h0 } = await start();
    expect(h0.clientAddressMode).toBe('the socket peer (LEXAPI_MCP_TRUST_PROXY_HOPS=0)');
  });

  it('a second 429 episode after recovery starts from the minimum backoff, and concurrency returns after each recovery', async () => {
    let t = 5_000_000;
    let requests = 0;
    const f = (async (u: string, i: RequestInit) => { requests++; return fetch(u, i); }) as typeof fetch;
    const ex = exchanger({ now: () => t, fetch: f });
    const episode = async (label: string) => {
      as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '0' } });
      const a = as.mint({ sub: `${label}_trigger` });
      // A fresh episode always starts at the minimum backoff (1 s), never where an earlier one left off.
      await expect(ex.getApiToken(a, expOf(a))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 1 });
      t += 1_000;
      const probe = as.mint({ sub: `${label}_probe` });
      expect(await ex.getApiToken(probe, expOf(probe))).toMatch(/\./);
      // Recovered: several concurrent exchanges all go out (no lingering single-probe gate).
      const n = requests;
      const many = Array.from({ length: 4 }, (_, i) => as.mint({ sub: `${label}_after_${i}` }));
      const got = await Promise.all(many.map((m) => ex.getApiToken(m, expOf(m))));
      expect(got.every((g) => /\./.test(g))).toBe(true);
      expect(requests - n).toBe(4);
    };
    await episode('r23_first');
    t += 60_000;
    await episode('r23_second');
    expect(ex.stats().backoffSeconds).toBe(0);
  });

  it('/health never carries configuration values or secrets; traffic counters only behind LEXAPI_MCP_HEALTH_TOKEN', async () => {
    const { base, http } = await start();
    const cfg = http.oauth!.cfg;
    await call(base, { authorization: `Bearer ${as.mint({ sub: 'r24' })}` });
    const forbidden = [CLIENT_SECRET, HEALTH_TOKEN, cfg.issuer, cfg.clientId, cfg.resource, cfg.apiBase, cfg.tokenEndpoint, cfg.jwksUri, 'clientSecret', 'issuer'];
    const pubText = await fetch(`${base}/health`).then((x) => x.text());
    const opText = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }).then((x) => x.text());
    for (const body of [pubText, opText]) for (const v of forbidden) expect(body, v).not.toContain(v);
    const pub = JSON.parse(pubText);
    expect(Object.keys(pub).sort()).toEqual(['name', 'oauth', 'oauthAlerts', 'status', 'tools', 'version']);
    expect(Object.values(pub.oauthAlerts).every((v) => typeof v === 'boolean')).toBe(true);
    expect(pubText).not.toMatch(/cacheSize|locallyLimited|backoffSeconds|oauthStats/);
    // A wrong token gets the public view; so does any token when none is configured.
    const wrong = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}x` } }).then((x) => x.json());
    expect(wrong.oauthStats).toBeUndefined();
    const { base: noToken } = await start({ LEXAPI_MCP_HEALTH_TOKEN: '' });
    expect((await fetch(`${noToken}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }).then((x) => x.json())).oauthStats).toBeUndefined();
    expect(JSON.parse(opText).oauthStats.exchange.succeeded).toBe(1);
    // OAuth off: /health is 0.3.0's plus `oauth:false`, even with the token.
    const { base: off } = await start({}, { oauthOff: true });
    expect(await fetch(`${off}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }).then((x) => x.json())).toEqual({ status: 'ok', name: 'lexapi-mcp', version: expect.any(String), tools: expect.any(Number), oauth: false });
    expect(() => createHttpServer({ env: { LEXAPI_MCP_HEALTH_TOKEN: 'short' } })).toThrow(/at least 32/);
  });
});

describe('every new exchange of a user is capped, and per-user slow-downs stay per-user', () => {
  const revoked = (sub: string, gid: string) => {
    const t = as.mint({ sub, gid });
    as.revoke(gid);
    return t;
  };

  it('over HTTP: one clean account with 100 freshly minted valid tokens costs at most the cap (20), then a tool error saying how long to wait — never a re-auth', async () => {
    const { base, http } = await start();
    const before = as.seen.length;
    const answers = [];
    for (let i = 0; i < 100; i++) answers.push(await call(base, { authorization: `Bearer ${as.mint({ sub: 'r31_minter', gid: 'g_r31_minter' })}` }));
    expect(tokenCalls(before)).toBe(LIMITS.exchangesPerSubPerMin);
    expect(LIMITS.exchangesPerSubPerMin).toBe(20);
    for (const ok of answers.slice(0, 20)) expect(JSON.parse(ok.json.result.content[0].text).service).toBe('user:r31_minter');
    for (const r of answers.slice(20)) {
      expect(r.status).toBe(200);
      expect(r.www).toBeNull();
      expect(r.json.result.isError).toBe(true);
      expect(r.json.result.content[0].text).toMatch(/rate limited right now\. Wait \d+ s before calling again/);
    }
    // Another user from the same address is not affected.
    const other = await call(base, { authorization: `Bearer ${as.mint({ sub: 'r31_bystander', gid: 'g_r31_bystander' })}` });
    expect(JSON.parse(other.json.result.content[0].text).service).toBe('user:r31_bystander');
    expect(http.oauth!.exchanger.stats().locallyLimited).toBe(80);
  });

  it('the cap counts refused exchanges too, ignores cached tokens, and frees up after the minute', async () => {
    let t = 7_000_000;
    const ex = exchanger({ now: () => t, limits: { exchangesPerSubPerMin: 5, refusedPerSubPer10Min: 1_000 } });
    const caller = { sub: 'r31_cap', ip: '192.0.2.31' };
    const good = as.mint({ sub: 'r31_cap', gid: 'g_r31_cap' });
    const apiToken = await ex.getApiToken(good, expOf(good), undefined, caller);
    for (let i = 0; i < 4; i++) {
      const r = revoked('r31_cap', `g_r31_cap_rev_${i}`);
      await expect(ex.getApiToken(r, expOf(r), undefined, caller)).rejects.toMatchObject({ kind: 'invalid_token' });
    }
    expect(ex.exchanges).toBe(5);
    // Cap reached: a sixth new token is held back locally, with the time left in the window.
    t += 15_000;
    const sixth = as.mint({ sub: 'r31_cap', gid: 'g_r31_cap' });
    await expect(ex.getApiToken(sixth, expOf(sixth), undefined, caller)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 45 });
    expect(ex.exchanges).toBe(5);
    // Cached and negative-cached tokens still answer, and never count.
    for (let i = 0; i < 10; i++) expect(await ex.getApiToken(good, expOf(good), undefined, caller)).toBe(apiToken);
    // The cap is per user: another account carries on.
    const other = as.mint({ sub: 'r31_cap_other' });
    expect(await ex.getApiToken(other, expOf(other), undefined, { sub: 'r31_cap_other', ip: '192.0.2.31' })).toMatch(/\./);
    // A new minute: exchanges resume.
    t += 45_000;
    expect(await ex.getApiToken(sixth, expOf(sixth), undefined, caller)).toMatch(/\./);
  });

  it('fresh-account flooding stays bounded per account: each account costs at most the cap, refused or not', async () => {
    const saved = LIMITS.refusedPerSubPer10Min;
    LIMITS.refusedPerSubPer10Min = 1_000; // isolate the new cap from the refused-sign-in limit
    try {
      const { base } = await start({ LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN: '3' });
      const before = as.seen.length;
      for (let a = 0; a < 5; a++) {
        for (let i = 0; i < 10; i++) await call(base, { authorization: `Bearer ${revoked(`r31_flood_${a}`, `g_r31_flood_${a}_${i}`)}`, 'x-forwarded-for': `192.0.2.${a}` });
      }
      expect(tokenCalls(before)).toBe(5 * 3);
    } finally {
      LIMITS.refusedPerSubPer10Min = saved;
    }
  });

  it('LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN: default 20, whole numbers 1–1000 only', () => {
    const base = { LEXAPI_BASE_URL: as.apiBase, LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer };
    expect(createHttpServer({ env: base }).oauth!.cfg.exchangesPerUserPerMin).toBe(20);
    expect(createHttpServer({ env: { ...base, LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN: ' 7 ' } }).oauth!.cfg.exchangesPerUserPerMin).toBe(7);
    for (const bad of ['0', '-1', '1.5', 'abc', '1001']) {
      expect(() => createHttpServer({ env: { ...base, LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN: bad } }), bad).toThrow(/LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN/);
    }
  });

  it('a per-user limit (429 temporarily_unavailable + Retry-After for ONE user) backs off that user only; other users keep exchanging', async () => {
    let t = 8_000_000;
    const ex = exchanger({ now: () => t });
    as.userLimited.set('r31_busy', { status: 429, body: { error: 'temporarily_unavailable', error_description: 'Too many token exchanges for this account. Retry after 30 s.' }, headers: { 'retry-after': '30' } });
    try {
      const busy = { sub: 'r31_busy', ip: '192.0.2.40' };
      const a = as.mint({ sub: 'r31_busy' });
      await expect(ex.getApiToken(a, expOf(a), undefined, busy)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
      const sent = ex.exchanges;
      // That user's next new token waits it out without a request…
      t += 10_000;
      const b = as.mint({ sub: 'r31_busy' });
      await expect(ex.getApiToken(b, expOf(b), undefined, busy)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 20 });
      expect(ex.exchanges).toBe(sent);
      // …while everyone else exchanges normally (no global backoff).
      for (let i = 0; i < 5; i++) {
        const o = as.mint({ sub: `r31_free_${i}` });
        expect(await ex.getApiToken(o, expOf(o), undefined, { sub: `r31_free_${i}`, ip: '192.0.2.40' })).toMatch(/\./);
      }
      expect(ex.exchanges).toBe(sent + 5);
      expect(ex.stats()).toMatchObject({ backoffSeconds: 0, usersBackingOff: 1 });
      // Limit lifted and the wait over: the user is back, and their backoff is cleared.
      as.userLimited.delete('r31_busy');
      t += 20_000;
      expect(await ex.getApiToken(b, expOf(b), undefined, busy)).toMatch(/\./);
      expect(ex.stats().usersBackingOff).toBe(0);
      // Recovery reset the user's backoff: a later slow-down starts from the minimum again (1 s, not 2 s).
      as.userLimited.set('r31_busy', { status: 429, body: { error: 'temporarily_unavailable' } });
      const c = as.mint({ sub: 'r31_busy' });
      await expect(ex.getApiToken(c, expOf(c), undefined, busy)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 1 });
    } finally {
      as.userLimited.delete('r31_busy');
    }
  });

  it('…over HTTP: the limited user gets a tool error with the wait (no re-auth); a 503 temporarily_unavailable for one user is per-user too', async () => {
    const { base } = await start();
    as.userLimited.set('r31_http_busy', { status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '12' } });
    as.userLimited.set('r31_http_503', { status: 503, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '4' } });
    try {
      const r = await call(base, { authorization: `Bearer ${as.mint({ sub: 'r31_http_busy' })}` });
      expect(r.status).toBe(200);
      expect(r.www).toBeNull();
      expect(r.json.result.content[0].text).toMatch(/Wait 12 s/);
      const u = await call(base, { authorization: `Bearer ${as.mint({ sub: 'r31_http_503' })}` });
      expect(u.status).toBe(503);
      expect(u.www).toBeNull();
      const ok = await call(base, { authorization: `Bearer ${as.mint({ sub: 'r31_http_free' })}` });
      expect(JSON.parse(ok.json.result.content[0].text).service).toBe('user:r31_http_free');
    } finally {
      as.userLimited.delete('r31_http_busy');
      as.userLimited.delete('r31_http_503');
    }
  });

  it('a slow-down that reaches several users is the shared budget: from the third user in a minute every new exchange waits (no stampede)', async () => {
    const t = 9_000_000;
    let requests = 0;
    const f = (async (u: string, i: RequestInit) => { requests++; return fetch(u, i); }) as typeof fetch;
    const ex = exchanger({ now: () => t, fetch: f });
    expect(LIMITS.slowDownGlobalAfterUsers).toBe(3);
    for (let i = 0; i < 2; i++) {
      as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '20' } });
      const a = as.mint({ sub: `r31_spread_${i}` });
      await expect(ex.getApiToken(a, expOf(a), undefined, { sub: `r31_spread_${i}` })).rejects.toMatchObject({ kind: 'rate_limited' });
    }
    // Two users: still per-user, a third user exchanges (and is slowed down too).
    expect(ex.stats().backoffSeconds).toBe(0);
    as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '20' } });
    const c = as.mint({ sub: 'r31_spread_2' });
    await expect(ex.getApiToken(c, expOf(c), undefined, { sub: 'r31_spread_2' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 20 });
    expect(ex.stats().backoffSeconds).toBe(20);
    // Global now: nobody's new exchange is sent.
    const n = requests;
    for (let i = 0; i < 5; i++) {
      const o = as.mint({ sub: `r31_spread_other_${i}` });
      await expect(ex.getApiToken(o, expOf(o), undefined, { sub: `r31_spread_other_${i}` })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 20 });
    }
    expect(requests).toBe(n);
  });

  it('users slowed down more than a minute apart never add up to a global slow-down', async () => {
    let t = 9_500_000;
    const ex = exchanger({ now: () => t });
    for (let i = 0; i < 4; i++) {
      as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '1' } });
      const a = as.mint({ sub: `r31_apart_${i}` });
      await expect(ex.getApiToken(a, expOf(a), undefined, { sub: `r31_apart_${i}` })).rejects.toMatchObject({ kind: 'rate_limited' });
      expect(ex.stats().backoffSeconds).toBe(0);
      t += 61_000;
    }
  });

  it('a 429 after refused client authentication is global even with a user', async () => {
    const t = 9_800_000;
    const ex = exchanger({ now: () => t });
    as.tokenOverrides.push({ status: 401, body: { error: 'invalid_client' } });
    const a = as.mint({ sub: 'r31_lock_a' });
    await expect(ex.getApiToken(a, expOf(a), undefined, { sub: 'r31_lock_a' })).rejects.toMatchObject({ kind: 'client_auth' });
    as.tokenOverrides.push({ status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '120' } });
    const b = as.mint({ sub: 'r31_lock_b' });
    await expect(ex.getApiToken(b, expOf(b), undefined, { sub: 'r31_lock_b' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120 });
    expect(ex.stats().backoffSeconds).toBe(120);
    const sent = ex.exchanges;
    const c = as.mint({ sub: 'r31_lock_c' });
    await expect(ex.getApiToken(c, expOf(c), undefined, { sub: 'r31_lock_c' })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(ex.exchanges).toBe(sent);
  });

  it('a user slowed down twice in a row waits longer the second time (backoff doubles, Retry-After is the floor)', async () => {
    let t = 9_900_000;
    const ex = exchanger({ now: () => t });
    as.userLimited.set('r31_twice', { status: 429, body: { error: 'temporarily_unavailable' } });
    try {
      const caller = { sub: 'r31_twice' };
      const a = as.mint({ sub: 'r31_twice' });
      await expect(ex.getApiToken(a, expOf(a), undefined, caller)).rejects.toMatchObject({ retryAfterSeconds: 1 });
      t += 1_000;
      await expect(ex.getApiToken(a, expOf(a), undefined, caller)).rejects.toMatchObject({ retryAfterSeconds: 2 });
    } finally {
      as.userLimited.delete('r31_twice');
    }
  });
});

describe('per-user slow-down bounds', () => {
  it('per-user slow-down state is bounded (oldest dropped first)', async () => {
    const t = 9_950_000;
    const ex = exchanger({ now: () => t, maxEntries: 2, limits: { slowDownGlobalAfterUsers: 100 } });
    for (let i = 0; i < 3; i++) as.userLimited.set(`r31_bound_${i}`, { status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '60' } });
    try {
      for (let i = 0; i < 3; i++) {
        const a = as.mint({ sub: `r31_bound_${i}` });
        await expect(ex.getApiToken(a, expOf(a), undefined, { sub: `r31_bound_${i}` })).rejects.toMatchObject({ kind: 'rate_limited' });
      }
      expect(ex.stats().usersBackingOff).toBe(2);
      expect(ex.stats().backoffSeconds).toBe(0);
    } finally {
      for (let i = 0; i < 3; i++) as.userLimited.delete(`r31_bound_${i}`);
    }
  });
});

describe('/health alert lifetime and operator-token warning', () => {
  it('oauthAlerts.proxyHopsMismatch clears 10 minutes after the last mismatched request (no restart needed); the operator count stays', async () => {
    const { base } = await start({ LEXAPI_MCP_TRUST_PROXY_HOPS: '2' });
    const real = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    try {
      await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' } });
      expect((await fetch(`${base}/health`).then((x) => x.json())).oauthAlerts.proxyHopsMismatch).toBe(false);
      await call(base, { authorization: `Bearer ${as.mint({ sub: 'nit1' })}`, 'x-forwarded-for': '203.0.113.1' });
      expect((await fetch(`${base}/health`).then((x) => x.json())).oauthAlerts.proxyHopsMismatch).toBe(true);
      offset = PROXY_MISMATCH_ALERT_MS - 5_000;
      expect((await fetch(`${base}/health`).then((x) => x.json())).oauthAlerts.proxyHopsMismatch).toBe(true);
      offset = PROXY_MISMATCH_ALERT_MS + 1_000;
      expect((await fetch(`${base}/health`).then((x) => x.json())).oauthAlerts.proxyHopsMismatch).toBe(false);
      const op = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}`, 'x-forwarded-for': '203.0.113.1, 10.0.0.1' } }).then((x) => x.json());
      expect(op.clientAddress.shortXffRequests).toBe(1);
      // A new mismatch sets it again.
      await call(base, { authorization: `Bearer ${as.mint({ sub: 'nit1' })}`, 'x-forwarded-for': '203.0.113.1' });
      expect((await fetch(`${base}/health`).then((x) => x.json())).oauthAlerts.proxyHopsMismatch).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('LEXAPI_MCP_HEALTH_TOKEN with OAuth off: a clear warning (it adds nothing), never the token', async () => {
    const before = logSpy.mock.calls.length;
    await start({}, { oauthOff: true });
    const lines = logSpy.mock.calls.slice(before).flat().map(String);
    const w = lines.filter((l: string) => /LEXAPI_MCP_HEALTH_TOKEN is set but OAuth is off/.test(l));
    expect(w).toHaveLength(1);
    expect(w[0]).not.toContain(HEALTH_TOKEN);
    // OAuth on (or no token): no such warning.
    const mark = logSpy.mock.calls.length;
    await start();
    await start({ LEXAPI_MCP_HEALTH_TOKEN: '' }, { oauthOff: true });
    expect(logSpy.mock.calls.slice(mark).flat().map(String).some((l: string) => /OAuth is off/.test(l))).toBe(false);
  });
});
