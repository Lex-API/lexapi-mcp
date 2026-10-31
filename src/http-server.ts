import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { isWellFormedKey, LexAPIClient } from './client.js';
import { classifyCredential, deriveClientAddress, type Credential } from './credentials.js';
import { UpstreamAuthError } from './errors.js';
import { bearerChallenge, OAuthConfigError, oauthConfigFromEnv, protectedResourceMetadata, type OAuthConfig } from './oauth/config.js';
import { EXCHANGE_DEADLINE_MS, TokenExchanger } from './oauth/exchange.js';
import { InvalidTokenError, JwksCache, JwksUnavailableError, verifyAccessToken, type AccessTokenClaims } from './oauth/jwt.js';
import { redact } from './oauth/redact.js';
import { OAuthUpstreamAuth, ResponseGate } from './oauth/upstream.js';
import { clientFromEnv, createLexServer, PACKAGE_NAME, PROGRESS_INTERVAL_MS, readOnlyFromEnv } from './server.js';
import { selectTools } from './tools.js';
import { PACKAGE_VERSION } from './version.js';

const MCP_PATH = '/v1';
const MAX_BODY_BYTES = 1_000_000;
/**
 * An oversized body is still read (and discarded) up to this much / this
 * long, so the client finishes uploading and actually receives the 413 —
 * closing the socket mid-upload makes clients report EPIPE / ECONNRESET.
 */
const DRAIN_MAX_BYTES = 16_000_000;
const DRAIN_MAX_MS = 5000;
/**
 * SSE keep-alive of the OAuth transport, pinned (the SDK default could
 * change). Together with the first progress frame (PROGRESS_INTERVAL_MS) it
 * commits the 200; a token exchange is bounded below both
 * (EXCHANGE_DEADLINE_MS), so its refusal is still answered as an HTTP status.
 */
export const SSE_KEEP_ALIVE_MS = 15_000;
if (EXCHANGE_DEADLINE_MS >= Math.min(SSE_KEEP_ALIVE_MS, PROGRESS_INTERVAL_MS)) {
  throw new Error('EXCHANGE_DEADLINE_MS must stay below the first frame that commits a response');
}

export { classifyCredential, extractApiKey, type Credential } from './credentials.js';

/**
 * Origin validation (MCP Streamable HTTP: servers MUST validate Origin, a
 * DNS-rebinding defence). Requests without an Origin header — every
 * non-browser MCP client — are allowed. A browser request is allowed only
 * when its Origin is listed in LEXAPI_MCP_ALLOWED_ORIGINS (comma-separated;
 * "*" allows any). Auth is a bearer key with no ambient credentials, so this
 * is defence in depth, not the access control.
 */
export function originAllowed(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true;
  const list = (env.LEXAPI_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(origin);
}

class BodyTooLargeError extends Error {
  constructor(public readonly drained: boolean) {
    super('request body too large');
  }
}

/** Discard the rest of an oversized body; resolves true if it ended within the caps. */
function drain(req: IncomingMessage, alreadyRead: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (req.readableEnded) return resolve(true);
    let seen = alreadyRead;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onEnd);
      resolve(ok);
    };
    const onData = (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > DRAIN_MAX_BYTES) done(false);
    };
    const onEnd = () => done(true);
    const timer = setTimeout(() => done(false), DRAIN_MAX_MS);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onEnd);
    req.resume();
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(await drain(req, 0));
  }
  // Event listeners, not `for await`: leaving a for-await loop early destroys
  // the stream, and the remaining body must stay readable for drain().
  const text = await new Promise<string | BodyTooLargeError>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        req.pause();
        drain(req, size).then((ok) => resolve(new BodyTooLargeError(ok)));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
  if (text instanceof BodyTooLargeError) throw text;
  if (!text) return undefined;
  return JSON.parse(text);
}

function writeJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, private',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, extra: Record<string, string> = {}) {
  writeJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);
}

/** The OAuth half of the hosted server: config + JWKS cache + token exchanger (shared by all requests). */
export interface OAuthRuntime {
  cfg: OAuthConfig;
  jwks: JwksCache;
  exchanger: TokenExchanger;
}

export function createOAuthRuntime(cfg: OAuthConfig, fetchImpl?: typeof fetch): OAuthRuntime {
  return {
    cfg,
    jwks: new JwksCache({ url: cfg.jwksUri, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    exchanger: new TokenExchanger({
      tokenEndpoint: cfg.tokenEndpoint,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      apiAudience: cfg.apiAudience,
      limits: { exchangesPerSubPerMin: cfg.exchangesPerUserPerMin },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
  };
}

interface Ctx {
  oauth: OAuthRuntime | null;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  clientAddress: ClientAddressMonitor;
}

/** `oauthAlerts.proxyHopsMismatch` stays set this long after the last mismatched request, then clears by itself. */
export const PROXY_MISMATCH_ALERT_MS = 10 * 60_000;

/**
 * Derives each request's client address and makes a wrong
 * LEXAPI_MCP_TRUST_PROXY_HOPS visible: an X-Forwarded-For with fewer
 * entries than the configured hops is counted and logged — once, then at
 * most every 10 minutes — instead of silently falling back to the proxy's
 * address. The /health alert reflects the last PROXY_MISMATCH_ALERT_MS only,
 * so a fixed hop count clears it without a restart; the operator count
 * (`shortXffRequests`) is cumulative.
 */
class ClientAddressMonitor {
  shortXff = 0;
  private lastWarnAt = -Infinity;
  private lastShortAt = -Infinity;
  constructor(readonly hops: number) {}

  /** A mismatched request within the last PROXY_MISMATCH_ALERT_MS. */
  get recentMismatch(): boolean {
    return Date.now() - this.lastShortAt < PROXY_MISMATCH_ALERT_MS;
  }

  derive(req: IncomingMessage): ReturnType<typeof deriveClientAddress> {
    const a = deriveClientAddress(req, this.hops);
    if (a.short) {
      this.shortXff += 1;
      const now = Date.now();
      this.lastShortAt = now;
      if (now - this.lastWarnAt >= 10 * 60_000) {
        this.lastWarnAt = now;
        console.error(`[${PACKAGE_NAME}] WARNING: X-Forwarded-For has ${a.xffEntries} entr${a.xffEntries === 1 ? 'y' : 'ies'} but LEXAPI_MCP_TRUST_PROXY_HOPS=${this.hops}: using the socket address (a proxy) for per-IP limits. Fix the hop count (${this.shortXff} such request(s) so far; repeats are reported at most every 10 min)`);
      }
    }
    return a;
  }

  /** The startup description of how client addresses are derived. */
  static describe(hops: number): string {
    return hops > 0 ? `X-Forwarded-For, entry ${hops} from the right (LEXAPI_MCP_TRUST_PROXY_HOPS=${hops})` : 'the socket peer (LEXAPI_MCP_TRUST_PROXY_HOPS=0)';
  }
}

/** LEXAPI_MCP_HEALTH_TOKEN: when set, `/health` with `Authorization: Bearer <token>` adds the operator details. */
function isOperator(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const MIN_HEALTH_TOKEN_LENGTH = 32;

function methodNotAllowed(res: ServerResponse): void {
  jsonRpcError(res, 405, -32000, 'Method not allowed: this server is stateless; send JSON-RPC requests with POST.', { Allow: 'POST, OPTIONS' });
}

/** 0.3.0's answer to a keyless request — still the answer when OAuth is off. */
function missingKey(res: ServerResponse): void {
  writeJson(res, 401, {
    error: {
      code: 'unauthorized',
      message:
        'Missing API key. Send "Authorization: Bearer <your LexAPI key>" (or "x-api-key: <key>"). Get a key at https://lex-api.com/dashboard?ref=mcp-hosted.',
    },
  }, { 'WWW-Authenticate': 'Bearer realm="lexapi"' });
}

function malformedKey(res: ServerResponse): void {
  // Never echo the value.
  writeJson(res, 401, {
    error: { code: 'malformed_api_key', message: 'Malformed API key: it contains whitespace or control characters. Send the key exactly as shown in the dashboard, on one line.' },
  }, { 'WWW-Authenticate': 'Bearer realm="lexapi", error="invalid_token"' });
}

/** A credential that must not be used (too long, or a token where an API key belongs) — never forwarded. */
function rejectedCredential(res: ServerResponse, cred: Extract<Credential, { kind: 'rejected' }>, cfg: OAuthConfig | null): void {
  if (cred.header === 'authorization' && cfg) {
    // With OAuth on a Bearer value is a token: refused like any bad token.
    invalidTokenChallenge(res, cfg, 'malformed token');
    return;
  }
  const message = cred.reason === 'too_long'
    ? 'Credential too long: a LexAPI API key is a single short value (lex_…).'
    : cred.header === 'x-api-key'
      ? 'x-api-key must carry a LexAPI API key (lex_…). An OAuth access token goes in "Authorization: Bearer <token>".'
      : 'Not a LexAPI API key. Send "Authorization: Bearer <your LexAPI key>" with the key exactly as shown in the dashboard (lex_…).';
  writeJson(res, 401, { error: { code: 'malformed_api_key', message } }, {
    'WWW-Authenticate': cfg
      ? bearerChallenge(cfg, { code: 'invalid_token', description: cred.header === 'x-api-key' ? 'x-api-key is not a LexAPI API key' : 'malformed credential' })
      : 'Bearer realm="lexapi", error="invalid_token"',
  });
}

/** No usable credential at all. */
function oauthChallenge(res: ServerResponse, cfg: OAuthConfig): void {
  writeJson(res, 401, { error: 'unauthorized', error_description: 'Sign in with LexAPI or send an API key' }, {
    'WWW-Authenticate': bearerChallenge(cfg),
  });
}

/** A Bearer token was presented and refused. */
function invalidTokenChallenge(res: ServerResponse, cfg: OAuthConfig, reason: string): void {
  writeJson(res, 401, { error: 'invalid_token', error_description: reason }, {
    'WWW-Authenticate': bearerChallenge(cfg, { code: 'invalid_token', description: reason }),
  });
}

/** The parsed JSON-RPC body, or undefined after an error response was written. */
async function readBodyOrRespond(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> {
  try {
    return { body: await readJsonBody(req) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // The body was drained (up to the caps), so the client receives this
      // 413. Close the connection anyway: if the drain hit a cap, the rest of
      // the body is still on the socket and must not be read as a request.
      res.on('finish', () => { if (!err.drained) req.destroy(); });
      jsonRpcError(res, 413, -32600, `Request body too large (max ${MAX_BODY_BYTES} bytes)`, { Connection: 'close' });
    }
    else jsonRpcError(res, 400, -32700, 'Parse error: body is not valid JSON');
    return undefined;
  }
}

/** The 0.3.0 request path: an API key, forwarded to LexAPI as x-api-key. */
async function serveWithApiKey(req: IncomingMessage, res: ServerResponse, apiKey: string, ctx: Ctx): Promise<void> {
  if (!isWellFormedKey(apiKey)) {
    malformedKey(res);
    return;
  }
  const parsed = await readBodyOrRespond(req, res);
  if (!parsed) return;

  // Per-user responses must never be cached or buffered by proxies.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-store, private');

  const server = createLexServer(clientFromEnv(apiKey, ctx.env), { readOnly: readOnlyFromEnv(ctx.env) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed.body);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { oauth } = ctx;
  if (!oauth) {
    // OAuth off: exactly the 0.3.0 behaviour.
    // Stateless server: there is no session to open a GET event stream on or to
    // DELETE, so only POST is meaningful (MCP Streamable HTTP, stateless mode).
    if (req.method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    const cred = classifyCredential(req, false);
    if (cred.kind === 'rejected') {
      rejectedCredential(res, cred, null);
      return;
    }
    if (cred.kind !== 'apiKey') {
      missingKey(res);
      return;
    }
    await serveWithApiKey(req, res, cred.key, ctx);
    return;
  }

  // OAuth on. Every method on the MCP endpoint without a usable credential
  // gets the authorization challenge — that is how MCP clients discover the AS.
  const cred = classifyCredential(req, true);
  if (cred.kind === 'none') {
    oauthChallenge(res, oauth.cfg);
    return;
  }
  if (cred.kind === 'rejected') {
    rejectedCredential(res, cred, oauth.cfg);
    return;
  }
  if (cred.kind === 'apiKey') {
    if (req.method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await serveWithApiKey(req, res, cred.key, ctx);
    return;
  }

  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(cred.token, { issuer: oauth.cfg.issuer, audience: oauth.cfg.resource, jwks: oauth.jwks });
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      invalidTokenChallenge(res, oauth.cfg, err.message);
      return;
    }
    if (err instanceof JwksUnavailableError) {
      // Not the token's fault (issuer unreachable, or a JWKS without a usable
      // key): no challenge, so clients don't re-authorize. Logged by JwksCache.
      jsonRpcError(res, 503, -32603, 'Sign-in with LexAPI is temporarily unavailable; retry shortly.', { 'Retry-After': '5' });
      return;
    }
    throw err;
  }
  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }
  const parsed = await readBodyOrRespond(req, res);
  if (!parsed) return;
  await serveWithOAuth(req, res, parsed.body, cred.token, claims, oauth, ctx);
}

/**
 * The OAuth request path. The MCP transport runs on Web-standard
 * Request/Response so the response can be held until its first frame: a
 * tool call that finds the connection revoked (API 401 → re-exchange 400)
 * or the exchange misconfigured records it on the gate first, and the
 * client gets the matching HTTP status instead of a 200. Frames that go
 * out before (progress every 10 s, SSE keep-alive every 15 s) commit the
 * 200; later failures stay tool errors.
 */
async function serveWithOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  token: string,
  claims: AccessTokenClaims,
  oauth: OAuthRuntime,
  ctx: Ctx,
): Promise<void> {
  const gate = new ResponseGate();
  const client = new LexAPIClient({
    auth: new OAuthUpstreamAuth(token, claims.exp, oauth.exchanger, gate, { ip: ctx.clientAddress.derive(req).ip, sub: claims.sub }),
    baseUrl: oauth.cfg.apiBase,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  const server = createLexServer(client, { readOnly: readOnlyFromEnv(ctx.env) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, keepAliveMs: SSE_KEEP_ALIVE_MS });
  const streams: { reader?: ReadableStreamDefaultReader<Uint8Array> } = {};
  res.on('close', () => {
    streams.reader?.cancel().catch(() => {});
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  const webRes = await transport.handleRequest(toWebRequest(req), { parsedBody: body });

  const reader = webRes.body?.getReader();
  streams.reader = reader;
  let first: ReadableStreamReadResult<Uint8Array> = { done: true, value: undefined };
  if (reader) {
    try {
      first = await reader.read();
    } catch {
      first = { done: true, value: undefined };
    }
  }
  if (res.destroyed || res.writableEnded) return;

  const failure = gate.failure;
  if (failure) {
    reader?.cancel().catch(() => {});
    writeUpstreamAuthFailure(res, failure, oauth.cfg);
    return;
  }

  const headers: Record<string, string> = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  // Per-user responses must never be cached or buffered by proxies.
  headers['cache-control'] = 'no-store, private, no-transform';
  headers['x-accel-buffering'] = 'no';
  res.writeHead(webRes.status, headers);
  if (first.done || !reader) {
    res.end();
    return;
  }
  res.write(first.value);
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done || res.destroyed) break;
    if (!res.write(chunk.value)) await drained(res);
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.removeListener('drain', done);
      res.removeListener('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** Credentials and hop-by-hop headers never reach the MCP layer. */
const DROPPED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);

/** The request the MCP layer sees: no credential headers (exported for tests). */
export function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return new Request(new URL(req.url ?? '/', 'http://localhost'), { method: req.method ?? 'POST', headers });
}

function writeUpstreamAuthFailure(res: ServerResponse, err: UpstreamAuthError, cfg: OAuthConfig): void {
  if (err.httpStatus === 401) {
    invalidTokenChallenge(res, cfg, err.description);
    return;
  }
  const message = err.httpStatus === 500
    ? 'Sign-in with LexAPI is misconfigured on this server; the operator has been alerted.'
    : 'Sign-in with LexAPI is temporarily unavailable; retry shortly.';
  jsonRpcError(res, err.httpStatus, -32603, message, err.httpStatus === 503 ? { 'Retry-After': String(err.retryAfterSeconds ?? 30) } : {});
}

/** RFC 9728 metadata: public, cacheable, readable from any browser origin. */
function serveResourceMetadata(req: IncomingMessage, res: ServerResponse, cfg: OAuthConfig): void {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Max-Age': '86400' });
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET.' } }, { ...cors, Allow: 'GET, HEAD, OPTIONS' });
    return;
  }
  const body = JSON.stringify(protectedResourceMetadata(cfg));
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** True when something needs an operator — configuration, not traffic. */
function oauthAlerts(oauth: OAuthRuntime, clientAddress: ClientAddressMonitor) {
  const ex = oauth.exchanger.stats();
  const jwks = oauth.jwks.stats();
  return {
    configErrors: ex.configErrors > 0,
    clientAuthErrors: ex.clientAuthErrors > 0,
    jwksUnavailable: jwks.keys === 0 ? jwks.failures > 0 : jwks.consecutiveFailures > 0,
    proxyHopsMismatch: clientAddress.recentMismatch,
  };
}

/**
 * For verifying LEXAPI_MCP_TRUST_PROXY_HOPS after a deploy:
 * how many X-Forwarded-For entries THIS request arrived with and whether the
 * address came from it. Never the address itself.
 */
function clientAddressReport(req: IncomingMessage, monitor: ClientAddressMonitor) {
  const a = deriveClientAddress(req, monitor.hops);
  return {
    mode: monitor.hops > 0 ? 'x-forwarded-for' : 'socket',
    trustProxyHops: monitor.hops,
    xffEntriesThisRequest: a.xffEntries,
    derivedFrom: monitor.hops > 0 && !a.short ? 'x-forwarded-for' : 'socket',
    shortXffRequests: monitor.shortXff,
  };
}

export interface HttpServerOptions {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * OAuth configuration: undefined → from env (oauthConfigFromEnv, throws
   * OAuthConfigError on a half-configured env), null → OAuth off.
   */
  oauth?: OAuthConfig | null;
  /** Injected for tests: every outbound request (JWKS, token exchange, LexAPI on OAuth requests). */
  fetch?: typeof fetch;
}

export function createHttpServer(opts: HttpServerOptions = {}): HttpServer & { oauth: OAuthRuntime | null; clientAddressMode: string } {
  const env = opts.env ?? process.env;
  const cfg = opts.oauth === undefined ? oauthConfigFromEnv(env) : opts.oauth;
  const oauth = cfg ? createOAuthRuntime(cfg, opts.fetch) : null;
  const clientAddress = new ClientAddressMonitor(cfg?.trustProxyHops ?? 0);
  const ctx: Ctx = { oauth, env, clientAddress, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const healthToken = (env.LEXAPI_MCP_HEALTH_TOKEN ?? '').trim() || undefined;
  if (healthToken && healthToken.length < MIN_HEALTH_TOKEN_LENGTH) {
    throw new OAuthConfigError(`LEXAPI_MCP_HEALTH_TOKEN must be at least ${MIN_HEALTH_TOKEN_LENGTH} characters`);
  }
  if (healthToken && !oauth) {
    // Every operator field is about OAuth (exchange / JWKS counters, the
    // client address for the per-IP limits): with OAuth off there is
    // nothing to add, so the token does nothing. Say so rather than look on.
    console.error(`[${PACKAGE_NAME}] WARNING: LEXAPI_MCP_HEALTH_TOKEN is set but OAuth is off (LEXAPI_OAUTH_CLIENT_SECRET not set): the /health operator view only adds OAuth fields, so it is the same as the public view. Unset it, or turn OAuth on.`);
  }
  const metadataPaths = cfg
    ? new Set([`/.well-known/oauth-protected-resource${cfg.resourcePath}`, '/.well-known/oauth-protected-resource'])
    : new Set<string>();
  const mcpPath = cfg ? cfg.resourcePath : MCP_PATH;

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];

      // Protected Resource Metadata is public and must be readable by
      // browser-based clients from any origin: served before the Origin check.
      if (cfg && metadataPaths.has(path)) {
        serveResourceMetadata(req, res, cfg);
        return;
      }

      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (!originAllowed(origin, env)) {
        writeJson(res, 403, { error: { code: 'origin_not_allowed', message: `Origin ${origin} is not allowed. Browser clients must be listed in LEXAPI_MCP_ALLOWED_ORIGINS.` } });
        return;
      }
      // CORS for allowed browser origins (echoed, never a wildcard with a real origin).
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate');

      if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        writeJson(res, 200, {
          status: 'ok',
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          tools: selectTools({ readOnly: readOnlyFromEnv(env) }).length,
          oauth: Boolean(oauth),
          // Public: coarse booleans only — enough for an uptime check
          // to alert on a misconfiguration, nothing about traffic volume,
          // limits or configuration values.
          ...(oauth ? { oauthAlerts: oauthAlerts(oauth, clientAddress) } : {}),
          // Operator view (LEXAPI_MCP_HEALTH_TOKEN): counters and the
          // client-address derivation — never addresses, tokens or config values.
          ...(oauth && isOperator(req, healthToken) ? {
            oauthStats: { exchange: oauth.exchanger.stats(), jwks: oauth.jwks.stats() },
            clientAddress: clientAddressReport(req, clientAddress),
          } : {}),
        });
        return;
      }

      if (path === mcpPath || path === `${mcpPath}/`) {
        await handleMcp(req, res, ctx);
        return;
      }

      writeJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${path}. The MCP endpoint is POST ${mcpPath}.` } });
    } catch (err) {
      // Log server-side only, scrubbed; the client gets a generic message (no internals).
      console.error(`[${PACKAGE_NAME}] request failed:`, redact(err instanceof Error ? err.message : String(err), [cfg?.clientSecret]));
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    }
  });
  return Object.assign(server, { oauth, clientAddressMode: ClientAddressMonitor.describe(cfg?.trustProxyHops ?? 0) });
}
