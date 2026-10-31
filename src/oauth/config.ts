// OAuth configuration of the hosted server.
//
// OAuth is ON when LEXAPI_OAUTH_CLIENT_SECRET is set; every other value has
// the production default. Without the secret the server runs as 0.3.0 did:
// API keys only, the old 401, no metadata documents. Setting any other OAuth
// variable WITHOUT the secret refuses to start (a deploy that meant to turn
// OAuth on but lost the secret must fail loudly, not run with sign-in off).

import { DEFAULT_BASE_URL } from '../client.js';

export const OAUTH_SCOPE = 'lex';
export const DEFAULT_ISSUER = 'https://lex-api.com';
export const DEFAULT_RESOURCE = 'https://mcp.lex-api.com/v1';
export const DEFAULT_CLIENT_ID = 'lexapi-mcp-server';
/** Shortest accepted client secret. */
export const MIN_SECRET_LENGTH = 32;

export interface OAuthConfig {
  /** `iss` of every token; the AS endpoints hang off it. */
  issuer: string;
  /** This server's RFC 8707 resource — byte-identical to the PRM `resource` and the MCP token `aud`. */
  resource: string;
  clientId: string;
  clientSecret: string;
  /** Audience of the exchanged API token (LexAPI: `${issuer}/api/v1`). */
  apiAudience: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Path the resource lives on (`/v1`) — the MCP endpoint and the PRM path suffix. */
  resourcePath: string;
  /** `https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1`. */
  resourceMetadataUrl: string;
  /**
   * LexAPI's REST base for OAuth requests: LEXAPI_BASE_URL (else the
   * default), resolved exactly as on the API-key path; same origin as the
   * issuer, so exchanged API tokens can only ever go to LexAPI.
   */
  apiBase: string;
  /** Reverse proxies in front of this server (LEXAPI_MCP_TRUST_PROXY_HOPS) — for the per-IP limit. */
  trustProxyHops: number;
  /** New token exchanges per user per minute (LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN, default 20). */
  exchangesPerUserPerMin: number;
}

/** Default per-user cap on new token exchanges a minute; one per connection every ~4.5 min is normal. */
export const DEFAULT_EXCHANGES_PER_USER_PER_MIN = 20;

/** Variables that only mean something with OAuth on. */
const OAUTH_ONLY_VARS = ['LEXAPI_OAUTH_ISSUER', 'LEXAPI_OAUTH_RESOURCE', 'LEXAPI_OAUTH_CLIENT_ID', 'LEXAPI_API_BASE'] as const;

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** An absolute https URL (http only on loopback, for local tests), no query / fragment / credentials. */
function parseUrl(name: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthConfigError(`${name} is not a URL`);
  }
  if (u.username || u.password) throw new OAuthConfigError(`${name} must not contain credentials`);
  if (u.search || u.hash || raw.includes('#') || raw.includes('?')) throw new OAuthConfigError(`${name} must not have a query or fragment`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new OAuthConfigError(`${name} must be an https URL`);
  }
  return u;
}

/** Trailing slashes dropped — LexAPI canonicalises issuer / resource the same way. */
function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * The OAuth configuration from env, or null when OAuth is off (no client
 * secret). Throws OAuthConfigError when the secret is set but a value is
 * unusable — the hosted server must not start half-configured.
 */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const secret = (env.LEXAPI_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!secret) {
    const set = OAUTH_ONLY_VARS.filter((name) => (env[name] ?? '').trim());
    if (set.length) {
      throw new OAuthConfigError(`${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set but LEXAPI_OAUTH_CLIENT_SECRET is not: set the secret to turn sign-in with LexAPI on, or remove ${set.length === 1 ? 'it' : 'them'} to run with API keys only`);
    }
    return null;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new OAuthConfigError(`LEXAPI_OAUTH_CLIENT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const issuerRaw = trimSlash((env.LEXAPI_OAUTH_ISSUER ?? '').trim() || DEFAULT_ISSUER);
  const issuerUrl = parseUrl('LEXAPI_OAUTH_ISSUER', issuerRaw);
  if (issuerUrl.pathname !== '/' && issuerUrl.pathname !== '') {
    // The issuer is an origin; its endpoints are `${issuer}/oauth/…`.
    throw new OAuthConfigError('LEXAPI_OAUTH_ISSUER must be an origin (no path), e.g. https://lex-api.com');
  }
  const issuer = issuerRaw;

  // The resource is compared byte for byte (PRM `resource`, token `aud`), so
  // it is used exactly as configured — apart from a trailing slash, which
  // the canonical form drops.
  const resource = trimSlash((env.LEXAPI_OAUTH_RESOURCE ?? '').trim() || DEFAULT_RESOURCE);
  const resourceUrl = parseUrl('LEXAPI_OAUTH_RESOURCE', resource);
  // `origin` + `pathname` is the canonical form (lowercase scheme + host, no
  // default port, no dot-segments or other path the URL parser rewrites) —
  // the form used in `aud`. Anything else would make the PRM
  // `resource` and the token `aud` disagree.
  if (resource !== `${resourceUrl.origin}${resourceUrl.pathname}`) {
    throw new OAuthConfigError(`LEXAPI_OAUTH_RESOURCE must be canonical (lowercase scheme and host, no default port, no dot-segments): ${resourceUrl.origin}${resourceUrl.pathname}`);
  }
  const resourcePath = resourceUrl.pathname === '/' ? '' : resourceUrl.pathname;
  if (!resourcePath) throw new OAuthConfigError('LEXAPI_OAUTH_RESOURCE must include the MCP path, e.g. https://mcp.lex-api.com/v1');

  const clientId = (env.LEXAPI_OAUTH_CLIENT_ID ?? '').trim() || DEFAULT_CLIENT_ID;
  if (!/^[\x21-\x7e]+$/.test(clientId)) throw new OAuthConfigError('LEXAPI_OAUTH_CLIENT_ID must be printable ASCII without spaces');
  if (!/^[\x20-\x7e]+$/.test(secret)) throw new OAuthConfigError('LEXAPI_OAUTH_CLIENT_SECRET must be printable ASCII');

  // The API base: what the API-key path uses (LEXAPI_BASE_URL as 0.3.0 read
  // it, else the default). LEXAPI_API_BASE, an older alias, may only repeat
  // it — never redirect OAuth traffic alone.
  const baseRaw = env.LEXAPI_BASE_URL ? env.LEXAPI_BASE_URL : DEFAULT_BASE_URL;
  const apiBase = trimSlash(baseRaw.trim());
  const alias = (env.LEXAPI_API_BASE ?? '').trim();
  if (alias && trimSlash(alias) !== apiBase) {
    throw new OAuthConfigError('LEXAPI_API_BASE differs from LEXAPI_BASE_URL (or its default): LEXAPI_BASE_URL is the variable; remove LEXAPI_API_BASE');
  }
  const apiUrl = parseUrl('LEXAPI_BASE_URL', apiBase);
  if (apiUrl.origin !== issuerUrl.origin) {
    throw new OAuthConfigError(`LEXAPI_BASE_URL must be on the issuer's origin (${issuerUrl.origin}) when OAuth is on: exchanged API tokens are sent there`);
  }

  const hopsRaw = (env.LEXAPI_MCP_TRUST_PROXY_HOPS ?? '').trim();
  const trustProxyHops = hopsRaw ? Number(hopsRaw) : 0;
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) {
    throw new OAuthConfigError('LEXAPI_MCP_TRUST_PROXY_HOPS must be a whole number from 0 to 10');
  }

  const perUserRaw = (env.LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN ?? '').trim();
  const exchangesPerUserPerMin = perUserRaw ? Number(perUserRaw) : DEFAULT_EXCHANGES_PER_USER_PER_MIN;
  if (!Number.isInteger(exchangesPerUserPerMin) || exchangesPerUserPerMin < 1 || exchangesPerUserPerMin > 1000) {
    throw new OAuthConfigError('LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN must be a whole number from 1 to 1000');
  }

  return {
    issuer,
    resource,
    clientId,
    clientSecret: secret,
    apiAudience: `${issuer}/api/v1`,
    tokenEndpoint: `${issuer}/oauth/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    resourcePath,
    resourceMetadataUrl: `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourcePath}`,
    apiBase,
    trustProxyHops,
    exchangesPerUserPerMin,
  };
}

/** RFC 9728 Protected Resource Metadata. */
export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'LexAPI MCP server',
    resource_documentation: 'https://lex-api.com/docs#mcp-oauth',
  };
}

/** A quoted-string-safe value for a WWW-Authenticate parameter. */
export function authParam(value: string): string {
  return value.replace(/[\\"\r\n]/g, ' ').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
}

/** The RFC 6750 / MCP authorization challenge; `error` is set when a Bearer token was presented and refused. */
export function bearerChallenge(cfg: OAuthConfig, error?: { code: 'invalid_token'; description: string }): string {
  const base = `Bearer realm="lexapi", resource_metadata="${cfg.resourceMetadataUrl}", scope="${OAUTH_SCOPE}"`;
  return error ? `${base}, error="${error.code}", error_description="${authParam(error.description)}"` : base;
}
