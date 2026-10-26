# Changelog

All notable changes to `@lexapi/mcp`. Versions follow [semver](https://semver.org); while the package is 0.x, a minor bump can change behaviour.

## 0.3.0 — 2026-10-26

Brings the server in line with the current LexAPI API (API changelog up to the consolidated-text / `asOf` release, LexAPI PR #298).

### Added
- **`asOf` on `lex_semantic_legislation`** — the law as in force on a date. Hits carry `asOf`, `asOfResolved`, `asOfReason`, `asOfVersion`, `matchedVersion`; the response carries `asOf` / `asOfSummary`, plus an `asOfCaveat` when some hits could not be resolved to that date.
- **Consolidated-text labels** surfaced on legislation hits (`consolidated`, `consolidatedAsOf`, `baseCelex`, `consolidatedNote`, `baseAct`) and derived on documents fetched by a consolidated CELEX, with a `citing` note telling the model to cite the authentic act.
- 16 tools for endpoints the server did not cover: `lex_info`, `lex_resolve`, `lex_get_documents_batch`, `lex_document_versions`, `lex_get_document_version`, `lex_citation_path`, `lex_related`, `lex_citation_stats`, `lex_extract_citations`, `lex_export`, `lex_list_webhooks`, `lex_get_webhook`, `lex_create_webhook`, `lex_update_webhook`, `lex_delete_webhook`, `lex_test_webhook`.
- Missing parameters: `lex_get_document` `language`, `acceptLanguages`, `articleId`, `include`; `lex_get_document_by_url` `articleId`, `include`, `bypassCorpus`; `lex_get_metadata` `bypassCorpus`; `lex_search` `month`, `procedure`, `domain`, `subdomain`, `fresh`; `lex_recent_documents` `domain`, `subdomain`; `lex_citation_network` `citationType`, `limit`, `offset`; semantic tools `language`, `include`; `lex_semantic_case_law` `hyde` and typed `filters` (`court`, `date_from`, `date_to`, `case_number`, `ecli`).
- Server `instructions` (workflow, citing consolidated texts, `asOf` vs. version snapshots, credit awareness), tool `title`s, server `title` / `websiteUrl`.
- `LEXAPI_MCP_READ_ONLY` hides the webhook-changing tools; `LEXAPI_TIMEOUT_MS`.
- Hosted HTTP server also accepts `x-api-key`; answers `405` to GET/DELETE (stateless), `413` to oversized bodies, `WWW-Authenticate` on `401`.
- Tests (vitest: unit, in-memory MCP, Streamable HTTP and stdio end-to-end against a mock API), ESLint, CI, `scripts/smoke-stdio.mjs`.

### Changed
- **Responses are compact and bounded.** Tool output is unindented JSON without the `subscription` / `usage` envelopes, legacy duplicate fields, opaque upstream metadata or snapshot-scoped ids. `lex_get_document` (and by-URL / batch / version snapshots) return the full body only when it fits `maxChars` (default 40,000 characters) — otherwise an outline with article ids, and `articleId` / `include` / `offset` to read on. v0.2 returned the whole document (hundreds of KB for large acts), which most clients truncate.
- `textAvailability` is passed through verbatim whenever text is missing (reason, languages, consolidated pointers); language fallback (`languageRequested`, `languageFallback`) and `titleLanguage` are kept.
- **Errors are actionable**: 402 states the credits needed, available and the reset date; 429 the wait; 401/403/404/5xx what to do. Both the typed and the legacy error envelopes are parsed.
- Retries: a 429 is retried once only when `Retry-After` ≤ 10 s (v0.2 slept on any Retry-After, twice); 500/502/503 and network errors once; 504 never (it already spent a 90 s upstream budget); webhook create/test/delete never. Every request has a timeout (120 s default; v0.2 had none).
- Inputs are validated by the MCP SDK (zod) before any API call.
- CELEX inputs accept consolidated (`02016R0679-20180524`) and corrigendum (`32013R0952R(04)`) forms, lower case and a `CELEX:` prefix — v0.2's pattern rejected the first two.
- Enums synced with the API: document type `staff-working-document` added and `opinion-act` removed (the API ignores it); citation type `corrigendum`; author `civil-service-tribunal`; semantic `language` limited to the indexed languages.
- Defaults lowered to cut credit and token use: `lex_recent_documents` `limit` 20 (was 50, i.e. 15 credits when filtered), citation `limit` 50 (was 100).
- Tool descriptions rewritten: costs per call, when to use which tool, FREE plans can use semantic search (credit plans), legislation `filters` honour only `language`.
- `@modelcontextprotocol/sdk` ^1.0.0 → ^1.32.2 (protocol 2025-11-25), high-level `McpServer` API; `zod` added; dependency overrides removed (`npm audit`: 0 vulnerabilities).
- `User-Agent: lexapi-mcp/<version>` on every request.

### Breaking
- Tool output shape changed (compact; large documents outlined). Prompts that relied on v0.2's raw API JSON (e.g. `document.content.fullText` always present) need `include: ["fullText"]`.
- `documentType: "opinion-act"` is now rejected at validation (it never filtered anything).
- Tool names are unchanged.

## 0.2.0
- Hosted Streamable HTTP transport (`/v1`, Bearer auth) for mcp.lex-api.com; `server.json` advertises it.

## 0.1.x
- Initial ten tools over stdio; registry metadata; README fixes.
