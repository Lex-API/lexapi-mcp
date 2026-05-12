#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { LexAPIClient, LexAPIError } from './client.js';
import { tools, toolsByName } from './tools.js';

const PACKAGE_NAME = 'lexapi-mcp';
const PACKAGE_VERSION = '0.1.0';

const apiKey = process.env.LEXAPI_API_KEY;
if (!apiKey) {
  console.error(
    `[${PACKAGE_NAME}] LEXAPI_API_KEY is not set. Get a key at https://lex-api.com/dashboard and pass it in your MCP client config.`,
  );
  process.exit(1);
}

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
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
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
      content: [
        { type: 'text', text: JSON.stringify(result, null, 2) },
      ],
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[${PACKAGE_NAME}] v${PACKAGE_VERSION} ready · ${tools.length} tools registered`,
);
