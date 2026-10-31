// Units of the OAuth resource-server half: config, JWT validation, JWKS
// caching, token exchange (cache / expiry / errors) and the OAuth upstream
// credential inside LexAPIClient. Network pieces run against tests/oauth-mock.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LexAPIClient } from '../src/client.js';
import { describeError, UpstreamAuthError } from '../src/errors.js';
import { bearerChallenge, oauthConfigFromEnv, OAuthConfigError, protectedResourceMetadata } from '../src/oauth/config.js';
import { ExchangeError, subjectKey, TokenExchanger } from '../src/oauth/exchange.js';
import { InvalidTokenError, JwksCache, JwksUnavailableError, looksLikeJwt, verifyAccessToken } from '../src/oauth/jwt.js';
import { redact } from '../src/oauth/redact.js';
import { OAuthUpstreamAuth, ResponseGate } from '../src/oauth/upstream.js';
import { CLIENT_ID, CLIENT_SECRET, newSigningKey, publicKeyBytes, RESOURCE, signJwt, startMockAs, type MockAs } from './oauth-mock.js';

const SECRET32 = 'x'.repeat(32);

describe('config', () => {
  it('is off without LEXAPI_OAUTH_CLIENT_SECRET', () => {
    expect(oauthConfigFromEnv({})).toBeNull();
    expect(oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: '   ' })).toBeNull();
    expect(oauthConfigFromEnv({ LEXAPI_BASE_URL: 'http://127.0.0.1:1/api/v1' })).toBeNull();
  });

  it('refuses to start when an OAuth variable is set without the secret', () => {
    for (const name of ['LEXAPI_OAUTH_ISSUER', 'LEXAPI_OAUTH_RESOURCE', 'LEXAPI_OAUTH_CLIENT_ID', 'LEXAPI_API_BASE']) {
      expect(() => oauthConfigFromEnv({ [name]: 'https://lex-api.com' }), name).toThrow(OAuthConfigError);
      expect(() => oauthConfigFromEnv({ [name]: 'https://lex-api.com' }), name).toThrow(/LEXAPI_OAUTH_CLIENT_SECRET is not/);
    }
  });

  it('defaults to the production values', () => {
    const c = oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32 })!;
    expect(c).toMatchObject({
      issuer: 'https://lex-api.com',
      resource: 'https://mcp.lex-api.com/v1',
      clientId: 'lexapi-mcp-server',
      apiAudience: 'https://lex-api.com/api/v1',
      tokenEndpoint: 'https://lex-api.com/oauth/token',
      jwksUri: 'https://lex-api.com/.well-known/jwks.json',
      resourcePath: '/v1',
      resourceMetadataUrl: 'https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1',
    });
  });

  it('refuses a half-configured env (and never echoes the secret)', () => {
    const bad: Array<Record<string, string>> = [
      { LEXAPI_OAUTH_CLIENT_SECRET: 'short-secret' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_ISSUER: 'http://lex-api.com' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_ISSUER: 'https://lex-api.com/sub' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://mcp.lex-api.com' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://MCP.lex-api.com/v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://mcp.lex-api.com:443/v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://mcp.lex-api.com/v1?x=1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_CLIENT_ID: 'has space' },
      // Dot-segments would make the PRM resource and the token aud disagree.
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://mcp.lex-api.com/a/../v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://mcp.lex-api.com/./v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_RESOURCE: 'https://mcp.lex-api.com/x/%2e%2e/v1' },
      // Exchanged API tokens may only go to the issuer's origin.
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_BASE_URL: 'https://api.evil.example/api/v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_BASE_URL: 'https://lex-api.com.evil.example/api/v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_BASE_URL: 'http://lex-api.com/api/v1' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_ISSUER: 'http://127.0.0.1:3002' },
      // The old alias may not point OAuth traffic elsewhere.
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_API_BASE: 'https://lex-api.com/api/v2' },
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_MCP_TRUST_PROXY_HOPS: 'two' },
      // http only on loopback — even with a matching http API base.
      { LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_ISSUER: 'http://lex-api.com', LEXAPI_BASE_URL: 'http://lex-api.com/api/v1' },
    ];
    for (const env of bad) {
      let err: unknown;
      try { oauthConfigFromEnv(env); } catch (e) { err = e; }
      expect(err, JSON.stringify(env)).toBeInstanceOf(OAuthConfigError);
      expect(String((err as Error).message)).not.toContain(env.LEXAPI_OAUTH_CLIENT_SECRET);
    }
  });

  it('allows http only on loopback (local tests) and trims a trailing slash', () => {
    const c = oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_OAUTH_ISSUER: 'http://127.0.0.1:3002/', LEXAPI_OAUTH_RESOURCE: 'http://127.0.0.1:3000/v1/', LEXAPI_BASE_URL: 'http://127.0.0.1:3002/api/v1/' })!;
    expect(c.issuer).toBe('http://127.0.0.1:3002');
    expect(c.resource).toBe('http://127.0.0.1:3000/v1');
    expect(c.resourceMetadataUrl).toBe('http://127.0.0.1:3000/.well-known/oauth-protected-resource/v1');
    expect(c.apiBase).toBe('http://127.0.0.1:3002/api/v1');
  });

  it('the API base is LEXAPI_BASE_URL (default https://lex-api.com/api/v1); LEXAPI_API_BASE may only repeat it', () => {
    expect(oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32 })!.apiBase).toBe('https://lex-api.com/api/v1');
    expect(oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_API_BASE: 'https://lex-api.com/api/v1/' })!.apiBase).toBe('https://lex-api.com/api/v1');
    expect(oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_BASE_URL: 'https://lex-api.com/api/v1', LEXAPI_API_BASE: 'https://lex-api.com/api/v1' })!.apiBase).toBe('https://lex-api.com/api/v1');
    expect(oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, LEXAPI_MCP_TRUST_PROXY_HOPS: '1' })!.trustProxyHops).toBe(1);
  });

  it('PRM document and challenge match exactly', () => {
    const c = oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32 })!;
    expect(protectedResourceMetadata(c)).toEqual({
      resource: 'https://mcp.lex-api.com/v1',
      authorization_servers: ['https://lex-api.com'],
      scopes_supported: ['lex'],
      bearer_methods_supported: ['header'],
      resource_name: 'LexAPI MCP server',
      resource_documentation: 'https://lex-api.com/docs#mcp-oauth',
    });
    expect(bearerChallenge(c)).toBe('Bearer realm="lexapi", resource_metadata="https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1", scope="lex"');
    expect(bearerChallenge(c, { code: 'invalid_token', description: 'token "expired"\r\nX: y' })).toBe(
      'Bearer realm="lexapi", resource_metadata="https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1", scope="lex", error="invalid_token", error_description="token  expired   X: y"',
    );
  });
});

describe('redaction', () => {
  it('scrubs JWTs, API keys, handles, Basic/Bearer credentials and named secrets', () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLXNpZw';
    const out = redact(`a ${jwt} b lex_live_${'a'.repeat(64)} c lxzz_abcdefghijk d Basic dXNlcjpwYXNz e Bearer abcdefghij f MYSECRETVALUE`, ['MYSECRETVALUE']);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('lex_live_');
    expect(out).not.toContain('lxzz_abc');
    expect(out).not.toContain('dXNlcjpwYXNz');
    expect(out).not.toContain('abcdefghij');
    expect(out).not.toContain('MYSECRETVALUE');
  });
});

describe('token shape', () => {
  it('tells API keys and JWTs apart by shape', () => {
    expect(looksLikeJwt(`lex_live_${'a'.repeat(64)}`)).toBe(false);
    expect(looksLikeJwt(`lex_test_${'0'.repeat(64)}`)).toBe(false);
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeJwt('aaa.bbb.')).toBe(false);
    expect(looksLikeJwt('a.b.c.d')).toBe(false);
  });
});

describe('JWT validation', () => {
  let as: MockAs;
  let jwks: JwksCache;
  const verify = (t: string, now?: () => number) => verifyAccessToken(t, { issuer: as.issuer, audience: RESOURCE, jwks, ...(now ? { now } : {}) });
  const reason = async (t: string, now?: () => number) => {
    try {
      await verify(t, now);
      return 'ACCEPTED';
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTokenError);
      return (e as Error).message;
    }
  };

  beforeAll(async () => {
    as = await startMockAs();
    jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json` });
  });
  afterAll(() => as.close());

  it('accepts a valid LexAPI MCP access token and returns its claims', async () => {
    const claims = await verify(as.mint({ sub: 'u42' }));
    expect(claims).toMatchObject({ iss: as.issuer, aud: RESOURCE, sub: 'u42', scope: 'lex', client_id: 'lxc_claude' });
    // typ is case-insensitive; application/at+jwt is the same media type.
    expect(await reason(as.mint({ header: { typ: 'AT+JWT' } }))).toBe('ACCEPTED');
    expect(await reason(as.mint({ header: { typ: 'application/at+jwt' } }))).toBe('ACCEPTED');
    expect(await reason(as.mint({ claims: { scope: 'offline_access lex' } }))).toBe('ACCEPTED');
  });

  it('alg confusion: none, HS256 keyed with the public key, RS256/ES384 labels → refused', async () => {
    const k = as.keys[0];
    const payload = JSON.parse(Buffer.from(as.mint().split('.')[1], 'base64url').toString());
    expect(await reason(signJwt({ alg: 'none', typ: 'at+jwt', kid: k.kid }, payload))).toMatch(/malformed|algorithm/);
    expect(await reason(signJwt({ alg: 'none', typ: 'at+jwt', kid: k.kid }, payload) + 'AAAA')).toBe('unsupported algorithm');
    expect(await reason(signJwt({ alg: 'HS256', typ: 'at+jwt', kid: k.kid }, payload, publicKeyBytes(k)))).toBe('unsupported algorithm');
    expect(await reason(signJwt({ alg: 'HS256', typ: 'at+jwt', kid: k.kid }, payload, Buffer.from(CLIENT_SECRET)))).toBe('unsupported algorithm');
    // An ES256 signature under a different label.
    const es = as.mint().split('.');
    for (const alg of ['RS256', 'ES384', 'es256', 'PS256']) {
      const h = Buffer.from(JSON.stringify({ alg, typ: 'at+jwt', kid: k.kid })).toString('base64url');
      expect(await reason(`${h}.${es[1]}.${es[2]}`)).toBe('unsupported algorithm');
    }
  });

  it('wrong typ, missing kid, crit header → refused', async () => {
    expect(await reason(as.mint({ header: { typ: 'JWT' } }))).toBe('not an access token');
    expect(await reason(as.mint({ header: { typ: undefined } }))).toBe('not an access token');
    expect(await reason(as.mint({ header: { kid: undefined } }))).toBe('missing key id');
    expect(await reason(as.mint({ header: { crit: ['exp'] } }))).toBe('unsupported critical header');
  });

  it('a tampered payload or a foreign key → invalid signature / unknown key', async () => {
    const [h, , s] = as.mint({ sub: 'victim' }).split('.');
    const p = Buffer.from(JSON.stringify({ iss: as.issuer, aud: RESOURCE, sub: 'attacker', scope: 'lex', client_id: 'c', gid: 'g', sid: 's', jti: 'j', iat: 1, exp: 9e9 })).toString('base64url');
    expect(await reason(`${h}.${p}.${s}`)).toBe('invalid signature');
    // Same kid as ours, signed by a different key.
    const evil = newSigningKey();
    expect(await reason(as.mint({ key: { ...evil, kid: as.keys[0].kid } }))).toBe('invalid signature');
  });

  it('wrong iss / aud (incl. the API audience and multi-audience) → refused', async () => {
    expect(await reason(as.mint({ claims: { iss: 'https://evil.example' } }))).toBe('wrong issuer');
    expect(await reason(as.mint({ claims: { aud: as.apiAudience } }))).toBe('wrong audience');
    expect(await reason(as.mint({ claims: { aud: 'https://mcp.lex-api.com/v1/' } }))).toBe('wrong audience');
    expect(await reason(as.mint({ claims: { aud: [RESOURCE, as.apiAudience] } }))).toBe('wrong audience');
    expect(await reason(as.mint({ claims: { aud: [RESOURCE] } }))).toBe('ACCEPTED');
  });

  it('exp / iat / nbf with a 5 s clock skew', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await reason(as.mint({ claims: { iat: now - 1000, exp: now - 61 } }))).toBe('token expired');
    // Expired 30 s / 6 s ago: refused locally — no wasted exchange.
    expect(await reason(as.mint({ claims: { iat: now - 1000, exp: now - 30 } }))).toBe('token expired');
    expect(await reason(as.mint({ claims: { iat: now - 1000, exp: now - 6 } }))).toBe('token expired');
    expect(await reason(as.mint({ claims: { iat: now - 1000, exp: now - 2 } }))).toBe('ACCEPTED');
    expect(await reason(as.mint({ claims: { exp: undefined } }))).toBe('missing expiry');
    expect(await reason(as.mint({ claims: { exp: '9999999999' } }))).toBe('missing expiry');
    expect(await reason(as.mint({ claims: { iat: now + 120 } }))).toBe('token issued in the future');
    expect(await reason(as.mint({ claims: { iat: now + 30 } }))).toBe('token issued in the future');
    expect(await reason(as.mint({ claims: { iat: now + 2 } }))).toBe('ACCEPTED');
    expect(await reason(as.mint({ claims: { iat: undefined } }))).toBe('missing issued-at');
    expect(await reason(as.mint({ claims: { nbf: now + 30 } }))).toBe('token not yet valid');
    expect(await reason(as.mint({ claims: { nbf: now + 2 } }))).toBe('ACCEPTED');
    // A frozen clock: valid now, expired 16 minutes later.
    const t = as.mint();
    expect(await reason(t, () => (now + 16 * 60 + 61) * 1000)).toBe('token expired');
  });

  it('scope must contain lex; sub, client_id, gid, sid, jti must be non-empty strings', async () => {
    expect(await reason(as.mint({ claims: { scope: 'other' } }))).toBe('insufficient scope');
    expect(await reason(as.mint({ claims: { scope: 'lexx' } }))).toBe('insufficient scope');
    expect(await reason(as.mint({ claims: { scope: undefined } }))).toBe('insufficient scope');
    for (const c of ['sub', 'client_id', 'gid', 'sid', 'jti']) {
      expect(await reason(as.mint({ claims: { [c]: '' } }))).toBe(`missing ${c} claim`);
      expect(await reason(as.mint({ claims: { [c]: 42 } }))).toBe(`missing ${c} claim`);
    }
  });

  it('malformed tokens are refused without throwing anything else', async () => {
    for (const t of ['a.b.c', 'e30.e30.', `${'a'.repeat(9000)}.b.c`, 'not-a-jwt']) {
      expect(await reason(t)).toMatch(/malformed|algorithm|invalid/);
    }
  });
});

describe('JWKS cache', () => {
  let as: MockAs;
  beforeAll(async () => { as = await startMockAs(); });
  afterAll(() => as.close());
  afterEach(() => { as.published = [as.keys[0]]; as.keys = [as.keys[0]]; as.jwksDown = false; });

  it('respects max-age (≥ 5 min): one fetch, then a refetch after expiry', async () => {
    let t = 1_000_000;
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json`, now: () => t });
    const before = as.jwksFetches;
    for (let i = 0; i < 5; i++) expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
    expect(as.jwksFetches - before).toBe(1);
    t += 299_000;
    await jwks.getKey(as.keys[0].kid);
    await jwks.settled();
    expect(as.jwksFetches - before).toBe(1);
    t += 2_000;
    // Expired: the stale key answers at once, the refetch runs in the background.
    expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
    await jwks.settled();
    expect(as.jwksFetches - before).toBe(2);
  });

  it('unknown kid → one refetch (finds a rotated key); further unknown kids refetch at most once per 60 s', async () => {
    let t = 5_000_000;
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json`, now: () => t });
    await jwks.getKey(as.keys[0].kid);
    // Rotation: a NEXT key is published, then starts signing.
    const next = newSigningKey();
    as.keys = [next, as.keys[0]];
    as.published = [next, as.keys[1]];
    const base = as.jwksFetches;
    t += 60_000;
    expect(await jwks.getKey(next.kid)).toBeDefined();
    expect(as.jwksFetches - base).toBe(1);
    // Garbage kids within 60 s: no further fetches.
    for (let i = 0; i < 10; i++) expect(await jwks.getKey(`nope${i}`)).toBeUndefined();
    expect(as.jwksFetches - base).toBe(1);
    t += 60_000;
    expect(await jwks.getKey('nope-again')).toBeUndefined();
    expect(as.jwksFetches - base).toBe(2);
  });

  it('an unknown kid soon after a fetch does not refetch (and the token is refused as unknown key)', async () => {
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json` });
    const t = as.mint();
    await verifyAccessToken(t, { issuer: as.issuer, audience: RESOURCE, jwks });
    const base = as.jwksFetches;
    const stranger = newSigningKey();
    await expect(verifyAccessToken(as.mint({ key: stranger }), { issuer: as.issuer, audience: RESOURCE, jwks })).rejects.toThrow('unknown signing key');
    expect(as.jwksFetches).toBe(base);
  });

  it('JWKS down at cold start → JwksUnavailableError (503, not a 401); stale keys keep serving later', async () => {
    let t = 9_000_000;
    as.jwksDown = true;
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json`, now: () => t });
    await expect(jwks.getKey(as.keys[0].kid)).rejects.toBeInstanceOf(JwksUnavailableError);
    as.jwksDown = false;
    t += 5_000;
    expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
    as.jwksDown = true;
    t += 10 * 60_000; // expired
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await jwks.getKey(as.keys[0].kid)).toBeDefined();
    await jwks.settled();
    spy.mockRestore();
  });

  it('concurrent first requests join the in-flight fetch (one fetch, no spurious 503)', async () => {
    const jwks = new JwksCache({ url: `${as.issuer}/.well-known/jwks.json` });
    const base = as.jwksFetches;
    const keys = await Promise.all(Array.from({ length: 20 }, () => jwks.getKey(as.keys[0].kid)));
    expect(keys.every(Boolean)).toBe(true);
    expect(as.jwksFetches - base).toBe(1);
  });

  it('ignores keys that are not P-256 signing keys', async () => {
    const k = newSigningKey();
    const fake = (async () => new Response(JSON.stringify({ keys: [
      { ...k.jwk, alg: 'RS256' },
      { ...k.jwk, use: 'enc', kid: 'enc' },
      { ...k.jwk, crv: 'P-384', kid: 'p384' },
      { kty: 'oct', k: 'c2VjcmV0', kid: 'hmac' },
      { ...k.jwk, kid: 'good' },
    ] }), { status: 200 })) as typeof fetch;
    const jwks = new JwksCache({ url: 'https://as.example/jwks', fetch: fake });
    expect(await jwks.getKey('good')).toBeDefined();
    for (const kid of [k.kid, 'enc', 'p384', 'hmac']) expect(await jwks.getKey(kid)).toBeUndefined();
  });
});

describe('token exchange', () => {
  let as: MockAs;
  beforeAll(async () => { as = await startMockAs(); });
  afterAll(() => as.close());
  afterEach(() => { as.tokenOverrides = []; as.apiTokenTtlS = 300; });

  const exchanger = (o: Partial<ConstructorParameters<typeof TokenExchanger>[0]> = {}) => new TokenExchanger({
    tokenEndpoint: `${as.issuer}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiAudience: as.apiAudience,
    sleep: async () => {}, ...o,
  });
  const expOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp as number;

  it('sends the RFC 8693 request: Basic (form-encoded) client auth, token-exchange grant, API resource', async () => {
    const subject = as.mint();
    const before = as.seen.length;
    const api = await exchanger().getApiToken(subject, expOf(subject));
    const call = as.seen.slice(before).find((s) => s.path === '/oauth/token')!;
    expect(call.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${encodeURIComponent(CLIENT_SECRET).replace(/%20/g, '+')}`).toString('base64')}`);
    const form = Object.fromEntries(new URLSearchParams(call.body));
    expect(form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subject,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: as.apiAudience,
    });
    expect(api).not.toBe(subject);
    expect(JSON.parse(Buffer.from(api.split('.')[1], 'base64url').toString())).toMatchObject({ aud: as.apiAudience, act: { sub: CLIENT_ID } });
  });

  it('caches per subject token until exp − 30 s, then exchanges again', async () => {
    let t = Date.now();
    const ex = exchanger({ now: () => t });
    const subject = as.mint();
    const a = await ex.getApiToken(subject, expOf(subject));
    const b = await ex.getApiToken(subject, expOf(subject));
    expect(b).toBe(a);
    expect(ex.exchanges).toBe(1);
    t += 269_000; // 300 − 30 − 1 s
    expect(await ex.getApiToken(subject, expOf(subject))).toBe(a);
    expect(ex.exchanges).toBe(1);
    t += 2_000;
    await ex.getApiToken(subject, expOf(subject));
    expect(ex.exchanges).toBe(2);
  });

  it('honours a short expires_in: under 30 s it is used once and never cached', async () => {
    as.apiTokenTtlS = 20;
    const ex = exchanger();
    const subject = as.mint();
    await ex.getApiToken(subject, expOf(subject));
    await ex.getApiToken(subject, expOf(subject));
    expect(ex.exchanges).toBe(2);
    expect(ex.size).toBe(0);
  });

  it('never caches past the subject token’s own exp', async () => {
    let t = Date.now();
    const ex = exchanger({ now: () => t });
    const nowS = Math.floor(t / 1000);
    const subject = as.mint({ claims: { exp: nowS + 100 } });
    // The mock caps API exp at the subject exp; also lie in expires_in to prove our own cap.
    as.tokenOverrides.push({ status: 200, body: { access_token: 'api.token.one', token_type: 'Bearer', expires_in: 300 } });
    await ex.getApiToken(subject, nowS + 100);
    t += 71_000; // past subject exp − 30 s
    as.tokenOverrides.push({ status: 200, body: { access_token: 'api.token.two', token_type: 'Bearer', expires_in: 300 } });
    expect(await ex.getApiToken(subject, nowS + 100)).toBe('api.token.two');
  });

  it('never shares an API token across subject tokens (keys are hashes of the whole token)', async () => {
    const ex = exchanger();
    const s1 = as.mint({ sub: 'alice' });
    const s2 = as.mint({ sub: 'bob' });
    const [a, b] = await Promise.all([ex.getApiToken(s1, expOf(s1)), ex.getApiToken(s2, expOf(s2))]);
    expect(a).not.toBe(b);
    expect(JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString()).sub).toBe('alice');
    expect(JSON.parse(Buffer.from(b.split('.')[1], 'base64url').toString()).sub).toBe('bob');
    expect(subjectKey(s1)).not.toBe(subjectKey(s2));
    expect(subjectKey(s1)).not.toContain(s1.slice(0, 20));
  });

  it('concurrent requests with the same subject share one exchange', async () => {
    const ex = exchanger();
    const s = as.mint();
    const all = await Promise.all(Array.from({ length: 10 }, () => ex.getApiToken(s, expOf(s))));
    expect(new Set(all).size).toBe(1);
    expect(ex.exchanges).toBe(1);
  });

  it('the cache is bounded (oldest evicted)', async () => {
    const ex = exchanger({ maxEntries: 3 });
    const subs = Array.from({ length: 5 }, (_, i) => as.mint({ sub: `u${i}` }));
    for (const s of subs) await ex.getApiToken(s, expOf(s));
    expect(ex.size).toBe(3);
    await ex.getApiToken(subs[0], expOf(subs[0])); // evicted → exchanges again
    expect(ex.exchanges).toBe(6);
  });

  it('invalidate is compare-and-delete: a fresher token from another request survives', async () => {
    const ex = exchanger();
    const s = as.mint();
    const a = await ex.getApiToken(s, expOf(s));
    ex.invalidate(s, 'some-older-token');
    expect(await ex.getApiToken(s, expOf(s))).toBe(a);
    ex.invalidate(s, a);
    expect(await ex.getApiToken(s, expOf(s))).not.toBe(a);
  });

  it('maps every exchange error to its action, and logs config problems without secrets or tokens', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = as.mint();
    const kindOf = async (status: number, body: unknown, headers?: Record<string, string>) => {
      as.tokenOverrides.push({ status, body, ...(headers ? { headers } : {}) });
      try {
        await exchanger().getApiToken(s, expOf(s));
        return 'ok';
      } catch (e) {
        expect(e).toBeInstanceOf(ExchangeError);
        return e as ExchangeError;
      }
    };
    expect((await kindOf(400, { error: 'invalid_request', error_description: 'subject_token rejected: grant revoked' }) as ExchangeError).kind).toBe('invalid_token');
    expect((await kindOf(400, { error: 'invalid_target', error_description: 'resource must be …' }) as ExchangeError).kind).toBe('config');
    expect((await kindOf(400, { error: 'invalid_scope' }) as ExchangeError).kind).toBe('config');
    expect((await kindOf(401, { error: 'invalid_client', error_description: 'client authentication failed' }, { 'www-authenticate': 'Basic' }) as ExchangeError).kind).toBe('client_auth');
    const rl = await kindOf(429, { error: 'temporarily_unavailable', error_description: 'Too many requests. Retry after 7 s.' }, { 'retry-after': '7' }) as ExchangeError;
    expect(rl.kind).toBe('rate_limited');
    expect(rl.retryAfterSeconds).toBe(7);
    expect((await kindOf(503, { error: 'temporarily_unavailable' }) as ExchangeError).kind).toBe('unavailable');
    expect((await kindOf(200, { token_type: 'Bearer' }) as ExchangeError).kind).toBe('upstream');
    // 5xx: retried once, then 502.
    as.tokenOverrides.push({ status: 500, body: { error: 'server_error' } });
    expect((await kindOf(502, { error: 'bad gateway' }) as ExchangeError).kind).toBe('upstream');
    as.tokenOverrides.push({ status: 500, body: { error: 'server_error' } });
    const ex = exchanger();
    expect(await ex.getApiToken(s, expOf(s))).toMatch(/\./);
    expect(ex.exchanges).toBe(2);
    // An AS that echoes the subject token in its description never gets it into a message or a log.
    const echo = await kindOf(400, { error: 'invalid_scope', error_description: `bad ${s} with ${CLIENT_SECRET}` }) as ExchangeError;
    expect(echo.description).not.toContain(s);
    expect(echo.description).not.toContain(CLIENT_SECRET);
    const logged = spy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/OAUTH CONFIGURATION PROBLEM/);
    expect(logged).not.toContain(s);
    expect(logged).not.toContain(CLIENT_SECRET);
    spy.mockRestore();
  });

  it('a network failure is retried once, then reported without runtime text', async () => {
    let n = 0;
    const ex = exchanger({ fetch: (async () => { n++; throw new TypeError(`connect failed for ${CLIENT_SECRET}`); }) as typeof fetch });
    const s = as.mint();
    const err = await ex.getApiToken(s, expOf(s)).catch((e) => e);
    expect(err).toBeInstanceOf(ExchangeError);
    expect(err.kind).toBe('upstream');
    expect(err.description).not.toContain(CLIENT_SECRET);
    expect(n).toBe(2);
  });

  it('an aborted caller stops waiting without failing the shared exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ex = exchanger({ fetch: (async (u: string, i: RequestInit) => { await gate; return fetch(u, i); }) as typeof fetch });
    const s = as.mint();
    const ctl = new AbortController();
    const p1 = ex.getApiToken(s, expOf(s), ctl.signal).catch((e) => e);
    const p2 = ex.getApiToken(s, expOf(s));
    ctl.abort();
    expect((await p1).name).toBe('AbortError');
    release();
    expect(await p2).toMatch(/\./);
  });
});

describe('OAuth upstream credential in LexAPIClient', () => {
  let as: MockAs;
  beforeAll(async () => { as = await startMockAs(); });
  afterAll(() => as.close());

  const expOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp as number;
  const setup = (subject: string, gate?: ResponseGate) => {
    const ex = new TokenExchanger({ tokenEndpoint: `${as.issuer}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiAudience: as.apiAudience });
    const client = new LexAPIClient({ auth: new OAuthUpstreamAuth(subject, expOf(subject), ex, gate), baseUrl: as.apiBase, sleep: async () => {} });
    return { ex, client };
  };

  it('calls the API with Bearer <API token> and no x-api-key — never the inbound token', async () => {
    const subject = as.mint({ sub: 'carol' });
    const { client } = setup(subject);
    const before = as.seen.length;
    const res = await client.info();
    expect(res.body.service).toBe('user:carol');
    const apiCalls = as.seen.slice(before).filter((s) => s.path.startsWith('/api/v1/'));
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].apiKey).toBeUndefined();
    expect(apiCalls[0].authorization).toMatch(/^Bearer /);
    expect(apiCalls[0].authorization).not.toContain(subject);
  });

  it('API 401 invalid_token → drop the cached token, exchange once more, succeed', async () => {
    const subject = as.mint({ sub: 'dave' });
    const { ex, client } = setup(subject);
    await client.info();
    // Poison the cache with an API-audience token the API refuses (not issued by an exchange).
    (ex as any).cache.set(subjectKey(subject), { token: as.mint({ sub: 'dave', claims: { aud: as.apiAudience } }), useUntil: Date.now() + 60_000 });
    const res = await client.info();
    expect(res.body.service).toBe('user:dave');
    expect(ex.exchanges).toBe(2);
  });

  it('revoked connection: API 401 → re-exchange 400 → UpstreamAuthError 401 invalid_token, recorded on the gate', async () => {
    const subject = as.mint({ sub: 'erin', gid: 'g_erin' });
    const gate = new ResponseGate();
    const { client } = setup(subject, gate);
    await client.info();
    as.revoke('g_erin');
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect(err).toMatchObject({ kind: 'invalid_token', httpStatus: 401 });
    expect(gate.failure).toBe(err);
    expect(describeError(err)).toMatch(/reconnect LexAPI/);
  });

  it('a freshly exchanged token refused again → api_rejected (no loop, not a re-auth trigger)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const subject = as.mint({ sub: 'frank' });
    const gate = new ResponseGate();
    const ex = new TokenExchanger({ tokenEndpoint: `${as.issuer}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiAudience: as.apiAudience });
    let apiCalls = 0;
    const fakeApi = (async (u: string | URL, i: RequestInit) => {
      if (String(u).includes('/oauth/token')) return fetch(u, i);
      apiCalls++;
      return new Response('{"error":"Invalid access token"}', { status: 401, headers: { 'www-authenticate': 'Bearer realm="lexapi", error="invalid_token"' } });
    }) as typeof fetch;
    const ex2 = new TokenExchanger({ tokenEndpoint: `${as.issuer}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiAudience: as.apiAudience, fetch: fakeApi });
    const client = new LexAPIClient({ auth: new OAuthUpstreamAuth(subject, expOf(subject), ex2, gate), baseUrl: as.apiBase, fetch: fakeApi, sleep: async () => {} });
    const err = await client.info().catch((e) => e);
    expect(err).toMatchObject({ kind: 'api_rejected' });
    expect(apiCalls).toBe(2);
    expect(ex2.exchanges).toBe(2);
    expect(gate.failure).toBeUndefined();
    expect(ex.exchanges).toBe(0);
    spy.mockRestore();
  });

  it('exchange misconfiguration is gated with its HTTP status; 429 / 5xx stay tool errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: Array<[number, unknown, string, number, boolean]> = [
      [401, { error: 'invalid_client' }, 'client_auth', 503, true],
      [400, { error: 'invalid_target' }, 'config', 500, true],
      [503, { error: 'temporarily_unavailable' }, 'unavailable', 503, true],
      [429, { error: 'temporarily_unavailable' }, 'rate_limited', 429, false],
    ];
    for (const [status, body, kind, httpStatus, gated] of cases) {
      const subject = as.mint();
      const gate = new ResponseGate();
      const { client } = setup(subject, gate);
      as.tokenOverrides.push({ status, body });
      const err = await client.info().catch((e) => e);
      expect(err).toMatchObject({ kind, httpStatus });
      expect(Boolean(gate.failure)).toBe(gated);
      expect(describeError(err)).not.toMatch(/API key is missing/);
    }
    spy.mockRestore();
  });
});
