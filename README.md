# LexAPI MCP

[Model Context Protocol](https://modelcontextprotocol.io) server for [LexAPI](https://lex-api.com) — query EUR-Lex, EU case law, and the citation graph from Claude, Cursor, and other MCP-enabled clients.

Install once, get an API key, and ask your AI assistant: *"summarize Article 17 of the GDPR"* or *"which regulations amend Directive 95/46/EC?"* — the model calls LexAPI directly.

## Install

You'll need a LexAPI API key. Create one for free at [lex-api.com/dashboard](https://lex-api.com/dashboard) (50 calls/day on the FREE tier).

### Claude Desktop

Add to `claude_desktop_config.json` (location: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "lexapi": {
      "command": "npx",
      "args": ["-y", "@lexapi/mcp"],
      "env": {
        "LEXAPI_API_KEY": "lex_..."
      }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add lexapi --env LEXAPI_API_KEY=lex_... -- npx -y @lexapi/mcp
```

### Cursor / other MCP clients

Any client that supports stdio MCP servers can run this. The command is `npx -y @lexapi/mcp` with `LEXAPI_API_KEY` in the environment.

## Tools

| Tool | What it does |
|---|---|
| `lex_search` | Structured EUR-Lex search (text, dates, document type, author, language). |
| `lex_get_document` | Full parsed document by CELEX — metadata + articles, sections, tables, annexes. |
| `lex_get_metadata` | Metadata only (faster than full content). |
| `lex_get_document_by_url` | Fetch by EUR-Lex URL (pasted from a browser). |
| `lex_recent_documents` | Recent Official Journal publications (default 7 days). |
| `lex_cited_by` | Documents citing this CELEX (inbound, typed edges). |
| `lex_cites` | Documents this CELEX cites (outbound, typed edges). |
| `lex_citation_network` | Both directions in one call. |
| `lex_semantic_case_law` | Embedding search over EU case law (paid plans). |
| `lex_semantic_legislation` | Embedding search over EU legislation (paid plans). |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LEXAPI_API_KEY` | *(required)* | Your API key. Get one at [lex-api.com/dashboard](https://lex-api.com/dashboard). |
| `LEXAPI_BASE_URL` | `https://lex-api.com/api/v1` | Override for self-hosted or staging. |

## Troubleshooting

**`LEXAPI_API_KEY is not set`** — the env var isn't reaching the spawned process. Double-check the `env` block in your MCP client config.

**`LexAPI error (401 invalid_api_key)`** — the key is wrong or revoked. Generate a new one at the dashboard.

**`LexAPI error (429 …)`** — you hit your daily quota or per-minute rate limit. The server retries once automatically; if you see this in tool output, you're over quota. Upgrade your plan or wait for reset.

**`LexAPI error (403 …)` on semantic tools** — semantic search requires a paid plan. FREE tier returns 403 for those endpoints.

## Local development

```bash
git clone https://github.com/lexapi/lexapi-mcp.git
cd lexapi-mcp
npm install
npm run build

LEXAPI_API_KEY=lex_xxx node dist/index.js
```

## License

MIT
