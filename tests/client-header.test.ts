// The X-LexAPI-Client header on every request to LexAPI: stdio and hosted,
// with and without a tool, for the workflow tools, under concurrency and
// with a hostile clientInfo. Values are read back with the header grammar
// LexAPI documents (parse() below).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { LexAPIClient } from '../src/client.js';
import { clientHeaderValue } from '../src/clientHeader.js';
import { createHttpServer } from '../src/http-server.js';
import { createLexServer } from '../src/server.js';
import { tools } from '../src/tools.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { mockFetch, parseText, type Call } from './helpers.js';
import { CLIENT_SECRET, startMockAs, type MockAs } from './oauth-mock.js';

// ── The header grammar, as the API reads it ─────────────────────────
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,23}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;

interface Parsed { name: string; version: string; mode: string | null; tool: string | null; app: string | null }

/** The parsed header, or null when the API would ignore the whole value. */
function parse(value: unknown): Parsed | null {
  if (typeof value !== 'string' || !value || value.length > 256) return null;
  if (/[^\x20-\x7e]/.test(value) || value.includes(',')) return null;
  const parts = value.split(';').map((p) => p.trim());
  const slash = parts[0].indexOf('/');
  const name = (slash === -1 ? parts[0] : parts[0].slice(0, slash)).trim().toLowerCase();
  const version = slash === -1 ? '' : parts[0].slice(slash + 1).trim();
  if (!NAME_RE.test(name) || !VERSION_RE.test(version)) return null;
  const out: Parsed = { name, version, mode: null, tool: null, app: null };
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    if (key === 'mode' && out.mode === null && ['hosted', 'stdio'].includes(val.toLowerCase())) out.mode = val.toLowerCase();
    else if (key === 'tool' && out.tool === null && TOOL_RE.test(val)) out.tool = val;
    else if (key === 'app' && out.app === null) {
      const cleaned = val.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64).trim();
      out.app = cleaned.replace(/[^A-Za-z0-9 ._()/+-]/g, '').replace(/\s+/g, ' ').trim() || null;
    }
  }
  return out;
}

/** The header of a request as the API would read it; fails when it is absent, repeated or refused. */
function headerOf(value: string | string[] | undefined): Parsed {
  expect(typeof value, 'one X-LexAPI-Client header').toBe('string');
  const parsed = parse(value);
  expect(parsed, `refused by the API: ${String(value)}`).not.toBeNull();
  // Everything sent is kept by the API as it was sent.
  const p = parsed!;
  const rebuilt = [`${p.name}/${p.version}`, p.mode && `mode=${p.mode}`, p.tool && `tool=${p.tool}`, p.app && `app=${p.app}`].filter(Boolean).join('; ');
  expect(value).toBe(rebuilt);
  return p;
}

const BASE = 'https://api.example.test/api/v1';

// ── A stand-in API that answers every call the tools below make ─────
const edge = (celexNumber: string) => ({
  id: celexNumber, celexNumber, jurisdiction: 'EU', documentKind: 'act', title: `Title of ${celexNumber}`, citationCount: 1,
  citations: [{ citationType: 'amendment', contextSnippet: null, extractedAt: '2026-09-01T00:00:00.000Z', provenance: 'cellar', resolution: null }],
});
function reply(c: Call) {
  const p = c.url.pathname.replace('/api/v1', '');
  if (p === '/resolve') return { body: { success: true, identifierType: 'url', resolvedVia: 'url', verified: false, celex: '32016R0679', urls: {} } };
  if (p === '/documents/metadata') {
    const celex = String((c.body as { celexNumber?: string }).celexNumber);
    return { body: { success: true, metadata: { celexNumber: celex, celex, title: `Title of ${celex}`, dateOfDocumentISO: '2016-04-27', urls: {} } } };
  }
  if (p.startsWith('/citations/cited-by/')) {
    return { body: { success: true, targetDocument: '32016R0679', totalCitations: 2, totalEdges: 2, limit: 100, offset: 0, citedBy: [edge('32018R1725'), edge('32021R0001')] } };
  }
  if (p === '/national/coverage') return { body: { jurisdictions: [{ code: 'AT', name: 'Austria', live: true, semanticSearch: { legislation: true, caseLaw: true } }] } };
  if (p.endsWith('/legislation/semantic') || p.endsWith('/search/semantic')) return { body: { success: true, results: [] } };
  if (p === '/info') return { body: { service: 'mock' } };
  if (p === '/search') return { body: { success: true, results: [], totalResults: 0 } };
  return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'not mocked' } } };
}

async function connect(opts: { mode?: 'hosted' | 'stdio'; clientInfo?: { name: string; version: string }; handler?: Parameters<typeof mockFetch>[0] } = {}) {
  const m = mockFetch(opts.handler ?? reply);
  const api = new LexAPIClient({ apiKey: 'lex_test_secret_key', baseUrl: BASE, fetch: m.fetch, sleep: async () => {}, ...(opts.mode ? { mode: opts.mode } : {}) });
  const server = createLexServer(api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client(opts.clientInfo ?? { name: 'Example Client', version: '1.2.3' });
  await mcp.connect(b);
  return { mcp, calls: m.calls, api };
}

describe('the header value', () => {
  it('names the server and its version; mode, tool and app are added when given', () => {
    expect(clientHeaderValue()).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
    expect(clientHeaderValue({ mode: 'hosted', tool: 'lex_search' })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_search`);
    expect(clientHeaderValue({ mode: 'stdio', tool: 'lex_search', app: { name: 'claude-code', version: '2.1.0' } }))
      .toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; tool=lex_search; app=claude-code/2.1.0`);
    expect(clientHeaderValue({ mode: 'stdio', app: { name: 'Example Client (beta)' } })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; app=Example Client (beta)`);
  });

  it('the app is sent in stdio mode only', () => {
    const app = { name: 'claude-code', version: '2.1.0' };
    expect(clientHeaderValue({ mode: 'hosted', tool: 'lex_search', app })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_search`);
    expect(clientHeaderValue({ tool: 'lex_search', app })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; tool=lex_search`);
  });

  it('a part that is not valid is left out, and the rest is kept', () => {
    for (const tool of ['Lex_Search', 'lex search', 'lex,search', 'lex;search', '', `lex_${'a'.repeat(64)}`, '1lex']) {
      expect(clientHeaderValue({ mode: 'stdio', tool }), tool).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio`);
    }
    expect(clientHeaderValue({ mode: 'other' as never, tool: 'lex_info' })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; tool=lex_info`);
    expect(clientHeaderValue({ mode: 'stdio', tool: 'lex_info' }, '1.0.0-rc.1+build.5')).toBe('lexapi-mcp/1.0.0-rc.1+build.5; mode=stdio; tool=lex_info');
    // A version the header cannot carry: no header, rather than one the API refuses.
    expect(clientHeaderValue({ mode: 'stdio' }, '')).toBeUndefined();
    expect(clientHeaderValue({ mode: 'stdio' }, '-1')).toBeUndefined();
  });

  it('a hostile clientInfo gives a header the API accepts, and never throws', () => {
    const throwing = { get name(): string { throw new Error('boom'); }, version: '1' };
    const hostile: Array<{ name?: unknown; version?: unknown }> = [
      { name: 'a, b; tool=lex_export; mode=hosted', version: '1,2' },
      { name: 'x\r\nX-Api-Key: stolen\u0000\u0007\u001b[31m', version: '\t1\n' },
      { name: 'A'.repeat(10_000), version: '9'.repeat(10_000) },
      { name: 'Übersetzer – 法律 🧑‍⚖️', version: 'β1' },
      { name: '法律', version: '1.0' },
      { name: '   ', version: '1.0' },
      { name: '', version: '' },
      { name: 42, version: { toString: () => 'x' } },
      { name: 'ok' },
      { version: '1.0' },
      { name: '<script>alert(1)</script>', version: 'https://user:pw@example.test/' },
      { name: 'a/b/c', version: '1/2' },
      throwing,
    ];
    for (const app of hostile) {
      const value = clientHeaderValue({ mode: 'stdio', tool: 'lex_search', app });
      const p = headerOf(value);
      expect(p).toMatchObject({ name: 'lexapi-mcp', version: PACKAGE_VERSION, mode: 'stdio', tool: 'lex_search' });
      expect(value!.length).toBeLessThanOrEqual(256);
      if (p.app !== null) {
        expect(p.app.length).toBeLessThanOrEqual(64);
        expect(p.app).toMatch(/^[A-Za-z0-9 ._()/+-]+$/);
      }
    }
    expect(clientHeaderValue({ mode: 'stdio', app: hostile[0] })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; app=a b toollex_export modehosted/12`);
    expect(clientHeaderValue({ mode: 'stdio', app: hostile[1] })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; app=x X-Api-Key stolen 31m/1`);
    expect(clientHeaderValue({ mode: 'stdio', app: hostile[2] })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; app=${'A'.repeat(39)}/${'9'.repeat(24)}`);
    expect(clientHeaderValue({ mode: 'stdio', app: hostile[3] })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; app=bersetzer/1`);
    expect(clientHeaderValue({ mode: 'stdio', app: hostile[4] })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio`);
    expect(clientHeaderValue({ mode: 'stdio', app: throwing })).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio`);
  });
});

describe('requests made outside a tool', () => {
  it('carry the server name and version only, once, with the User-Agent unchanged', async () => {
    const m = mockFetch(reply);
    const client = new LexAPIClient({ apiKey: 'lex_test_secret_key', baseUrl: BASE, fetch: m.fetch });
    await client.info();
    await client.nationalCoverage();
    expect(m.calls).toHaveLength(2);
    for (const c of m.calls) {
      expect(c.headers['x-lexapi-client']).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
      expect(c.headers['user-agent']).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
      expect(Object.keys(c.headers).filter((k) => k === 'x-lexapi-client')).toHaveLength(1);
    }
    const stdio = new LexAPIClient({ apiKey: 'lex_test_secret_key', baseUrl: BASE, fetch: m.fetch, mode: 'stdio' });
    await stdio.info();
    expect(m.calls[2].headers['x-lexapi-client']).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio`);
  });

  it('every attempt of a retried request carries it', async () => {
    const m = mockFetch((_c, n) => (n === 1 ? { status: 502, body: {} } : { body: { service: 'mock' } }));
    const client = new LexAPIClient({ apiKey: 'lex_test_secret_key', baseUrl: BASE, fetch: m.fetch, sleep: async () => {}, mode: 'hosted', tool: 'lex_info' });
    await client.info();
    expect(m.calls.map((c) => c.headers['x-lexapi-client'])).toEqual(Array(2).fill(`lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_info`));
  });
});

describe('tool calls (stdio mode, in-memory MCP client)', () => {
  it('a tool call names the tool and the MCP client', async () => {
    const { mcp, calls } = await connect({ mode: 'stdio' });
    const res = await mcp.callTool({ name: 'lex_info', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-lexapi-client']).toBe(`lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; tool=lex_info; app=Example Client/1.2.3`);
    expect(headerOf(calls[0].headers['x-lexapi-client'])).toEqual({ name: 'lexapi-mcp', version: PACKAGE_VERSION, mode: 'stdio', tool: 'lex_info', app: 'Example Client/1.2.3' });
    expect(calls[0].headers['user-agent']).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
    await mcp.close();
  });

  it('every call a workflow tool makes carries the workflow tool\'s name', async () => {
    const { mcp, calls } = await connect({ mode: 'stdio' });
    const runs: Array<[string, Record<string, unknown>, string[]]> = [
      ['lex_check_citation', { identifier: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' }, ['/resolve', '/documents/metadata']],
      ['lex_act_history', { celexNumber: '32016R0679', dates: 2 }, ['/citations/cited-by/32016R0679', '/documents/metadata', '/documents/metadata', '/documents/metadata']],
      ['lex_research', { query: 'right to erasure', jurisdictions: ['eu', 'at'] }, ['/at/legislation/semantic', '/at/search/semantic', '/legislation/semantic', '/national/coverage', '/search/semantic']],
    ];
    for (const [name, args, paths] of runs) {
      const from = calls.length;
      const res = await mcp.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
      const made = calls.slice(from);
      expect(made.map((c) => c.url.pathname.replace('/api/v1', '')).sort(), name).toEqual([...paths].sort());
      for (const c of made) {
        expect(headerOf(c.headers['x-lexapi-client']), `${name} ${c.url.pathname}`).toEqual({ name: 'lexapi-mcp', version: PACKAGE_VERSION, mode: 'stdio', tool: name, app: 'Example Client/1.2.3' });
      }
    }
    await mcp.close();
  });

  it('every tool name is one the header can carry', () => {
    for (const t of tools) expect(parse(clientHeaderValue({ mode: 'hosted', tool: t.name }))?.tool, t.name).toBe(t.name);
  });

  it('concurrent tool calls each carry their own tool name', async () => {
    // Answers are held until every request of the round has been sent.
    const held: Array<() => void> = [];
    const handler = async (c: Call) => {
      await new Promise<void>((r) => { held.push(r); });
      return reply(c);
    };
    const { mcp, calls } = await connect({ mode: 'stdio', handler });
    // The workflow tools start first: their later calls are made while the
    // other tools' calls are in flight.
    const names = ['lex_check_citation', 'lex_act_history', 'lex_info', 'lex_search', 'lex_get_metadata', 'lex_national_coverage'];
    const pathOf: Record<string, string> = { lex_info: '/info', lex_search: '/search', lex_get_metadata: '/documents/metadata', lex_national_coverage: '/national/coverage' };
    const argsOf: Record<string, Record<string, unknown>> = {
      lex_search: { query: 'data' }, lex_get_metadata: { celexNumber: '32016R0679' }, lex_check_citation: { identifier: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' },
      lex_act_history: { celexNumber: '32016R0679', dates: 2 },
    };
    const round = [...names, ...names, ...names];
    const pending = round.map((name) => mcp.callTool({ name, arguments: argsOf[name] ?? {} }));
    // First requests of all calls are in flight together; then let everything through.
    while (held.length < round.length) await new Promise((r) => setTimeout(r, 5));
    const release = setInterval(() => { while (held.length) held.shift()!(); }, 2);
    const results = await Promise.all(pending);
    clearInterval(release);
    expect(results.every((r) => !r.isError)).toBe(true);
    for (const c of calls) {
      const path = c.url.pathname.replace('/api/v1', '');
      const tool = headerOf(c.headers['x-lexapi-client']).tool!;
      if (path === '/resolve') expect(tool).toBe('lex_check_citation');
      else if (path.startsWith('/citations/cited-by/')) expect(tool).toBe('lex_act_history');
      else if (path === '/documents/metadata') expect(['lex_get_metadata', 'lex_check_citation', 'lex_act_history']).toContain(tool);
      else expect(path).toBe(pathOf[tool]);
    }
    // Per call: a citation check makes 2 requests, an act history 4, the others 1.
    const perTool = (name: string) => calls.filter((c) => headerOf(c.headers['x-lexapi-client']).tool === name).length;
    expect(names.map(perTool)).toEqual([6, 12, 3, 3, 3, 3]);
    await mcp.close();
  });

  it('a hostile clientInfo does not block a tool call, and the header stays valid', async () => {
    const infos = [
      { name: 'a, b; tool=lex_export', version: '1,2' },
      { name: 'x\r\nX-Api-Key: stolen\u0000', version: '\u00071' },
      { name: 'N'.repeat(10_000), version: 'V'.repeat(10_000) },
      { name: 'Übersetzer 法律', version: 'β' },
    ];
    for (const clientInfo of infos) {
      const { mcp, calls } = await connect({ mode: 'stdio', clientInfo });
      const res = await mcp.callTool({ name: 'lex_info', arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(parseText(res as never)).toMatchObject({ service: 'mock' });
      const p = headerOf(calls[0].headers['x-lexapi-client']);
      expect(p).toMatchObject({ name: 'lexapi-mcp', version: PACKAGE_VERSION, mode: 'stdio', tool: 'lex_info' });
      expect(calls[0].headers['x-lexapi-client'].length).toBeLessThanOrEqual(256);
      await mcp.close();
    }
  });

  it('without a mode (a client constructed directly) the tool is named and the MCP client is not', async () => {
    const { mcp, calls } = await connect();
    await mcp.callTool({ name: 'lex_info', arguments: {} });
    expect(calls[0].headers['x-lexapi-client']).toBe(`lexapi-mcp/${PACKAGE_VERSION}; tool=lex_info`);
    await mcp.close();
  });
});

// ── The two entries, over their real transports ─────────────────────
describe('hosted server (HTTP)', () => {
  let as: MockAs;
  let http: Server;
  let base: string;
  const KEY = `lex_test_${'ab'.repeat(32)}`;
  const INIT = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Connecting Client', version: '9.9.9' } };

  async function rpc(headers: Record<string, string>, method: string, params: unknown) {
    const r = await fetch(`${base}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await r.text();
    const data = text.match(/^data: (.*)$/m);
    return { status: r.status, json: JSON.parse(data ? data[1] : text) };
  }

  beforeAll(async () => {
    as = await startMockAs();
    http = createHttpServer({ env: { LEXAPI_BASE_URL: as.apiBase, LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer } });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    await as.close();
  });

  for (const path of ['API key', 'OAuth'] as const) {
    it(`${path}: mode=hosted and the tool, never the connecting client`, async () => {
      const headers = { authorization: `Bearer ${path === 'API key' ? KEY : as.mint()}` };
      const from = as.seen.length;
      expect((await rpc(headers, 'initialize', INIT)).status).toBe(200);
      const info = await rpc(headers, 'tools/call', { name: 'lex_info', arguments: {} });
      expect(info.json.result.isError).toBeFalsy();
      const doc = await rpc(headers, 'tools/call', { name: 'lex_get_document', arguments: { celexNumber: '32016R0679' } });
      expect(doc.json.result.isError).toBeFalsy();

      const seen = as.seen.slice(from);
      const api = seen.filter((s) => s.path.startsWith('/api/v1/'));
      expect(api.map((s) => [s.path, s.client])).toEqual([
        ['/api/v1/info', `lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_info`],
        ['/api/v1/documentContent', `lexapi-mcp/${PACKAGE_VERSION}; mode=hosted; tool=lex_get_document`],
      ]);
      for (const s of api) expect(headerOf(s.client)).toMatchObject({ mode: 'hosted', app: null });
      // Only the API receives it: not the token endpoint, not the key set.
      const other = seen.filter((s) => !s.path.startsWith('/api/v1/'));
      if (path === 'OAuth') expect(other.map((s) => s.path)).toContain('/oauth/token');
      for (const s of other) expect(s.client, s.path).toBeUndefined();
    });
  }
});

const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe.skipIf(!existsSync(distEntry))('stdio entry (npm bin, built dist/)', () => {
  const seen: Array<{ path: string; client: string | string[] | undefined; ua: string | undefined }> = [];
  let api: Server;
  let apiUrl: string;

  beforeAll(async () => {
    api = createServer((req, res) => {
      seen.push({ path: req.url ?? '', client: req.headers['x-lexapi-client'], ua: req.headers['user-agent'] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: 'mock', success: true, metadata: { celex: '32016R0679', celexNumber: '32016R0679', title: 'GDPR', urls: {} } }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
  });

  it('mode=stdio, the tool and the MCP client\'s name and version', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: { ...process.env, LEXAPI_API_KEY: 'lex_good', LEXAPI_BASE_URL: apiUrl } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio, test; client', version: '1.0.0' });
    await client.connect(transport);
    await client.listTools();
    expect(seen).toHaveLength(0); // nothing is sent before a tool is called
    await client.callTool({ name: 'lex_info', arguments: {} });
    await client.callTool({ name: 'lex_check_citation', arguments: { identifier: '32016R0679' } });
    await client.close();
    expect(seen.map((s) => [s.path, s.client])).toEqual([
      ['/api/v1/info', `lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; tool=lex_info; app=stdio test client/1.0.0`],
      ['/api/v1/documents/metadata', `lexapi-mcp/${PACKAGE_VERSION}; mode=stdio; tool=lex_check_citation; app=stdio test client/1.0.0`],
    ]);
    for (const s of seen) {
      headerOf(s.client);
      expect(s.ua).toBe(`lexapi-mcp/${PACKAGE_VERSION}`);
    }
  });
});
