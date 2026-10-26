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
import { createHttpServer, originAllowed } from '../src/http-server.js';
import { createLexServer, runTool, SERVER_INSTRUCTIONS } from '../src/server.js';
import { selectTools, tools } from '../src/tools.js';
import { request as httpRequest, Agent } from 'node:http';
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

    // N10: tools/list stays compact (v0.3.0 first cut was ~39.6k characters).
    const listJson = JSON.stringify(listed);
    expect(listJson.length).toBeLessThan(36_000);
    expect(listJson).not.toContain('"ga","hr","hu"'); // the 24-language enum is not repeated
    // N11: instructions cover reading a known article on a past date.
    expect(client.getInstructions()).toMatch(/consolidated version for that date/);

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

describe('tool call plumbing (S3)', () => {
  it('sends progress heartbeats when the request has a progress token, and uses the long timeout', async () => {
    const sent: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let seenTimeout = 0;
    const fake = {
      forCall: ({ timeoutMs }: { timeoutMs?: number }) => { seenTimeout = timeoutMs ?? 0; return fake; },
    } as unknown as LexAPIClient;
    const tool = { ...tools[0], handler: async () => { await gate; return { ok: true }; } };
    const p = runTool(tool, {}, fake, {
      _meta: { progressToken: 'tok' },
      sendNotification: async (n) => { sent.push(n); if (sent.length === 2) release(); },
    }, { progressIntervalMs: 5 });
    const res = await p;
    expect(res.isError).toBeFalsy();
    expect(sent[0]).toMatchObject({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } });
    expect(seenTimeout).toBe(120_000);
  });

  it('without a progress token the timeout stays under the client default', async () => {
    let seenTimeout = 0;
    const fake = { forCall: ({ timeoutMs }: { timeoutMs?: number }) => { seenTimeout = timeoutMs ?? 0; return fake; } } as unknown as LexAPIClient;
    await runTool({ ...tools[0], handler: async () => ({}) }, {}, fake, {});
    expect(seenTimeout).toBeLessThan(60_000);
  });

  it('client cancellation aborts the upstream fetch (MCP notifications/cancelled)', async () => {
    let aborted = false;
    const hang = createServer((req) => { req.on('close', () => { aborted = true; }); });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}/api/v1`;
    const server = createLexServer(new LexAPIClient({ apiKey: 'lex_good', baseUrl: url }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const ctl = new AbortController();
    const p = client.callTool({ name: 'lex_info', arguments: {} }, undefined, { signal: ctl.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort();
    await p;
    for (let i = 0; i < 40 && !aborted; i++) await new Promise((r) => setTimeout(r, 25));
    expect(aborted).toBe(true);
    await client.close();
    await new Promise<void>((r) => hang.close(() => r()));
  });
});

describe('Origin validation (N2)', () => {
  it('allows no-Origin requests; browser origins only when listed', () => {
    expect(originAllowed(undefined, {})).toBe(true);
    expect(originAllowed('https://evil.example', {})).toBe(false);
    expect(originAllowed('https://app.example', { LEXAPI_MCP_ALLOWED_ORIGINS: 'https://app.example, https://b.example' })).toBe(true);
    expect(originAllowed('https://evil.example', { LEXAPI_MCP_ALLOWED_ORIGINS: 'https://app.example' })).toBe(false);
    expect(originAllowed('https://any.example', { LEXAPI_MCP_ALLOWED_ORIGINS: '*' })).toBe(true);
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

  it('N2: rejects a disallowed browser Origin with 403', async () => {
    const r = await fetch(`${base}/v1`, { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer lex_good', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('S4: a key with control characters is a 401, never echoed', async () => {
    const r = await fetch(`${base}/v1`, { method: 'POST', headers: { 'x-api-key': 'lex_SECRET\u0001x', 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    // fetch itself may refuse a control character; if it went through, it must be a 401 without the key.
    if (r) {
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain('SECRET');
    }
  });

  it('N1: a 413 closes the connection so the next keep-alive request is not corrupted', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const port = Number(new URL(base).port);
    const send = (path: string, method: string, body?: Buffer) => new Promise<{ status: number; conn: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, agent, headers: { authorization: 'Bearer lex_good', 'content-type': 'application/json', ...(body ? { 'content-length': body.length } : {}) } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, conn: res.headers.connection }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    const big = await send('/v1', 'POST', Buffer.alloc(1_500_000, 0x20)).catch((e) => ({ status: -1, conn: String(e.code) }));
    if (big.status !== -1) {
      expect(big.status).toBe(413);
      expect(big.conn).toBe('close');
    }
    const next = await send('/health', 'GET');
    expect(next.status).toBe(200);
    agent.destroy();
  });

  it('health', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok', version: PACKAGE_VERSION, tools: selectTools().length });
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
