# LexAPI MCP

[Model Context Protocol](https://modelcontextprotocol.io) server for [LexAPI](https://lex-api.com/?ref=npm-mcp) — EU law for AI assistants: EUR-Lex legislation parsed to article level, CJEU case law, the typed citation graph, and semantic search (including **the law as in force on a past date**). Works with Claude, Cursor, VS Code and any other MCP client.

Ask your assistant *"what does Article 17 GDPR require?"*, *"which acts amended REACH?"* or *"what were the own-funds requirements for banks in June 2019?"* — the model calls LexAPI and answers from the source text, with CELEX citations.

You need a LexAPI API key. Create one for free at [lex-api.com/dashboard](https://lex-api.com/dashboard?ref=npm-mcp) — the FREE plan includes 500 credits a month, no card required, enough to try the read tools.

## Install

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lexapi": {
      "command": "npx",
      "args": ["-y", "@lexapi/mcp"],
      "env": { "LEXAPI_API_KEY": "lex_..." }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add lexapi --env LEXAPI_API_KEY=lex_... -- npx -y @lexapi/mcp
```

### Cursor, VS Code and other stdio clients

Run `npx -y @lexapi/mcp` with `LEXAPI_API_KEY` in the environment (Cursor: `~/.cursor/mcp.json`; VS Code: `.vscode/mcp.json`; same `command` / `args` / `env` shape as above).

### Hosted server (no local install)

The same tools are served over Streamable HTTP at `https://mcp.lex-api.com/v1`, authenticated with your key as `Authorization: Bearer lex_...` (or `x-api-key: lex_...`):

```bash
claude mcp add --transport http lexapi https://mcp.lex-api.com/v1 --header "Authorization: Bearer lex_..."
```

The npm package needs Node.js 20 or newer.

## Tools

Every call is billed from your LexAPI credit pool exactly like the REST endpoint it wraps; each tool's description states its cost so the model can see it.

| Tool | What it does | Credits |
|---|---|---|
| `lex_semantic_legislation` | Find legislation articles by meaning. `asOf` returns the text in force on a date. Consolidated hits are labelled, with the authentic act to cite. | 5 (+ up to 5 per live version fetch with `asOf`) |
| `lex_semantic_case_law` | Find judgments, orders and AG opinions by meaning; `hyde` for terse queries; court / date / case-number filters. | 5 (15 with `hyde`) |
| `lex_search` | Structured EUR-Lex search: text, dates, type, author, procedure, collection. | 3 per page |
| `lex_recent_documents` | What was published in the last N days. | 3 per 10 results |
| `lex_resolve` | URL / ELI / ECLI → CELEX. | 1 |
| `lex_get_document` | A document by CELEX — an outline first for large acts, then `articleId` or `include` parts; language and fallback languages. | 1 corpus · 4 Cellar · 5 live |
| `lex_get_documents_batch` | Up to 50 documents at once (plan-capped). | per document, as above |
| `lex_get_metadata` | Metadata only. | 1 · 4 · 5 |
| `lex_get_document_by_url` | A document from a pasted EUR-Lex URL. | 1 · 4 · 5 |
| `lex_document_versions` | LexAPI's observed version history of a document. | 1 |
| `lex_get_document_version` | One observed snapshot, by version number or date. | 1 |
| `lex_cited_by` | Documents citing / amending / correcting / repealing an act. | 1 |
| `lex_cites` | What a document cites. | 1 |
| `lex_citation_network` | Both directions in one call. | 20 |
| `lex_citation_path` | Shortest citation chain between two documents. | 20 |
| `lex_related` | Documents citing the same acts (bibliographic coupling). | 20 |
| `lex_citation_stats` | Citation graph totals and most-cited documents. | 20 |
| `lex_extract_citations` | Add a document's outbound citations to the graph. | 5 (1 if already done) |
| `lex_export` | Corpus rows by filter (BUSINESS plans and above). | 1 per row |
| `lex_info` | Your plan, credit balance and limits. | free |
| `lex_list_webhooks` · `lex_get_webhook` | Your webhooks and their deliveries. | free |
| `lex_create_webhook` · `lex_update_webhook` · `lex_delete_webhook` · `lex_test_webhook` | Webhooks for new documents and for changes to watched acts (paid plans). | free |

### How results are shaped for models

- **Compact output.** Responses drop envelopes and duplicate legacy fields. Documents keep their metadata, `textAvailability` (why text is missing, which languages exist, a pointer to the latest consolidated version) and language-fallback labels.
- **Large documents.** `lex_get_document` returns the whole body when it fits `maxChars` (default 40,000 characters), otherwise an outline (article ids, section tree, counts). Fetch an article with `articleId` or parts with `include`; long parts continue with `offset`.
- **Consolidated texts are not authentic.** Consolidated versions carry `consolidated: true`, `consolidatedAsOf`, `baseCelex` and a note: quote them, cite the act as published in the Official Journal.
- **`asOf`.** Each legislation hit says whether it carries the version in force on that date (`asOfResolved`, `asOfVersion`); unresolved hits keep the current text with an `asOfReason`, and the response warns about them.
- **Errors say what to do.** A 402 states the credits needed, the credits left and the reset date; a 429 says how long to wait.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LEXAPI_API_KEY` | *(required)* | Your API key from [lex-api.com/dashboard](https://lex-api.com/dashboard?ref=npm-mcp). |
| `LEXAPI_BASE_URL` | `https://lex-api.com/api/v1` | Override for staging or self-hosting. |
| `LEXAPI_MCP_READ_ONLY` | off | `true` hides the tools that change your account (webhook create / update / delete / test). |
| `LEXAPI_TIMEOUT_MS` | `120000` | Per-request timeout. |

The key is sent only as the `x-api-key` header to LexAPI; it is never logged or included in tool output.

## Troubleshooting

- **`LEXAPI_API_KEY is not set`** — the variable isn't reaching the spawned process; check the `env` block of your MCP client config.
- **`LexAPI error 401`** — the key is wrong or revoked; create a new one at the dashboard.
- **`LexAPI error 402 (CREDITS_EXHAUSTED)`** — the monthly credit pool is used up. The message gives the reset date; top-ups and upgrades are on the dashboard.
- **`LexAPI error 429`** — the per-minute rate limit of your key (FREE: 15 per minute). Short waits are retried once automatically; otherwise the message says how long to wait.
- **`LexAPI error 403`** — the plan doesn't include the feature (e.g. export below BUSINESS, or semantic search on a legacy pre-credits FREE plan).
- **`LexAPI error 400` creating a webhook** — the details name the problem (unsupported criteria, a watch list over the plan limit, or the plan's webhook limit; FREE has none).

## Development

```bash
git clone https://github.com/Lex-API/lexapi-mcp.git
cd lexapi-mcp
npm install
npm test                       # build + unit and transport tests (mocked API, no network)
npm run typecheck && npm run lint
node scripts/smoke-stdio.mjs   # stdio smoke test against a local mock API
LEXAPI_API_KEY=lex_... node scripts/smoke-stdio.mjs --live   # against the real API (spends roughly 6–25 credits)
```

`npm run start:http` runs the hosted Streamable HTTP transport (`POST /v1`, `GET /health`, port from `PORT`, default 3000); the `Dockerfile` builds it.

## License

MIT
