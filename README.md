# LexAPI MCP

[Model Context Protocol](https://modelcontextprotocol.io) server for [LexAPI](https://lex-api.com/?ref=npm-mcp) — EU law for AI assistants: EUR-Lex legislation parsed to article level, CJEU case law, the typed citation graph, and semantic search (including **the law as in force on a date**). Works with Claude, Cursor, VS Code and any other MCP client.

Ask your assistant *"what does Article 17 GDPR require?"*, *"which acts amended REACH?"* or *"what were the own-funds requirements for banks in June 2019?"* — the model calls LexAPI and answers from the source text, with CELEX citations.

You need a LexAPI account. With the hosted server you **sign in with LexAPI** from your MCP client; with the npm package, use an API key from [lex-api.com/dashboard](https://lex-api.com/dashboard?ref=npm-mcp). There is a FREE plan, no card required; see [lex-api.com/pricing](https://lex-api.com/pricing?ref=npm-mcp).

## Connect to the hosted server (sign in with LexAPI)

The server is hosted at **`https://mcp.lex-api.com/v1`** (Streamable HTTP). Add that URL to your client and sign in with your LexAPI account when it asks. Calls are billed to your plan like your own API key; you can disconnect at any time under *Dashboard → Connected apps*.

### claude.ai and Claude Desktop

*Customize → Connectors → Add custom connector*, name it `LexAPI`, URL `https://mcp.lex-api.com/v1`, then *Connect* and sign in. Connectors added on claude.ai are also available in Claude Desktop (same account).

### Claude Code

```bash
claude mcp add --transport http lexapi https://mcp.lex-api.com/v1
```

Then run `/mcp` in Claude Code and choose *Authenticate* for `lexapi`; your browser opens the LexAPI sign-in.

### Other MCP clients

Any client that supports MCP authorization (OAuth 2.1) connects the same way: point it at `https://mcp.lex-api.com/v1`.

### With an API key instead

Clients without OAuth support send a key from the dashboard as `Authorization: Bearer lex_...`:

```bash
claude mcp add --transport http lexapi https://mcp.lex-api.com/v1 --header "Authorization: Bearer lex_..."
```

## Run it locally (npm, API key)

### Claude Desktop (local)

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

### Claude Code (local)

```bash
claude mcp add lexapi --env LEXAPI_API_KEY=lex_... -- npx -y @lexapi/mcp
```

### Cursor, VS Code and other stdio clients

Run `npx -y @lexapi/mcp` with `LEXAPI_API_KEY` in the environment (Cursor: `~/.cursor/mcp.json`; VS Code: `.vscode/mcp.json`; same `command` / `args` / `env` shape as above).

The npm package needs Node.js 20 or newer.

## Tools

Every call is billed from your LexAPI credit pool like the REST endpoint it wraps; each tool's description states its cost.

| Tool | What it does | Credits |
|---|---|---|
| `lex_semantic_legislation` | Find legislation articles by meaning; `asOf` returns the text in force on a date (today's date for current law). | 5 (+ up to 5 per version fetch with `asOf`) |
| `lex_semantic_case_law` | Find judgments, orders and AG opinions by meaning. | 5 (15 with `hyde`) |
| `lex_search` | Structured EUR-Lex search: text, dates, type, author, procedure, collection. | 3 per page |
| `lex_recent_documents` | What was published in the last N days. | 3 per 10 results |
| `lex_resolve` | URL / ELI / ECLI → CELEX. | 1 |
| `lex_get_document` | A document by CELEX: an outline for large acts, then an article or selected parts. | 1 corpus · 4 Cellar · 5 live |
| `lex_get_documents_batch` | Up to 50 documents at once (plan-capped). | per document, as above |
| `lex_get_metadata` | Metadata only. | 1 · 4 · 5 |
| `lex_get_document_by_url` | A document from a pasted EUR-Lex URL. | 1 · 4 · 5 |
| `lex_document_versions` | LexAPI's observed version history of a document. | 1 |
| `lex_get_document_version` | One observed snapshot, by version number or date. | 1 |
| `lex_cited_by` · `lex_cites` | Inbound / outbound citations, with each edge's type and provenance. | 1 |
| `lex_citation_network` | Both directions in one call. | 20 |
| `lex_citation_path` | Shortest citation chain between two documents. | 20 |
| `lex_related` | Documents citing the same acts. | 20 |
| `lex_citation_stats` | Citation graph totals and most-cited documents. | 20 |
| `lex_extract_citations` | Add a document's outbound citations to the graph. | 5 (1 if already done) |
| `lex_transposition` | Measures member states notified to the Commission for an EU act, by country. | 5 |
| `lex_counterparts` | A national act's counterparts in other live countries (BUSINESS+). | 20 |
| `lex_export` | Corpus rows by type, author, collection, language or date (BUSINESS+). | 1 per row, at least 1 per call |
| `lex_national_coverage` | Which countries' national law is live, with sources and licences. | free |
| `lex_list_national_documents` | Browse a country's national legislation and case law. | 3 |
| `lex_get_national_document` | A national document by id. | 5 → 1 |
| `lex_national_semantic_case_law` · `lex_national_semantic_legislation` | Semantic search over one country's case law / legislation. | 5 |
| `lex_info` | Your plan, credit balance and limits. | free |
| `lex_list_webhooks` · `lex_get_webhook` | Your webhooks and their deliveries. | free |
| `lex_create_webhook` · `lex_update_webhook` · `lex_delete_webhook` · `lex_test_webhook` | Webhooks for new documents and changes to watched acts (paid plans). | free |

The citation-graph tools accept national document ids and an `includeNational` option (BUSINESS+). Every national result carries `attribution` (the official source and its licence); LexAPI's Terms require it to be kept with republished content. Consolidated texts are labelled as not authentic; cite the act as published in the Official Journal.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LEXAPI_API_KEY` | *(required)* | Your API key from [lex-api.com/dashboard](https://lex-api.com/dashboard?ref=npm-mcp). |
| `LEXAPI_BASE_URL` | `https://lex-api.com/api/v1` | API base URL. |
| `LEXAPI_MCP_READ_ONLY` | off | `true` hides every tool that is not read-only (webhook writes, `lex_extract_citations`). |
| `LEXAPI_TIMEOUT_MS` | `55000` | Deadline per tool call, retries included. Raise it only together with your MCP client's tool timeout. |

`npm run start:http` (or the `Dockerfile`) runs the Streamable HTTP transport (`POST /v1`, `GET /health`, `PORT` default 3000). A self-hosted copy accepts API keys only; sign in with LexAPI is a feature of the hosted server.

Error messages state what to do (a 402 gives the credits needed and the reset date, a 429 how long to wait). Full API reference: [lex-api.com/docs](https://lex-api.com/docs?ref=npm-mcp).

## Privacy and support

- Privacy notice: [lex-api.com/privacy](https://lex-api.com/privacy?ref=npm-mcp)
- Support: [support@lex-api.com](mailto:support@lex-api.com) · [lex-api.com/support](https://lex-api.com/support?ref=npm-mcp)

## Training data

Using LexAPI content to train, fine-tune or evaluate models needs a separate licence ([Terms §6](https://lex-api.com/terms?ref=npm-mcp#acceptable-use)). [Arieta Data](https://data.arietalabs.com/?ref=npm-mcp), a sister product from Arieta Labs, licenses datasets drawn from the same corpus for training, retrieval and evaluation.

## Development

```bash
npm install
npm test            # build + tests (mocked API, no network)
npm run typecheck && npm run lint
```

## License

MIT
