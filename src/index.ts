#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { clientFromEnv, createLexServer, PACKAGE_NAME, readOnlyFromEnv } from './server.js';
import { selectTools } from './tools.js';
import { PACKAGE_VERSION } from './version.js';

// stdout is the MCP channel — every log line goes to stderr.
const apiKey = process.env.LEXAPI_API_KEY?.trim();
if (!apiKey) {
  console.error(
    `[${PACKAGE_NAME}] LEXAPI_API_KEY is not set. Get a key at https://lex-api.com/dashboard?ref=npm-mcp and pass it in your MCP client config.`,
  );
  process.exit(1);
}

const readOnly = readOnlyFromEnv();
let client;
try {
  client = clientFromEnv(apiKey);
} catch (err) {
  // The message never contains the key (see LexAPIClient).
  console.error(`[${PACKAGE_NAME}] ${err instanceof Error ? err.message : 'invalid configuration'} (LEXAPI_API_KEY)`);
  process.exit(1);
}
const server = createLexServer(client, { readOnly });
await server.connect(new StdioServerTransport());
console.error(
  `[${PACKAGE_NAME}] v${PACKAGE_VERSION} ready · ${selectTools({ readOnly }).length} tools${readOnly ? ' (read-only)' : ''}`,
);
