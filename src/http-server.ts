import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { LexAPIClient, LexAPIError } from './client.js';
import { tools, toolsByName } from './tools.js';

const PACKAGE_NAME = 'lexapi-mcp';
const PACKAGE_VERSION = '0.1.3';
const MCP_PATH = '/v1';

function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // 1 MB request-body cap — MCP JSON-RPC messages are tiny; anything larger is abuse.
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
      throw new Error('request body too large');
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  return JSON.parse(text);
}

function buildMcpServer(apiKey: string): Server {
  const baseUrl = process.env.LEXAPI_BASE_URL;
  const client = new LexAPIClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });

  const server = new Server(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = toolsByName[name];

    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }

    try {
      const result = await tool.handler(args as Record<string, unknown>, client);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof LexAPIError) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `LexAPI error (${err.status} ${err.slug}): ${err.message}`,
            },
          ],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool execution failed: ${message}` }],
      };
    }
  });

  return server;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, private',
  });
  res.end(JSON.stringify(body));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = extractBearer(req);
  if (!apiKey) {
    writeJson(res, 401, {
      error: {
        code: 'unauthorized',
        message:
          'Missing or invalid Authorization header. Send: Authorization: Bearer <your LexAPI key>. Get a key at https://lex-api.com/dashboard.',
      },
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 400, { error: { code: 'bad_request', message } });
    return;
  }

  // Defense-in-depth headers — Cloudflare + intermediate proxies should not
  // buffer streamed responses, and per-user MCP responses must never be cached.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-store, private');

  const mcpServer = buildMcpServer(apiKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createHttpServer(): HttpServer {
  return createServer(async (req, res) => {
    try {
      // CORS preflight — MCP clients called from browsers need this.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, {
          status: 'ok',
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          tools: tools.length,
        });
        return;
      }

      if (req.url === MCP_PATH || req.url === MCP_PATH + '/') {
        await handleMcp(req, res);
        return;
      }

      writeJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        writeJson(res, 500, { error: { code: 'internal_error', message } });
      } else {
        res.end();
      }
    }
  });
}
