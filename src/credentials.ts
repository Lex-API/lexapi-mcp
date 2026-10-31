// Strict classification of the credential an MCP HTTP request carries.
//
// The invariant: a value that could be an inbound OAuth access token is
// NEVER forwarded to LexAPI's REST API, whatever header it arrives in and
// however it is padded. LexAPI API keys start with `lex_` and never contain
// a '.', while every JWT does — so a value containing a '.' is never an API
// key, in either mode.

import type { IncomingMessage } from 'node:http';

/**
 * Longest credential value considered at all. Checked on the value as soon
 * as it is read from its header, BEFORE any routing, so an oversized token can
 * never fall through to the API-key path (both API keys and access tokens
 * are far shorter).
 */
export const MAX_CREDENTIAL_LENGTH = 8192;

/**
 * What counts as an API key when OAuth is on: any `lex_` value made of word characters is accepted as a key (so a
 * mistyped or older key still gets the API's own 401 as before). It can
 * never match a JWT: no '.', no '-', and a JWT starts with `eyJ`.
 */
const API_KEY_SHAPE = /^lex_[A-Za-z0-9_]{1,256}$/;

export function isApiKeyShaped(value: string): boolean {
  return API_KEY_SHAPE.test(value);
}

/** Could be a JWT / JWS (or a fragment of one): API keys never contain a '.'. */
export function isTokenShaped(value: string): boolean {
  return value.includes('.');
}

export type RejectReason = 'too_long' | 'token_as_api_key' | 'not_an_api_key';

/** The credential an MCP request carries. */
export type Credential =
  | { kind: 'none' }
  | { kind: 'apiKey'; key: string }
  | { kind: 'oauth'; token: string }
  /** A value that must not be used at all — answered 401 locally, never forwarded. */
  | { kind: 'rejected'; header: 'authorization' | 'x-api-key'; reason: RejectReason };

const BEARER = /^Bearer\s+(.+?)\s*$/i;

function header(req: IncomingMessage, name: 'authorization' | 'x-api-key'): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * The caller's LexAPI key as 0.3.0 read it: `Authorization: Bearer <key>`,
 * else `x-api-key: <key>`. A value with inner whitespace is returned as-is
 * so it is reported as malformed, not as missing.
 */
export function extractApiKey(req: IncomingMessage): string | null {
  const auth = header(req, 'authorization');
  if (auth !== undefined) {
    const m = auth.match(BEARER);
    if (m) return m[1];
  }
  const x = header(req, 'x-api-key');
  if (x !== undefined && x.trim()) return x.trim();
  return null;
}

/**
 * OAuth off: 0.3.0's precedence and key handling, except that a value which
 * is too long or token-shaped is refused instead of being forwarded.
 *
 * OAuth on:
 *  - `x-api-key` wins when present; it must be API-key shaped — a JWT (or
 *    anything else) there is refused, never forwarded and never exchanged;
 *  - `Authorization: Bearer <lex_…>` is an API key;
 *  - any other Bearer value is an OAuth access token (garbage is then
 *    refused by validation with 401 invalid_token);
 *  - the length cap applies before any of this.
 */
export function classifyCredential(req: IncomingMessage, oauthEnabled: boolean): Credential {
  const auth = header(req, 'authorization');
  const x = header(req, 'x-api-key');

  if (!oauthEnabled) {
    const bearer = auth === undefined ? null : auth.match(BEARER);
    if (bearer) {
      const key = bearer[1];
      if (key.length > MAX_CREDENTIAL_LENGTH) return { kind: 'rejected', header: 'authorization', reason: 'too_long' };
      return isTokenShaped(key) ? { kind: 'rejected', header: 'authorization', reason: 'token_as_api_key' } : { kind: 'apiKey', key };
    }
    if (x !== undefined && x.trim()) {
      const key = x.trim();
      if (key.length > MAX_CREDENTIAL_LENGTH) return { kind: 'rejected', header: 'x-api-key', reason: 'too_long' };
      return isTokenShaped(key) ? { kind: 'rejected', header: 'x-api-key', reason: 'token_as_api_key' } : { kind: 'apiKey', key };
    }
    return { kind: 'none' };
  }

  if (x !== undefined && x.trim()) {
    const key = x.trim();
    if (key.length > MAX_CREDENTIAL_LENGTH) return { kind: 'rejected', header: 'x-api-key', reason: 'too_long' };
    if (isTokenShaped(key)) return { kind: 'rejected', header: 'x-api-key', reason: 'token_as_api_key' };
    return isApiKeyShaped(key) ? { kind: 'apiKey', key } : { kind: 'rejected', header: 'x-api-key', reason: 'not_an_api_key' };
  }
  const bearer = auth === undefined ? null : auth.match(BEARER);
  if (bearer) {
    const value = bearer[1];
    if (value.length > MAX_CREDENTIAL_LENGTH) return { kind: 'rejected', header: 'authorization', reason: 'too_long' };
    return isApiKeyShaped(value) ? { kind: 'apiKey', key: value } : { kind: 'oauth', token: value };
  }
  return { kind: 'none' };
}

/** How the client address was derived for one request. */
export interface ClientAddress {
  ip: string;
  /** Entries in X-Forwarded-For (0 when absent). */
  xffEntries: number;
  /**
   * LEXAPI_MCP_TRUST_PROXY_HOPS > 0 but X-Forwarded-For has fewer entries:
   * the hop count is too high for this path (or a proxy replaces the header),
   * so the socket peer — a proxy — is used instead. Warn; never silent.
   */
  short: boolean;
}

/**
 * The client address used for per-IP limits. With LEXAPI_MCP_TRUST_PROXY_HOPS
 * = N > 0 the server sits behind N reverse proxies that each append to
 * X-Forwarded-For, so the client is the N-th entry from the right (entries
 * further left are client-controlled and ignored). N = 0: the socket peer.
 */
export function deriveClientAddress(req: IncomingMessage, trustProxyHops: number): ClientAddress {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  const hops = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (trustProxyHops <= 0) return { ip: socketIp, xffEntries: hops.length, short: false };
  if (hops.length < trustProxyHops) return { ip: socketIp, xffEntries: hops.length, short: true };
  const ip = hops[hops.length - trustProxyHops];
  return { ip: ip.length <= 64 ? ip : socketIp, xffEntries: hops.length, short: false };
}

export function clientIp(req: IncomingMessage, trustProxyHops: number): string {
  return deriveClientAddress(req, trustProxyHops).ip;
}
