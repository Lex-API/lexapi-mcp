// A local stand-in for LexAPI's OAuth authorization server and its REST API:
//   GET  /.well-known/jwks.json   ES256 JWKS (Cache-Control: public, max-age=300)
//   POST /oauth/token             RFC 8693 token exchange, Basic client auth
//   ANY  /api/v1/*                x-api-key (lex_…) or Bearer <API-audience token>
// It mints MCP access tokens for tests, can rotate / revoke / misbehave on
// demand, and records every request so tests can assert what was sent where.
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { registerInbound } from './setup.js';

export const RESOURCE = 'https://mcp.lex-api.com/v1';
export const CLIENT_ID = 'lexapi-mcp-server';
export const CLIENT_SECRET = 'FAKE-test-secret-with-special-chars:+/ %&=0123456789';

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: Record<string, string>;
}

export function newSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const kid = createHash('sha256').update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y })).digest('base64url');
  return { kid, privateKey, publicKey, jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, kid, use: 'sig', alg: 'ES256' } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Sign a JWT with arbitrary header — including the shapes a verifier must refuse. */
export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key?: KeyObject | Buffer | null): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const alg = header.alg;
  let sig = '';
  if (alg === 'ES256' && key && !(key instanceof Buffer)) {
    sig = cryptoSign('sha256', Buffer.from(input), { key: key as KeyObject, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  } else if (alg === 'HS256' && key) {
    sig = createHmac('sha256', key as Buffer).update(input).digest('base64url');
  } else if (alg === 'none') {
    sig = '';
  }
  return `${input}.${sig}`;
}

interface Grant { sub: string; revoked: boolean }

export interface Seen {
  path: string;
  method: string;
  authorization?: string;
  apiKey?: string;
  body: string;
}

export interface MockAs {
  issuer: string;
  apiBase: string;
  apiAudience: string;
  keys: SigningKey[];
  /** Keys published in the JWKS (tests rotate by changing this). */
  published: SigningKey[];
  grants: Map<string, Grant>;
  seen: Seen[];
  jwksFetches: number;
  exchanges: number;
  /** Override the next token-endpoint answers (FIFO). */
  tokenOverrides: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
  /**
   * Per-user answers of the token endpoint (subject `sub` → answer), given
   * after client authentication for as long as the entry stays (a per-user
   * slow-down).
   */
  userLimited: Map<string, { status: number; body: unknown; headers?: Record<string, string> }>;
  /** expires_in the exchange grants (capped by the subject's exp). */
  apiTokenTtlS: number;
  /** A JWKS outage. */
  jwksDown: boolean;
  /** path → Location: answered 302 (redirect-following tests). */
  redirects: Map<string, string>;
  mint(opts?: { sub?: string; gid?: string; claims?: Record<string, unknown>; header?: Record<string, unknown>; key?: SigningKey }): string;
  revoke(gid: string): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
  });
}

function decodeJwt(token: string): { header: any; payload: any; input: string; sig: Buffer } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
      input: `${parts[0]}.${parts[1]}`,
      sig: Buffer.from(parts[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

/** Verifies an API-audience token from this mock. Realm `lexapi` everywhere. */
function verifyOurs(as: MockAs, token: string, audience: string): { ok: true; claims: any } | { ok: false; why: string } {
  const d = decodeJwt(token);
  if (!d || d.header.alg !== 'ES256' || String(d.header.typ).toLowerCase() !== 'at+jwt') return { ok: false, why: 'malformed token' };
  const key = as.keys.find((k) => k.kid === d.header.kid);
  if (!key) return { ok: false, why: 'unknown signing key' };
  if (!cryptoVerify('sha256', Buffer.from(d.input), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, d.sig)) return { ok: false, why: 'signature or claims invalid' };
  const c = d.payload;
  if (c.iss !== as.issuer || c.aud !== audience) return { ok: false, why: 'signature or claims invalid' };
  if (c.exp + 5 <= Date.now() / 1000) return { ok: false, why: 'token expired' };
  return { ok: true, claims: c };
}

export async function startMockAs(): Promise<MockAs> {
  const as = {} as MockAs;
  const first = newSigningKey();
  Object.assign(as, {
    keys: [first],
    published: [first],
    grants: new Map<string, Grant>(),
    seen: [] as Seen[],
    jwksFetches: 0,
    exchanges: 0,
    tokenOverrides: [],
    userLimited: new Map(),
    apiTokenTtlS: 300,
    jwksDown: false,
    redirects: new Map<string, string>(),
  });

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? '/').split('?')[0];
    as.seen.push({
      path,
      method: req.method ?? '',
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'] as string | undefined,
      body,
    });
    const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(v));
    };

    const location = as.redirects.get(path);
    if (location) {
      res.writeHead(302, { location });
      res.end();
      return;
    }

    if (path === '/.well-known/jwks.json') {
      as.jwksFetches += 1;
      if (as.jwksDown) return json(503, { error: 'down' });
      return json(200, { keys: as.published.map((k) => k.jwk) }, { 'cache-control': 'public, max-age=300' });
    }

    if (path === '/oauth/token' && req.method === 'POST') {
      as.exchanges += 1;
      const override = as.tokenOverrides.shift();
      if (override) return json(override.status, override.body, { 'cache-control': 'no-store', ...(override.headers ?? {}) });
      const noStore = { 'cache-control': 'no-store' };
      const h = req.headers.authorization ?? '';
      const m = /^Basic\s+(.+)$/i.exec(h);
      const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
      const i = decoded.indexOf(':');
      const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
      if (i < 0 || dec(decoded.slice(0, i)) !== CLIENT_ID || dec(decoded.slice(i + 1)) !== CLIENT_SECRET) {
        return json(401, { error: 'invalid_client', error_description: 'client authentication failed' }, { ...noStore, 'www-authenticate': 'Basic realm="lexapi"' });
      }
      const form = new URLSearchParams(body);
      const limited = as.userLimited.get(subOf(form.get('subject_token') ?? ''));
      if (limited) return json(limited.status, limited.body, { ...noStore, ...(limited.headers ?? {}) });
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:token-exchange') return json(400, { error: 'unsupported_grant_type' }, noStore);
      if (form.get('subject_token_type') !== 'urn:ietf:params:oauth:token-type:access_token') return json(400, { error: 'invalid_request', error_description: 'subject_token_type' }, noStore);
      const resource = form.get('resource');
      if (resource && resource !== as.apiAudience) return json(400, { error: 'invalid_target', error_description: `resource must be ${as.apiAudience}` }, noStore);
      const v = verifyOurs(as, form.get('subject_token') ?? '', RESOURCE);
      if (!v.ok) return json(400, { error: 'invalid_request', error_description: `subject_token rejected: ${v.why}` }, noStore);
      const g = as.grants.get(v.claims.gid);
      if (!g || g.revoked) return json(400, { error: 'invalid_request', error_description: 'subject_token rejected: grant revoked' }, noStore);
      const iat = Math.floor(Date.now() / 1000);
      const exp = Math.min(iat + as.apiTokenTtlS, v.claims.exp);
      const token = signJwt({ alg: 'ES256', typ: 'at+jwt', kid: as.keys[0].kid }, {
        ...v.claims, aud: as.apiAudience, act: { sub: CLIENT_ID }, jti: randomBytes(16).toString('base64url'), iat, exp,
      }, as.keys[0].privateKey);
      return json(200, { access_token: token, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: exp - iat, scope: 'lex' }, noStore);
    }

    if (path.startsWith('/api/v1/')) {
      let identity: string | undefined;
      const key = req.headers['x-api-key'];
      if (typeof key === 'string') {
        if (!/^lex_(good|live_[0-9a-f]{64}$|test_[0-9a-f]{64}$)/.test(key)) return json(401, { error: 'Invalid API key' });
        identity = `key:${key}`;
      } else {
        const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (!m) return json(401, { error: 'API key required', message: 'Please provide your API key in the x-api-key header' });
        const v = verifyOurs(as, m[1], as.apiAudience);
        const bad = (why: string) => json(401, { error: 'Invalid access token', message: why }, { 'www-authenticate': `Bearer realm="lexapi", error="invalid_token", error_description="${why}"` });
        if (!v.ok) return bad(v.why);
        if (v.claims.act?.sub !== CLIENT_ID) return bad('access token was not issued for this API');
        const g = as.grants.get(v.claims.gid);
        if (!g || g.revoked) return bad('the connection behind this token has been revoked');
        identity = `user:${v.claims.sub}`;
      }
      if (path === '/api/v1/info') return json(200, { service: identity, version: 'mock' });
      if (path === '/api/v1/documentContent') {
        return json(200, { success: true, document: { celex: '32016R0679', title: `doc for ${identity}`, textAvailability: { available: true }, content: { articles: [{ id: 'art_1', number: 'Article 1', content: 'x' }] } } }, { 'x-source': 'corpus' });
      }
      return json(404, { success: false, error: { code: 'NOT_FOUND', message: 'not mocked' } });
    }

    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  as.issuer = `http://127.0.0.1:${port}`;
  as.apiBase = `${as.issuer}/api/v1`;
  as.apiAudience = `${as.issuer}/api/v1`;

  as.mint = (opts = {}) => {
    const sub = opts.sub ?? 'user_1';
    const gid = opts.gid ?? `grant_${sub}`;
    if (!as.grants.has(gid)) as.grants.set(gid, { sub, revoked: false });
    const key = opts.key ?? as.keys[0];
    const iat = Math.floor(Date.now() / 1000);
    const token = signJwt(
      { alg: 'ES256', typ: 'at+jwt', kid: key.kid, ...(opts.header ?? {}) },
      { iss: as.issuer, sub, aud: RESOURCE, client_id: 'lxc_claude', scope: 'lex', gid, sid: `sess_${gid}`, jti: randomBytes(16).toString('base64url'), iat, exp: iat + 900, ...(opts.claims ?? {}) },
      key.privateKey,
    );
    // Anything minted for the MCP resource is an inbound credential: the
    // test-wide guard (tests/setup.ts) fails any test that lets it reach /api/v1.
    if ((opts.claims?.aud ?? RESOURCE) === RESOURCE) registerInbound(token);
    return token;
  };
  as.revoke = (gid) => {
    const g = as.grants.get(gid);
    if (g) g.revoked = true;
  };
  as.close = () => new Promise<void>((r) => server.close(() => r()));
  return as;
}

/** The raw public key bytes an attacker would use as an HMAC secret (alg confusion). */
export function publicKeyBytes(k: SigningKey): Buffer {
  return Buffer.from(k.publicKey.export({ format: 'pem', type: 'spki' }) as string);
}


/** The `sub` of a JWT, unverified (the mock's per-user limit only needs to know whose it is). */
function subOf(token: string): string {
  try {
    return String(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).sub ?? '');
  } catch {
    return '';
  }
}
