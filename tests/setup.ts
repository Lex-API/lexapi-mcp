// Test-wide guards, loaded before every suite (vitest.config.ts setupFiles).
//
// 1. Network: every fetch made in the test process — by a test, or by the
//    server under test calling "LexAPI" — must go to a loopback host. A
//    default base URL (https://lex-api.com) leaking into a test fails it
//    instead of calling production.
// 2. No inbound credential ever reaches LexAPI's REST API:
//    every request to an `/api/v1/` path is inspected. It may carry an API key
//    (`x-api-key: lex_…`, no '.') or an EXCHANGED API token — never a token
//    a test handed to the MCP server (registerInbound), in any header or the
//    body, in any spelling (matched on its signed part), and never any token
//    whose audience is the MCP resource.
import { afterEach, expect } from 'vitest';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MCP_RESOURCE = 'https://mcp.lex-api.com/v1';
const inbound = new Set<string>();
const violations: string[] = [];

/** Record a credential a test sends TO the MCP server; it must never appear upstream. */
export function registerInbound(token: string): void {
  const [h, p] = token.split('.');
  inbound.add(h && p ? `${h}.${p}` : token);
}

function audOf(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).aud;
  } catch {
    return undefined;
  }
}

function inspect(url: URL, init: RequestInit | undefined): void {
  if (!url.pathname.includes('/api/v1/')) return;
  const headers = new Headers(init?.headers ?? {});
  const where = `${init?.method ?? 'GET'} ${url.pathname}`;
  const key = headers.get('x-api-key');
  if (key !== null && !/^lex_[A-Za-z0-9_]+$/.test(key)) violations.push(`${where}: x-api-key is not an API key`);
  const auth = headers.get('authorization');
  if (auth !== null) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) violations.push(`${where}: unexpected Authorization scheme`);
    else {
      const aud = audOf(m[1]);
      if (aud === MCP_RESOURCE || (Array.isArray(aud) && aud.includes(MCP_RESOURCE))) violations.push(`${where}: an MCP-audience token was sent to the API`);
    }
  }
  const seen = [key ?? '', auth ?? '', typeof init?.body === 'string' ? init.body : ''].join('\n');
  for (const t of inbound) if (seen.includes(t)) violations.push(`${where}: an inbound credential was forwarded`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    throw new TypeError(`test harness: refusing to fetch non-local host ${url.hostname} (set the base URL / issuer to the local mock)`);
  }
  inspect(url, input instanceof Request ? { method: input.method, headers: input.headers } : init);
  return realFetch(input, init);
}) as typeof fetch;

afterEach(() => {
  const found = violations.splice(0);
  expect(found, 'upstream requests carrying an inbound credential').toEqual([]);
});
