import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { isWellFormedKey } from './client.js';
import { clientFromEnv, createLexServer, PACKAGE_NAME, readOnlyFromEnv } from './server.js';
import { selectTools } from './tools.js';
import { PACKAGE_VERSION } from './version.js';

const MCP_PATH = '/v1';
const MAX_BODY_BYTES = 1_000_000;

/**
 * The caller's LexAPI key: `Authorization: Bearer <key>` (what server.json
 * advertises), or `x-api-key: <key>` (the REST API's own header).
 */
export function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
    if (m) return m[1];
  }
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

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

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // MCP JSON-RPC messages are small; anything larger is abuse.
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
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

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless server: there is no session to open a GET event stream on or to
  // DELETE, so only POST is meaningful (MCP Streamable HTTP, stateless mode).
  if (req.method !== 'POST') {
    jsonRpcError(res, 405, -32000, 'Method not allowed: this server is stateless; send JSON-RPC requests with POST.', { Allow: 'POST, OPTIONS' });
    return;
  }

  const apiKey = extractApiKey(req);
  if (!apiKey || !isWellFormedKey(apiKey)) {
    writeJson(res, 401, {
      error: {
        code: 'unauthorized',
        message:
          'Missing API key. Send "Authorization: Bearer <your LexAPI key>" (or "x-api-key: <key>"). Get a key at https://lex-api.com/dashboard?ref=mcp-hosted.',
      },
    }, { 'WWW-Authenticate': 'Bearer realm="lexapi"' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // The rest of the body is still on the socket: close it, or the next
      // keep-alive request on this connection would read garbage.
      res.on('finish', () => req.destroy());
      jsonRpcError(res, 413, -32600, 'Request body too large', { Connection: 'close' });
    }
    else jsonRpcError(res, 400, -32700, 'Parse error: body is not valid JSON');
    return;
  }

  // Per-user responses must never be cached or buffered by proxies.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-store, private');

  const server = createLexServer(clientFromEnv(apiKey), { readOnly: readOnlyFromEnv() });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createHttpServer(): HttpServer {
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];

      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (!originAllowed(origin)) {
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
          tools: selectTools({ readOnly: readOnlyFromEnv() }).length,
        });
        return;
      }

      if (path === MCP_PATH || path === `${MCP_PATH}/`) {
        await handleMcp(req, res);
        return;
      }

      writeJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${path}. The MCP endpoint is POST ${MCP_PATH}.` } });
    } catch (err) {
      // Log server-side only; the client gets a generic message (no internals).
      console.error(`[${PACKAGE_NAME}] request failed:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    }
  });
}
