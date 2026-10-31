# LexAPI MCP

[Model Context Protocol](https://modelcontextprotocol.io) server for [LexAPI](https://lex-api.com/?ref=npm-mcp) — EU law for AI assistants: EUR-Lex legislation parsed to article level, CJEU case law, the typed citation graph, and semantic search (including **the law as in force on a past date**). Works with Claude, Cursor, VS Code and any other MCP client.

Ask your assistant *"what does Article 17 GDPR require?"*, *"which acts amended REACH?"* or *"what were the own-funds requirements for banks in June 2019?"* — the model calls LexAPI and answers from the source text, with CELEX citations.

You need a LexAPI account. With the hosted server you just **sign in with LexAPI** from your MCP client; with the npm package (or if you prefer), use an API key from [lex-api.com/dashboard](https://lex-api.com/dashboard?ref=npm-mcp). There is a FREE plan, no card required, with enough credits to try the read tools; current allowances are on [lex-api.com/pricing](https://lex-api.com/pricing?ref=npm-mcp).

## Connect to the hosted server (sign in with LexAPI)

The server is hosted at **`https://mcp.lex-api.com/v1`** (Streamable HTTP). Add that URL to your client and sign in with your LexAPI account when it asks — no key to copy. You see a LexAPI consent page listing what the connection can do; calls are billed to your plan exactly like your own API key, and you can disconnect the app at any time under *Dashboard → Connected apps* (that revokes it immediately).

### claude.ai and Claude Desktop

*Settings → Connectors → Add custom connector*, name it `LexAPI`, URL `https://mcp.lex-api.com/v1`, then *Connect* and sign in. Connectors added on claude.ai are also available in Claude Desktop (same account).

### Claude Code

```bash
claude mcp add --transport http lexapi https://mcp.lex-api.com/v1
```

Then run `/mcp` in Claude Code and choose *Authenticate* for `lexapi`; your browser opens the LexAPI sign-in.

### Other MCP clients

Any client that implements MCP authorization (OAuth 2.1 with protected-resource discovery) connects the same way: point it at `https://mcp.lex-api.com/v1`. The server answers an unauthenticated request with `401` and `WWW-Authenticate: Bearer … resource_metadata="https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1"`; the client discovers LexAPI (`https://lex-api.com`) as the authorization server from there.

### With an API key instead

Clients without OAuth support — or scripts — send a key from the dashboard as `Authorization: Bearer lex_...` (or `x-api-key: lex_...`):

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

The npm package needs Node.js 20 or newer. It uses an API key; signing in with LexAPI is a feature of the hosted server.

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
| `lex_export` | Corpus rows by type (exact label, any case) or type family (`documentTypeCode`), author, collection, language, document date (`dateFrom`/`dateTo`), `changedSince` or `fetchedSince` (BUSINESS plans and above). | 1 per row returned, at least 1 per call (1-credit admission, rows reserved up to `limit`, unreturned rows refunded; 402 if the pool cannot cover the reservation) |
| `lex_info` | Your plan, credit balance and limits. | free |
| `lex_list_webhooks` · `lex_get_webhook` | Your webhooks and their deliveries. | free |
| `lex_create_webhook` · `lex_update_webhook` · `lex_delete_webhook` · `lex_test_webhook` | Webhooks for new documents and for changes to watched acts (paid plans). The URL must be a public https URL (port 443/8443, no internal hosts or private addresses) — checked here as well as by the API. | free |

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
| `LEXAPI_MCP_READ_ONLY` | off | `true` hides (and refuses) every tool that is not read-only: webhook create / update / delete / test, and `lex_extract_citations` (it writes to the shared citation graph and costs credits). |
| `LEXAPI_TIMEOUT_MS` | `55000` | Deadline for one tool call towards LexAPI, retries included. Raise it only together with your MCP client's own tool timeout. |
| `LEXAPI_MCP_ALLOWED_ORIGINS` | *(none)* | Hosted HTTP server only: browser `Origin`s allowed to call it (comma-separated, `*` for any). Requests without an `Origin` header (all non-browser clients) are always allowed. |

The key is sent only as the `x-api-key` header to LexAPI; it is never logged or included in tool output. A `LEXAPI_API_KEY` containing whitespace or control characters (e.g. a multi-line paste) is rejected at startup.

### Hosting the HTTP server

`npm run start:http` (or the `Dockerfile`) runs the Streamable HTTP transport (`POST /v1`, `GET /health`). Self-hosted, it accepts LexAPI API keys (`Authorization: Bearer lex_…` or `x-api-key: lex_…`); a request without one gets `401`. A value that cannot be an API key (it contains a `.` or is longer than 8192 characters) is answered `401` and never forwarded.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `LEXAPI_BASE_URL` | `https://lex-api.com/api/v1` | LexAPI REST base. |

Sign in with LexAPI is a feature of the hosted server at `https://mcp.lex-api.com/v1`: it needs an OAuth client registered with LexAPI, so a self-hosted copy runs with API keys only. The OAuth-related settings in `src/oauth/config.ts` (`LEXAPI_OAUTH_*`, `LEXAPI_MCP_*`) are for that deployment; the server refuses to start if they are set incompletely.

**`/health`** returns `status`, `name`, `version`, `tools` and `oauth` (whether sign-in is enabled). It never contains addresses, tokens or configuration values.

**Timeouts.** MCP clients give up on a tool call after their own timeout (60 s by default in the official SDK; Claude Code: `MCP_TOOL_TIMEOUT`). A first, live EUR-Lex fetch can take longer. The server gives each tool call one 55 s deadline — retries and rate-limit waits included — and then returns a message the model can act on, instead of the client's generic timeout error. When the client sends a progress token, the server also sends a progress notification every 10 s; whether that keeps the call alive is up to the client (the official SDK only extends its timeout on progress when the caller opts into `resetTimeoutOnProgress`, and a server cannot detect that), so the deadline stays 55 s. If you raise your client's timeout, raise `LEXAPI_TIMEOUT_MS` to match. Cancelling a call aborts the request to LexAPI.

## Troubleshooting

- **`LEXAPI_API_KEY is not set`** — the variable isn't reaching the spawned process; check the `env` block of your MCP client config.
- **`LexAPI error 401`** — the key is wrong or revoked; create a new one at the dashboard.
- **Hosted server: "LexAPI sign-in expired or was revoked"** — the connection was disconnected (for example from the dashboard); reconnect LexAPI in your client to sign in again.
- **Hosted server: `403 Subscription inactive`** — the signed-in account's paid plan is not active; the same as with an API key.
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

`npm run start:http` runs the hosted Streamable HTTP transport (`POST /v1`, `GET /health`, port from `PORT`, default 3000; see *Hosting the HTTP server* above); the `Dockerfile` builds it. The OAuth tests run against a local mock authorization server (`tests/oauth-mock.ts`), no network.

## License

MIT
