// Local validation of inbound MCP access tokens: RFC 9068 JWTs verified
// against the authorization server's published JWKS.
//
// Deliberately no JWT library: the accepted shape is one algorithm and one
// key type, so the whole verifier is node:crypto plus explicit checks —
// nothing here can be talked into `none`, HS256-with-the-public-key, an
// embedded `jwk` / `jku` / `x5u`, or a key we did not fetch from the issuer.

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

import { readCappedText, ResponseTooLargeError } from './body.js';
import { OAUTH_SCOPE } from './config.js';

/**
 * Clock skew allowed on `exp`, `iat` and `nbf`: 5 s either way, kept
 * tight so this server does not accept a token the exchange then refuses as
 * expired. The host must keep NTP time.
 */
export const CLOCK_SKEW_S = 5;
/** JWKS lifetime bounds: `max-age` is respected, but never below 5 min or above a day. */
export const JWKS_MIN_TTL_MS = 5 * 60_000;
export const JWKS_MAX_TTL_MS = 24 * 60 * 60_000;
/**
 * How long past its TTL a cached key set may still be used while the issuer
 * cannot be reached. Beyond this the server answers 503 rather than
 * trusting keys that may have been withdrawn during the outage.
 */
export const JWKS_MAX_STALE_MS = 24 * 60 * 60_000;
/** An unknown `kid` triggers at most one JWKS refetch per this interval. */
export const JWKS_UNKNOWN_KID_REFETCH_MS = 60_000;
/**
 * After a failed fetch the next attempt waits this long, measured from the
 * END of the failed attempt and doubling per consecutive failure up to
 * JWKS_RETRY_MAX_MS — so a hanging issuer is asked at most once per backoff
 * interval, never back to back.
 */
export const JWKS_RETRY_MIN_MS = 5_000;
export const JWKS_RETRY_MAX_MS = 5 * 60_000;
export const JWKS_TIMEOUT_MS = 5_000;
export const JWKS_MAX_BYTES = 64 * 1024;
export const MAX_TOKEN_LENGTH = 8192;

const B64URL = /^[A-Za-z0-9_-]+$/;
/** Three base64url segments — the shape of an access token. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function looksLikeJwt(value: string): boolean {
  return value.length <= MAX_TOKEN_LENGTH && JWT_SHAPE.test(value);
}

/** The token was refused — answer 401 `invalid_token` with this (token-free) reason. */
export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}

/** The signing keys could not be obtained — not the token's fault: answer 503. */
export class JwksUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JwksUnavailableError';
  }
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  client_id: string;
  scope: string;
  gid: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  nbf?: number;
  [claim: string]: unknown;
}

export interface JwksCacheOptions {
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface JwksStats {
  fetches: number;
  failures: number;
  consecutiveFailures: number;
  keys: number;
  /** The cached set is past its TTL (being served while a refresh is retried). */
  stale: boolean;
  /** Seconds since the last successful fetch (null: never). */
  ageSeconds: number | null;
}

/**
 * The issuer's JWKS, cached per `Cache-Control: max-age` (5 min – 24 h).
 *
 * - Cold start (no keys yet): requests wait for the fetch (concurrent ones
 *   share it); a failure is a 503 for them.
 * - Expired: the stale set keeps serving and ONE refresh runs in the
 *   background — no request ever waits on a refetch while a usable set
 *   exists, so a slow or hanging issuer adds no latency.
 * - Failed refreshes back off (5 s, doubling, max 5 min), measured from the
 *   end of the failed attempt.
 * - A stale set is trusted for at most JWKS_MAX_STALE_MS past its TTL.
 * - A fetched document without a single usable ES256 key is a failed fetch
 *   (503), never an empty key set that would refuse every token.
 * - A token signed with a kid we don't know triggers one refetch at most
 *   every 60 s (key rotation publishes the next key in advance).
 */
export class JwksCache {
  private keys: Map<string, KeyObject> | null = null;
  private expiresAt = 0;
  private lastSuccessAt = -Infinity;
  /** End of the last fetch attempt, whatever its outcome. */
  private lastCompletedAt = -Infinity;
  /** No new attempt before this (backoff after a failure). */
  private nextAttemptAt = 0;
  private consecutiveFailures = 0;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Number of network fetches started (tests / health). */
  fetches = 0;
  failures = 0;

  constructor(private readonly opts: JwksCacheOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** A key set that may be used at `now`: fetched, non-empty, not stale beyond the ceiling. */
  private usable(now: number): boolean {
    return !!this.keys && now < this.expiresAt + JWKS_MAX_STALE_MS;
  }

  /** The key for `kid`, undefined when the issuer does not publish it. Throws JwksUnavailableError. */
  async getKey(kid: string): Promise<KeyObject | undefined> {
    const now = this.now();
    if (!this.usable(now)) {
      // Nothing we may trust: this request has to wait for a fetch.
      if (this.inflight || now >= this.nextAttemptAt) await this.refresh().catch(() => {});
      if (!this.usable(this.now())) throw new JwksUnavailableError('signing keys unavailable');
    } else if (now >= this.expiresAt && !this.inflight && now >= this.nextAttemptAt) {
      // Stale but usable: serve it, refresh in the background.
      this.refresh().catch(() => {});
    }
    const keys = this.keys!;
    const hit = keys.get(kid);
    if (hit) return hit;

    // Unknown kid: possibly a rotation we have not seen yet.
    if (this.inflight) {
      await this.refresh().catch(() => {});
      if (this.consecutiveFailures > 0) throw new JwksUnavailableError('signing keys unavailable');
      return this.keys?.get(kid);
    }
    if (this.consecutiveFailures > 0) {
      // The issuer is failing: we cannot tell a rotated key from a forged
      // kid, and refusing the token would make every user re-authorize.
      throw new JwksUnavailableError('signing keys unavailable');
    }
    if (this.now() - this.lastCompletedAt >= JWKS_UNKNOWN_KID_REFETCH_MS) {
      try {
        await this.refresh();
      } catch {
        throw new JwksUnavailableError('signing keys unavailable');
      }
      return this.keys?.get(kid);
    }
    return undefined;
  }

  /** Resolves once no fetch is in flight (tests). */
  async settled(): Promise<void> {
    while (this.inflight) await this.inflight.catch(() => {});
  }

  stats(): JwksStats {
    const now = this.now();
    return {
      fetches: this.fetches,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      keys: this.keys?.size ?? 0,
      stale: !!this.keys && now >= this.expiresAt,
      ageSeconds: Number.isFinite(this.lastSuccessAt) ? Math.round((now - this.lastSuccessAt) / 1000) : null,
    };
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.fetches += 1;
    try {
      const keys = await this.fetchKeys();
      const now = this.now();
      this.keys = keys.keys;
      this.expiresAt = now + keys.ttlMs;
      this.lastSuccessAt = now;
      this.lastCompletedAt = now;
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
    } catch (err) {
      const now = this.now();
      this.failures += 1;
      this.consecutiveFailures += 1;
      this.lastCompletedAt = now;
      const backoff = Math.min(JWKS_RETRY_MAX_MS, JWKS_RETRY_MIN_MS * 2 ** Math.min(this.consecutiveFailures - 1, 16));
      this.nextAttemptAt = now + backoff;
      const reason = err instanceof Error ? err.message : 'error';
      console.error(`[lexapi-mcp] OAuth: JWKS fetch failed (${reason}); ${this.usable(now) ? 'serving the cached keys' : 'no usable keys'} — next attempt in ${Math.round(backoff / 1000)} s`);
      throw err instanceof JwksUnavailableError ? err : new JwksUnavailableError(reason);
    }
  }

  private async fetchKeys(): Promise<{ keys: Map<string, KeyObject>; ttlMs: number }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      });
    } catch (err) {
      throw new JwksUnavailableError(`JWKS fetch failed (${err instanceof Error ? err.name : 'error'})`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new JwksUnavailableError(`JWKS fetch answered ${res.status}`);
    }
    let text: string;
    try {
      text = await readCappedText(res, JWKS_MAX_BYTES);
    } catch (err) {
      throw new JwksUnavailableError(err instanceof ResponseTooLargeError ? 'JWKS document too large' : 'JWKS body could not be read');
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new JwksUnavailableError('JWKS is not JSON');
    }
    const list = doc && typeof doc === 'object' ? (doc as { keys?: unknown }).keys : undefined;
    if (!Array.isArray(list)) throw new JwksUnavailableError('JWKS has no keys array');
    const keys = new Map<string, KeyObject>();
    for (const jwk of list) {
      const k = importEs256Jwk(jwk);
      if (k) keys.set(k.kid, k.key);
    }
    if (keys.size === 0) throw new JwksUnavailableError('JWKS has no usable ES256 signing key');
    return { keys, ttlMs: jwksTtlMs(res.headers.get('cache-control')) };
  }
}

function jwksTtlMs(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '');
  const ms = m ? Number(m[1]) * 1000 : JWKS_MIN_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, ms));
}

/** A P-256 signing key from a JWK, or null for anything else (other kty/crv/alg/use, private parts). */
function importEs256Jwk(jwk: unknown): { kid: string; key: KeyObject } | null {
  if (!jwk || typeof jwk !== 'object') return null;
  const j = jwk as Record<string, unknown>;
  if (j.kty !== 'EC' || j.crv !== 'P-256') return null;
  if (typeof j.kid !== 'string' || !j.kid) return null;
  if (j.alg !== undefined && j.alg !== 'ES256') return null;
  if (j.use !== undefined && j.use !== 'sig') return null;
  if (typeof j.x !== 'string' || typeof j.y !== 'string' || j.d !== undefined) return null;
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, format: 'jwk' });
    return { kid: j.kid, key };
  } catch {
    return null;
  }
}

/**
 * The bytes of a base64url segment, refusing any non-canonical spelling
 * (unused trailing bits set): one token has exactly one string form, so
 * variants cannot multiply cache keys or exchanges.
 */
function segmentBytes(seg: string): Buffer {
  if (!B64URL.test(seg)) throw new InvalidTokenError('malformed token');
  const bytes = Buffer.from(seg, 'base64url');
  if (bytes.toString('base64url') !== seg) throw new InvalidTokenError('malformed token');
  return bytes;
}

function decodeSegment(seg: string): unknown {
  const bytes = segmentBytes(seg);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InvalidTokenError('malformed token');
  }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  jwks: JwksCache;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

/**
 * Verify an inbound MCP access token; returns its claims or throws
 * InvalidTokenError (→ 401 invalid_token) / JwksUnavailableError (→ 503).
 * Reasons are short and never contain token material.
 */
export async function verifyAccessToken(token: string, opts: VerifyOptions): Promise<AccessTokenClaims> {
  if (!looksLikeJwt(token)) throw new InvalidTokenError('malformed token');
  const [h, p, s] = token.split('.');
  const header = decodeSegment(h);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new InvalidTokenError('malformed token');
  const hd = header as Record<string, unknown>;
  // Exact match: JWS `alg` values are case-sensitive; none / HS* / RS* / PS* / ES384 … are all refused.
  if (hd.alg !== 'ES256') throw new InvalidTokenError('unsupported algorithm');
  const typ = typeof hd.typ === 'string' ? hd.typ.toLowerCase() : '';
  if (typ !== 'at+jwt' && typ !== 'application/at+jwt') throw new InvalidTokenError('not an access token');
  if (!nonEmptyString(hd.kid)) throw new InvalidTokenError('missing key id');
  // We understand no critical extensions (RFC 7515 §4.1.11).
  if (hd.crit !== undefined) throw new InvalidTokenError('unsupported critical header');

  const sig = segmentBytes(s);
  if (sig.length !== 64) throw new InvalidTokenError('invalid signature');
  const key = await opts.jwks.getKey(hd.kid);
  if (!key) throw new InvalidTokenError('unknown signing key');
  const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new InvalidTokenError('invalid signature');

  const payload = decodeSegment(p);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new InvalidTokenError('malformed token');
  const c = payload as Record<string, unknown>;

  if (c.iss !== opts.issuer) throw new InvalidTokenError('wrong issuer');
  // Exactly this resource. A token for any other audience — the LexAPI API
  // audience included — is refused (no confused deputy). A one-element array
  // naming only us is the same statement; a multi-audience token is not.
  const aud = c.aud;
  const audOk = aud === opts.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === opts.audience);
  if (!audOk) throw new InvalidTokenError('wrong audience');

  const nowS = (opts.now ?? Date.now)() / 1000;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) throw new InvalidTokenError('missing expiry');
  if (c.exp + CLOCK_SKEW_S <= nowS) throw new InvalidTokenError('token expired');
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) throw new InvalidTokenError('missing issued-at');
  if (c.iat - CLOCK_SKEW_S > nowS) throw new InvalidTokenError('token issued in the future');
  if (c.nbf !== undefined) {
    if (typeof c.nbf !== 'number' || !Number.isFinite(c.nbf)) throw new InvalidTokenError('malformed not-before');
    if (c.nbf - CLOCK_SKEW_S > nowS) throw new InvalidTokenError('token not yet valid');
  }

  if (typeof c.scope !== 'string' || !c.scope.split(' ').includes(OAUTH_SCOPE)) throw new InvalidTokenError('insufficient scope');
  for (const name of ['sub', 'client_id', 'gid', 'sid', 'jti'] as const) {
    if (!nonEmptyString(c[name])) throw new InvalidTokenError(`missing ${name} claim`);
  }
  return c as AccessTokenClaims;
}
