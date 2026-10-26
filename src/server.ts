import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { LexAPIClient } from './client.js';
import { describeError } from './errors.js';
import { selectTools, type ToolDef } from './tools.js';
import { PACKAGE_VERSION } from './version.js';

export const PACKAGE_NAME = 'lexapi-mcp';

/**
 * Sent to the client at initialize (MCP `instructions`): how to use these
 * tools well. Kept short — clients put it in the model's context.
 */
export const SERVER_INSTRUCTIONS = `LexAPI: EU law from EUR-Lex, the CJEU and the Official Journal — legislation parsed to article level, case law, a typed citation graph and semantic search.

Workflow: identify the act (lex_semantic_legislation / lex_semantic_case_law for concepts, lex_search for titles and filters, lex_resolve for URLs/ELI/ECLI), then read it with lex_get_document — large documents return an outline first; fetch the article you need with articleId. Amendments: lex_cited_by with citationType "amendment".

Citing: always give the CELEX number (and the EUR-Lex link). Consolidated texts (CELEX 0…-YYYYMMDD, or hits labelled consolidated: true) are documentation tools without legal force — quote them, but cite the authentic act as published in the Official Journal (baseCelex). For the law on a past date use lex_semantic_legislation with asOf; trust a hit as the text in force on that date only when asOfResolved is true. lex_document_versions / lex_get_document_version are LexAPI's fetch snapshots, not in-force law.

LexAPI provides source texts; it does not decide whether anyone is compliant — leave legal conclusions to the user and their advisers.

Costs come from the user's monthly credit pool and are stated in each tool description; avoid repeated or speculative calls. On a 402 (credits exhausted) or 429 (rate limit), stop and tell the user what the error says.`;

export interface CreateServerOptions {
  readOnly?: boolean;
}

export function createLexServer(client: LexAPIClient, opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: 'LexAPI',
      version: PACKAGE_VERSION,
      websiteUrl: 'https://lex-api.com',
    },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  for (const tool of selectTools(opts)) registerTool(server, tool, client);
  return server;
}

function registerTool(server: McpServer, tool: ToolDef, client: LexAPIClient): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    },
    async (args: Record<string, unknown>) => runTool(tool, args, client),
  );
}

/** Execute a tool and render its result (or error) as MCP tool content. */
export async function runTool(tool: ToolDef, args: Record<string, unknown>, client: LexAPIClient) {
  try {
    const result = await tool.handler(args ?? {}, client);
    // Compact JSON: indentation costs ~25% more tokens and models read it fine.
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text' as const, text: describeError(err) }] };
  }
}

export function readOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LEXAPI_MCP_READ_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function clientFromEnv(apiKey: string, env: NodeJS.ProcessEnv = process.env): LexAPIClient {
  const timeout = Number.parseInt(env.LEXAPI_TIMEOUT_MS ?? '', 10);
  return new LexAPIClient({
    apiKey,
    ...(env.LEXAPI_BASE_URL ? { baseUrl: env.LEXAPI_BASE_URL } : {}),
    ...(Number.isFinite(timeout) && timeout >= 5000 ? { timeoutMs: timeout } : {}),
  });
}
