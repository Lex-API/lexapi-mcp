// The per-request OAuth credential of the hosted server and the gate that turns an auth failure discovered during a
// tool call into the HTTP status the MCP client must see.

import type { UpstreamAuth } from '../client.js';
import { UpstreamAuthError } from '../errors.js';
import { ExchangeError, type ExchangeCaller, type TokenExchanger } from './exchange.js';
import { SCOPE_READ, SCOPE_WEBHOOKS, type ToolScope } from './scope.js';

/**
 * One per HTTP request. A tool call that hits an auth failure records it
 * here; the response writer checks it before committing a status, so a
 * revoked connection becomes `401 invalid_token` (what makes MCP clients
 * refresh / re-authorize) instead of a 200 carrying a tool error. Once the
 * status is committed (a progress or keep-alive frame went out first) the
 * failure stays a tool error.
 */
export class ResponseGate {
  private first?: UpstreamAuthError;

  fail(error: UpstreamAuthError): void {
    if (!this.first) this.first = error;
  }

  get failure(): UpstreamAuthError | undefined {
    return this.first;
  }
}

const EXCHANGE_STATUS: Record<ExchangeError['kind'], number> = {
  invalid_token: 401,
  config: 500,
  client_auth: 503,
  unavailable: 503,
  rate_limited: 429,
  upstream: 502,
};

/**
 * The exchange failures that answer the MCP client with an HTTP status while the
 * response is not committed yet (after commit every failure is a tool
 * error). 429 and 502 stay tool errors: a model
 * can act on "wait N s" / "retry later", an HTTP error only aborts the call.
 */
const GATED = new Set<ExchangeError['kind']>(['invalid_token', 'config', 'client_auth', 'unavailable']);

/** `error="invalid_token"` in a WWW-Authenticate challenge (quoted or not). */
function isInvalidTokenChallenge(www: string | null): boolean {
  return !!www && /\berror\s*=\s*"?invalid_token"?/i.test(www);
}

const AUTH_PARAM = /\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]*))\s*(?:,|$)/y;

/**
 * True for a Bearer challenge whose `error` parameter is exactly
 * `insufficient_scope`. The parameters are read in order, so the word
 * inside another parameter's value (an error_description) does not count.
 */
export function isInsufficientScopeChallenge(www: string | null): boolean {
  const m = www ? /^\s*Bearer\s+/i.exec(www) : null;
  if (!www || !m) return false;
  AUTH_PARAM.lastIndex = m[0].length;
  for (let p = AUTH_PARAM.exec(www); p; p = AUTH_PARAM.exec(www)) {
    if (p[1].toLowerCase() === 'error') return (p[2] ?? p[3]) === 'insufficient_scope';
    if (AUTH_PARAM.lastIndex >= www.length) break;
  }
  return false;
}

/** The scope the API requires for a path: its webhook routes need lex:webhooks, every other route lex:read. */
export function routeScope(path: string): ToolScope {
  return path === '/webhooks' || path.startsWith('/webhooks/') ? SCOPE_WEBHOOKS : SCOPE_READ;
}

/**
 * Credential for one MCP request authenticated with an OAuth access token:
 * exchanges it (cached per subject token) and sends the API token as
 * `Authorization: Bearer` — never `x-api-key`, never the inbound token.
 */
export class OAuthUpstreamAuth implements UpstreamAuth {
  private current?: string;
  private reexchanged = false;

  constructor(
    private readonly subjectToken: string,
    private readonly subjectExpS: number,
    private readonly exchanger: TokenExchanger,
    private readonly gate?: ResponseGate,
    /** Client IP / user, for the exchanger's per-IP and per-user limits. */
    private readonly caller: ExchangeCaller = {},
  ) {}

  async headers(ctx: { signal?: AbortSignal }): Promise<Record<string, string>> {
    try {
      this.current = await this.exchanger.getApiToken(this.subjectToken, this.subjectExpS, ctx.signal, this.caller);
    } catch (err) {
      if (err instanceof ExchangeError) {
        const e = new UpstreamAuthError(err.kind, EXCHANGE_STATUS[err.kind], err.description, err.retryAfterSeconds);
        if (GATED.has(err.kind)) this.gate?.fail(e);
        throw e;
      }
      throw err;
    }
    return { authorization: `Bearer ${this.current}` };
  }

  onForbidden(info: { wwwAuthenticate: string | null; path: string }): Error | undefined {
    if (!isInsufficientScopeChallenge(info.wwwAuthenticate)) return undefined;
    // The connection does not include this scope (it can be narrower than
    // the token says): answered as 403 insufficient_scope while the response
    // is not committed, so the client can ask the user for it. The scope is
    // the one the called route requires, not a value read from the header.
    const required = routeScope(info.path);
    const e = new UpstreamAuthError('insufficient_scope', 403, `required scope: ${required}`, undefined, required);
    this.gate?.fail(e);
    return e;
  }

  onUnauthorized(info: { wwwAuthenticate: string | null; body: string }): 'retry' | Error {
    const invalidToken = isInvalidTokenChallenge(info.wwwAuthenticate) || /"error"\s*:\s*"Invalid access token"/.test(info.body);
    if (invalidToken && !this.reexchanged) {
      // The API token expired or the connection was revoked since the
      // exchange: drop it and exchange once more. A revoked grant
      // makes that exchange answer 400 → 401 invalid_token above.
      this.reexchanged = true;
      this.exchanger.invalidate(this.subjectToken, this.current);
      return 'retry';
    }
    // A freshly exchanged token refused again, or a 401 that is not a token
    // verdict: a server-side problem, not something re-authorizing fixes —
    // a tool error (never a 401 to the MCP client) and a log line.
    console.error(`[lexapi-mcp] OAUTH: LexAPI API refused an exchanged token${this.reexchanged ? ' twice' : ''} (${invalidToken ? 'invalid_token' : 'no invalid_token challenge'}) — check the OAuth configuration`);
    return new UpstreamAuthError('api_rejected', 502, 'the LexAPI API did not accept the exchanged token');
  }
}
