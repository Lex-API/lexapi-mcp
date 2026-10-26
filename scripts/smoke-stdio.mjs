#!/usr/bin/env node
// Smoke test of the built package over stdio, as an MCP client would run it.
//
//   npm run build && node scripts/smoke-stdio.mjs           # against a local mock API (no network)
//   LEXAPI_API_KEY=lex_... node scripts/smoke-stdio.mjs --live   # against https://lex-api.com (spends roughly 6–25 credits)
//
// Exits non-zero on any failure. Used by CI on every supported Node version.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const live = process.argv.includes('--live');
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let mock;
let env = { ...process.env };
if (live) {
  if (!process.env.LEXAPI_API_KEY) {
    console.error('--live needs LEXAPI_API_KEY');
    process.exit(2);
  }
} else {
  mock = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/documentContent')) {
      res.end(JSON.stringify({
        success: true,
        document: {
          celex: '32016R0679', title: 'GDPR', textAvailability: { available: true },
          content: { articles: [{ id: 'art_17', number: 'Article 17', title: 'Right to erasure', content: '1. The data subject shall have the right…' }] },
        },
      }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'not mocked' } }));
    }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  env = { ...env, LEXAPI_API_KEY: 'lex_smoke', LEXAPI_BASE_URL: `http://127.0.0.1:${mock.address().port}/api/v1` };
}

const client = new Client({ name: 'lexapi-mcp-smoke', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'inherit' }));
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  console.log(`node ${process.version} · ${info.name} ${info.version} · ${tools.length} tools · instructions ${client.getInstructions()?.length ?? 0} chars`);

  const doc = await client.callTool({ name: 'lex_get_document', arguments: { celexNumber: '32016R0679', articleId: '17' } });
  if (doc.isError) throw new Error(`lex_get_document failed: ${doc.content[0].text}`);
  const parsed = JSON.parse(doc.content[0].text);
  if (!parsed.content?.articles?.length) throw new Error('lex_get_document returned no article');
  console.log(`lex_get_document → ${parsed.celex} ${parsed.content.articles[0].number}`);

  if (live) {
    const sem = await client.callTool({ name: 'lex_semantic_legislation', arguments: { query: 'own funds requirements', asOf: '2019-06-01', limit: 3 } });
    if (sem.isError) throw new Error(`lex_semantic_legislation failed: ${sem.content[0].text}`);
    const s = JSON.parse(sem.content[0].text);
    console.log(`lex_semantic_legislation asOf → ${s.resultCount} hits, asOfSummary ${JSON.stringify(s.asOfSummary)}`);
    for (const h of s.results) console.log(`  ${h.law_id} ${h.article_ref} resolved=${h.asOfResolved} ${h.asOfReason ?? ''}`);
  }
  console.log('smoke OK');
} catch (err) {
  console.error('smoke FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  mock?.close();
}
