import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_TIMEOUT_MS, LexAPIClient } from './client.js';
import type { ClientApp, ClientMode } from './clientHeader.js';
import { describeError } from './errors.js';
import { TOOL_SCOPES, type ToolScope } from './oauth/scope.js';
import { inputSchemaOf, selectTools, type ToolDef } from './tools.js';
import { PACKAGE_VERSION } from './version.js';

export const PACKAGE_NAME = 'lexapi-mcp';

/**
 * Sent to the client at initialize (MCP `instructions`): how to use these
 * tools well. Kept short — clients put it in the model's context.
 */
export const SERVER_INSTRUCTIONS = `LexAPI: EU law from EUR-Lex, the CJEU and the Official Journal — legislation parsed to article level, case law, a typed citation graph and semantic search.

Workflows: lex_check_citation, lex_act_history and lex_research each combine several of the calls below, at the same credit cost, and name any part they could not get.

Finding and reading: lex_semantic_legislation / lex_semantic_case_law search by meaning, lex_search by title and filters, and lex_resolve turns URLs, ELIs and ECLIs into CELEX numbers. lex_get_document reads a document; large documents return an outline first, and articleId returns one article. Amendments are lex_cited_by edges with citationType "amendment". lex_transposition lists the measures member states notified to the Commission for an EU act; these are notifications, not findings that a measure transposes the act (or does so completely).

Citations and versions: every document is identified by its CELEX number and EUR-Lex link. Consolidated texts (CELEX 0…-YYYYMMDD, or hits labelled consolidated: true) are documentation without legal force; the authentic act is the one published in the Official Journal (baseCelex). lex_semantic_legislation with asOf returns the law in force on a date; a hit carries the text in force on that date only when asOfResolved is true. For the text in force today, pass today's date (UTC) as asOf and use only hits with asOfResolved: true. Without asOf, acts no longer in force are marked inForce: false where their status is known; since-amended or repealed provisions are not marked. When the consolidated version for a date is known (CELEX 0…-YYYYMMDD; lex_get_metadata and textAvailability show latestConsolidated), lex_get_document reads it; otherwise lex_legislation_as_of resolves it for a known act, and asOf in a search. lex_document_versions / lex_get_document_version are LexAPI's fetch snapshots, not in-force law. inForce on legislation is the act's status today; it is absent ("unknown" in the workflow tools) when not recorded, and does not cover amendments.

LexAPI provides source texts; it does not assess whether anyone is compliant.

National law (member-state legislation and case law): the lex_national_* tools serve only the countries lex_national_coverage lists as live, with their courts and source licensing; a country can be registered but not yet launched, and a call for a country not yet live returns an error. National results, and the Cellar-derived data of lex_transposition, carry attribution (the source and its licence); LexAPI's Terms require this attribution to be kept with republished content. On the FREE, STARTER and PROFESSIONAL plans national-law calls also count against a separate monthly allowance, reported as allowance in each result. On the citation tools, includeNational (or a national document id as input) adds national documents of live countries. BUSINESS+ means the BUSINESS, SCALE and ENTERPRISE plans. BUSINESS+ tools and includeNational return 403 on the other plans; lex_transposition instead returns its BUSINESS+ fields as null. Consolidated national texts are not authentic — only the official gazette is. Court decisions may be anonymised or pseudonymised by the source; LexAPI's Terms prohibit re-identifying people in anonymised or pseudonymised decisions. French law (art. 33, loi n° 2019-222) prohibits using the identity of judges to evaluate, analyse, compare or predict their professional practices.

Each tool description states its cost in credits from the user's monthly pool; lex_info returns the credit balance and the plan's search-page, batch-size and webhook limits. A 402 means credits or the national-law allowance are exhausted and a 429 means a rate limit; the error text gives the details.`;

/** Added to the instructions of an OAuth connection that does not hold every scope. */
export const NARROWED_INSTRUCTIONS = 'Some LexAPI features are not enabled on this connection; reconnect to grant them.';

export interface CreateServerOptions {
  readOnly?: boolean;
  /** The tool scopes of an OAuth connection; undefined for an API key (every tool). */
  scopes?: ReadonlySet<ToolScope>;
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
      instructions: narrowed(opts.scopes) ? `${SERVER_INSTRUCTIONS}\n\n${NARROWED_INSTRUCTIONS}` : SERVER_INSTRUCTIONS,
    },
  );

  for (const tool of selectTools(opts)) registerTool(server, tool, client);
  return server;
}

function narrowed(scopes: ReadonlySet<ToolScope> | undefined): boolean {
  return scopes !== undefined && !TOOL_SCOPES.every((n) => scopes.has(n));
}

function registerTool(server: McpServer, tool: ToolDef, client: LexAPIClient): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.strict ? inputSchemaOf(tool) : tool.inputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    },
    // clientInfo is known once the client has initialized: read per call.
    async (args: Record<string, unknown>, extra: CallExtra) => runTool(tool, args, client, extra, { app: server.server.getClientVersion() }),
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
 * - Timeout: 55 s by default, under the 60 s default request timeout of MCP
 *   clients, so the model gets our actionable message rather than the
 *   client's generic -32001. A progress token does NOT tell us the client
 *   will extend its timeout on progress (TS SDK `resetTimeoutOnProgress`
 *   defaults to false), so it does not raise the timeout; LEXAPI_TIMEOUT_MS
 *   does, for users who also raised their client's timeout.
 * - With a progress token we still send a heartbeat every 10 s, so clients
 *   that DO reset on progress — and UIs showing progress — see the call alive.
 */
export async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  client: LexAPIClient,
  extra: CallExtra = {},
  opts: { timeoutMs?: number; progressIntervalMs?: number; app?: ClientApp } = {},
) {
  const token = extra._meta?.progressToken;
  const timeoutMs = opts.timeoutMs ?? configuredTimeout() ?? DEFAULT_TIMEOUT_MS;
  const callClient = client.forCall({ signal: extra.signal, timeoutMs, tool: tool.name, app: opts.app });
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

/** API-key requests (stdio and hosted): LEXAPI_BASE_URL exactly as 0.3.0 read it. */
export function clientFromEnv(apiKey: string, env: NodeJS.ProcessEnv = process.env, mode?: ClientMode): LexAPIClient {
  return new LexAPIClient({
    apiKey,
    ...(mode ? { mode } : {}),
    ...(env.LEXAPI_BASE_URL ? { baseUrl: env.LEXAPI_BASE_URL } : {}),
  });
}
