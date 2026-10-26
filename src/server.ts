import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_TIMEOUT_MS, LexAPIClient, LONG_TIMEOUT_MS } from './client.js';
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

Citing: always give the CELEX number (and the EUR-Lex link). Consolidated texts (CELEX 0…-YYYYMMDD, or hits labelled consolidated: true) are documentation tools without legal force — quote them, but cite the authentic act as published in the Official Journal (baseCelex). For the law on a past date use lex_semantic_legislation with asOf; trust a hit as the text in force on that date only when asOfResolved is true. For a known article on a past date when you already know the consolidated version for that date (CELEX 0…-YYYYMMDD; lex_get_metadata and textAvailability show latestConsolidated), read it directly with lex_get_document; otherwise asOf is the route that resolves the version in force. lex_document_versions / lex_get_document_version are LexAPI's fetch snapshots, not in-force law.

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
      // The tool-level `title` already names it; annotations.title would repeat it.
      annotations: tool.annotations,
    },
    async (args: Record<string, unknown>, extra: CallExtra) => runTool(tool, args, client, extra),
  );
}

/** The parts of the SDK's RequestHandlerExtra a tool call uses. */
export interface CallExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

export const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Execute a tool and render its result (or error) as MCP tool content.
 *
 * - The MCP request's abort signal (client cancellation, closed HTTP
 *   connection) aborts the upstream LexAPI request.
 * - With a progress token, the client can keep the request alive on
 *   progress (TS SDK `resetTimeoutOnProgress`): we send a heartbeat every
 *   10 s and allow the long timeout. Without one, the client's own timeout
 *   (60 s by default) applies, so we stop at 55 s with a useful message.
 */
export async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  client: LexAPIClient,
  extra: CallExtra = {},
  opts: { timeoutMs?: number; progressIntervalMs?: number } = {},
) {
  const token = extra._meta?.progressToken;
  const timeoutMs = opts.timeoutMs ?? configuredTimeout() ?? (token !== undefined ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const callClient = client.forCall({ signal: extra.signal, timeoutMs });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (token !== undefined && extra.sendNotification) {
    let n = 0;
    const send = extra.sendNotification;
    heartbeat = setInterval(() => {
      n += 1;
      send({ method: 'notifications/progress', params: { progressToken: token, progress: n, message: 'Waiting for LexAPI…' } }).catch(() => {});
    }, opts.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
  }
  try {
    const result = await tool.handler(args ?? {}, callClient);
    // Compact JSON: indentation costs ~25% more tokens and models read it fine.
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text' as const, text: describeError(err) }] };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function configuredTimeout(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const t = Number.parseInt(env.LEXAPI_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(t) && t >= 5000 ? t : undefined;
}

export function readOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LEXAPI_MCP_READ_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function clientFromEnv(apiKey: string, env: NodeJS.ProcessEnv = process.env): LexAPIClient {
  return new LexAPIClient({
    apiKey,
    ...(env.LEXAPI_BASE_URL ? { baseUrl: env.LEXAPI_BASE_URL } : {}),
  });
}
