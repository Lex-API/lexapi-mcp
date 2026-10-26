// End-to-end over real MCP transports: in-memory (protocol), Streamable HTTP
// (the hosted server) and stdio (the npm bin, spawned from dist/). A local
// HTTP server stands in for LexAPI — no real API calls.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { LexAPIClient } from '../src/client.js';
import { createHttpServer } from '../src/http-server.js';
import { createLexServer, SERVER_INSTRUCTIONS } from '../src/server.js';
import { tools } from '../src/tools.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { fakeDocument, parseText } from './helpers.js';

interface Seen { method: string; path: string; key: string | undefined; ua: string | undefined; body: unknown }
const seen: Seen[] = [];
let api: Server;
let apiUrl: string;

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({
        method: req.method ?? '', path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined,
        ua: req.headers['user-agent'], body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-key'] !== 'lex_good') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Invalid API key' }));
        return;
      }
      if (req.url?.startsWith('/api/v1/documentContent')) {
        res.setHeader('x-source', 'corpus');
        res.end(JSON.stringify({ success: true, document: fakeDocument(2, 40) }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'nope' } }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
});

describe('MCP protocol (in-memory)', () => {
  it('initializes with instructions, server info and every tool', async () => {
    const server = createLexServer(new LexAPIClient({ apiKey: 'lex_good', baseUrl: apiUrl }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getServerVersion()).toMatchObject({ name: 'lexapi-mcp', title: 'LexAPI', version: PACKAGE_VERSION });

    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    const asOf = listed.find((t) => t.name === 'lex_semantic_legislation')!;
    expect(Object.keys(asOf.inputSchema.properties ?? {})).toContain('asOf');
    expect(asOf.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(listed.every((t) => typeof t.title === 'string' && t.title.length > 0)).toBe(true);

    // Invalid arguments are rejected by the SDK before any HTTP call.
    const before = seen.length;
    const bad = await client.callTool({ name: 'lex_get_document', arguments: { celexNumber: '!!' } });
    expect(bad.isError).toBe(true);
    expect(seen.length).toBe(before);

    const ok = await client.callTool({ name: 'lex_get_document', arguments: { celexNumber: '32016r0679' } });
    expect(ok.isError).toBeFalsy();
    const data = parseText(ok as any);
    expect(data.celex).toBe('32016R0679');
    expect(data.source).toBe('corpus');
    expect(seen[seen.length - 1]).toMatchObject({ method: 'POST', path: '/api/v1/documentContent', key: 'lex_good', body: { celexNumber: '32016R0679' } });
    await client.close();
  });
});

describe('Streamable HTTP (hosted server)', () => {
  let http: Server;
  let base: string;

  beforeAll(async () => {
    process.env.LEXAPI_BASE_URL = apiUrl;
    http = createHttpServer();
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.LEXAPI_BASE_URL;
    await new Promise<void>((r) => http.close(() => r()));
  });

  it('health', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok', version: PACKAGE_VERSION, tools: tools.length });
  });

  it('401 without a key, 405 on GET, 404 elsewhere, 400 on bad JSON', async () => {
    const noKey = await fetch(`${base}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await fetch(`${base}/v1`, { headers: { authorization: 'Bearer lex_good' } })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const badJson = await fetch(`${base}/v1`, { method: 'POST', headers: { authorization: 'Bearer lex_good', 'content-type': 'application/json' }, body: '{' });
    expect(badJson.status).toBe(400);
  });

  async function connect(headers: Record<string, string>) {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/v1`), { requestInit: { headers } });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  it('serves tools with the Bearer key forwarded as x-api-key', async () => {
    const client = await connect({ authorization: 'Bearer lex_good' });
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(tools.length);
    const res = await client.callTool({ name: 'lex_get_document', arguments: { celexNumber: '32016R0679', articleId: '1' } });
    expect(parseText(res as any).celex).toBe('32016R0679');
    const last = seen[seen.length - 1];
    expect(last.key).toBe('lex_good');
    expect(last.ua).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
    expect(last.body).toEqual({ celexNumber: '32016R0679', articleId: '1', include: ['metadata', 'articles'] });
    await client.close();
  });

  it('accepts x-api-key too, and maps a bad key to an actionable tool error', async () => {
    const client = await connect({ 'x-api-key': 'lex_wrong' });
    const res = await client.callTool({ name: 'lex_get_metadata', arguments: { celexNumber: '32016R0679' } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/401/);
    expect(text).not.toContain('lex_wrong');
    await client.close();
  });
});

const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe.skipIf(!existsSync(distEntry))('stdio (npm bin, built dist/)', () => {
  it('starts, lists tools and calls one', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: { ...process.env, LEXAPI_API_KEY: 'lex_good', LEXAPI_BASE_URL: apiUrl } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(tools.length);
    const res = await client.callTool({ name: 'lex_get_document', arguments: { celexNumber: '32016R0679' } });
    expect(parseText(res as any).content.articles).toHaveLength(2);
    await client.close();
  });

  it('read-only mode hides the webhook writes', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: { ...process.env, LEXAPI_API_KEY: 'lex_good', LEXAPI_BASE_URL: apiUrl, LEXAPI_MCP_READ_ONLY: 'true' } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name)).not.toContain('lex_delete_webhook');
    await client.close();
  });
});
