// The per-request OAuth credential of the hosted server and the gate that turns an auth failure discovered during a
// tool call into the HTTP status the MCP client must see.

import type { UpstreamAuth } from '../client.js';
import { UpstreamAuthError } from '../errors.js';
import { ExchangeError, type ExchangeCaller, type TokenExchanger } from './exchange.js';

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
