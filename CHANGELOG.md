# Changelog

All notable changes to `@lexapi/mcp`. Versions follow [semver](https://semver.org); while the package is 0.x, a minor bump can change behaviour.

## 0.4.0 — unreleased

### Added
- **Sign in with LexAPI** on the hosted server (`https://mcp.lex-api.com/v1`). MCP clients that support MCP authorization (OAuth 2.1) can connect with your LexAPI account instead of a pasted API key: add the URL, sign in, approve the consent page. Calls are billed to your plan exactly as with an API key, and you can disconnect the app at any time from the LexAPI dashboard.
- OAuth Protected Resource Metadata (RFC 9728) at `https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1`. An unauthenticated request gets `401` with `WWW-Authenticate: Bearer realm="lexapi", resource_metadata="…", scope="lex"`; a rejected or expired token gets `error="invalid_token"`, so clients refresh or re-authorize.
- A connection that is revoked while in use is answered with `401 invalid_token` where possible, or with a tool error asking to reconnect.
- `/health` reports whether sign-in is enabled.

### Changed
- README: how to connect from claude.ai / Claude Desktop (custom connector), Claude Code (`claude mcp add --transport http lexapi https://mcp.lex-api.com/v1`, then `/mcp` → *Authenticate*) and other MCP clients; the API-key option remains documented. The FREE-plan note now points to the pricing page instead of quoting an allowance.
- `server.json`: the remote's `Authorization` header is now optional (sign-in is discovered from the server's 401); version 0.4.0.
- Hosted server: a credential that cannot be a LexAPI API key (contains a `.` or is over 8192 characters) is answered `401` by the MCP server instead of being forwarded. No valid API key is affected.
- API keys (`Authorization: Bearer lex_…` or `x-api-key`) keep working on the hosted server exactly as before; when both headers are sent with sign-in enabled, `x-api-key` takes precedence.

## 0.3.0 — 2026-10-26

Brings the server in line with the current LexAPI API (API changelog up to the consolidated-text / `asOf` release).

### Added
- **`asOf` on `lex_semantic_legislation`** — the law as in force on a date. Hits carry `asOf`, `asOfResolved`, `asOfReason`, `asOfVersion`, `matchedVersion`; the response carries `asOf` / `asOfSummary`, plus an `asOfCaveat` when some hits could not be resolved to that date.
- **Consolidated-text labels** surfaced on legislation hits (`consolidated`, `consolidatedAsOf`, `baseCelex`, `consolidatedNote`, `baseAct`) and derived on documents fetched by a consolidated CELEX, with a `citing` note telling the model to cite the authentic act.
- 16 tools for endpoints the server did not cover: `lex_info`, `lex_resolve`, `lex_get_documents_batch`, `lex_document_versions`, `lex_get_document_version`, `lex_citation_path`, `lex_related`, `lex_citation_stats`, `lex_extract_citations`, `lex_export`, `lex_list_webhooks`, `lex_get_webhook`, `lex_create_webhook`, `lex_update_webhook`, `lex_delete_webhook`, `lex_test_webhook`.
- `lex_export` (API 2.3.0): `dateFrom` / `dateTo` (the API's document-date filter now works), `changedSince` (rows whose text changed) and `documentTypeCode` (type families); `documentType` is described as an exact, case-insensitive label match; `fetchedSince` / `changedSince` take a date or a date-time with a timezone, validated exactly as the API does (zone `Z`, `±HH:MM` or `±HHMM`; optional seconds; a 1–9 digit fraction; calendar-valid dates, also for `dateFrom` / `dateTo`). The result carries `truncatedBy` (`limit`, `max_rows` or `credits`) next to `truncated`. The cost is stated exactly: 1 credit per row returned, at least 1 per call — a 1-credit admission, a reservation up to `limit`, a refund of unreturned rows, and a 402 before anything is returned when the pool cannot cover the reservation.
- Webhook URLs are checked before the call: https, port 443/8443, no credentials, no single-label / internal / reserved hostnames, no private, loopback, link-local or other special-purpose IP literals (IPv4-mapped and NAT64 included) — the DNS-free half of the API's egress guard; the API remains authoritative.
- Missing parameters: `lex_get_document` `language`, `acceptLanguages`, `articleId`, `include`; `lex_get_document_by_url` `articleId`, `include`, `bypassCorpus`; `lex_get_metadata` `bypassCorpus`; `lex_search` `month`, `procedure`, `domain`, `subdomain`, `fresh`; `lex_recent_documents` `domain`, `subdomain`; `lex_citation_network` `citationType`, `limit`, `offset`; semantic tools `language`, `include`; `lex_semantic_case_law` `hyde` and typed `filters` (`court`, `date_from`, `date_to`, `case_number`, `ecli`).
- Server `instructions` (workflow, citing consolidated texts, `asOf` vs. version snapshots, credit awareness), tool `title`s, server `title` / `websiteUrl`.
- `LEXAPI_MCP_READ_ONLY` hides the webhook-changing tools; `LEXAPI_TIMEOUT_MS`.
- Hosted HTTP server also accepts `x-api-key`; answers `405` to GET/DELETE (stateless), `413` to oversized bodies (and closes the connection), `WWW-Authenticate` on `401`; validates `Origin` (MCP spec, DNS-rebinding defence): browser origins must be listed in `LEXAPI_MCP_ALLOWED_ORIGINS`, requests without `Origin` are allowed.
- Cancellation: an MCP `notifications/cancelled` (or a closed HTTP connection) aborts the upstream LexAPI request. Progress notifications every 10 s when the request carries a progress token (they do not raise the timeout: a server cannot tell whether the client resets its timeout on progress).
- `asOfCaveat` groups unresolved hits by reason: `notInForce` (that is the answer), `retryable`, `needsCredits`, `unavailable`, each with guidance.
- Long items (a giant annex, a `fullText` without blank lines) are split into parts that `offset` pages through; the outline's article list is bounded by `maxChars` and paged with `offset`; the outline hint only suggests parts the document has.
- Tests (vitest: unit, in-memory MCP, Streamable HTTP and stdio end-to-end against a mock API), ESLint, CI, `scripts/smoke-stdio.mjs`.

### Changed
- **Responses are compact and bounded.** Tool output is unindented JSON without the `subscription` / `usage` envelopes, legacy duplicate fields, opaque upstream metadata or snapshot-scoped ids. `lex_get_document` (and by-URL / batch / version snapshots) return the full body only when it fits `maxChars` (default 40,000 characters) — otherwise an outline with article ids, and `articleId` / `include` / `offset` to read on. v0.2 returned the whole document (hundreds of KB for large acts), which most clients truncate.
- `textAvailability` is passed through verbatim whenever text is missing (reason, languages, consolidated pointers); language fallback (`languageRequested`, `languageFallback`) and `titleLanguage` are kept.
- **Errors are actionable**: 402 states the credits needed, available and the reset date; 429 the wait; 401/403/404/5xx what to do. Both the typed and the legacy error envelopes are parsed.
- 429s from the legacy daily quota and monthly semantic quota (no `Retry-After`) say "exhausted until `usage.resetsAt` — do not retry", instead of "wait a minute".
- A top-level string `code` on a legacy-shape error body is now the error code, ahead of the legacy `error` text. A 429 with `code: "QUOTA_EXHAUSTED"` is never retried (even with a short `Retry-After`), carries no retry-after, exposes `resetsAt` (the body's `resetsAt`, else `usage.resetsAt`) and says "exhausted until <resetsAt> — do not retry, tell the user". Servers without the `code` are still recognised by the old shape check.
- `lex_export` no longer presents a partial export as the result: a stream without its `_done` trailer, a `_done` with `complete: false`, or a line whose only key is `_error` returns an error naming the rows received; an `_error` line is never returned as a row.
- One 55 s deadline per tool call (under the 60 s default of MCP clients), shared by all attempts, backoff and 429 waits; `LEXAPI_TIMEOUT_MS` raises it.
- The API key is validated at startup (no whitespace / control characters); network errors never echo runtime text (undici can quote header values).
- Retries: a 429 is retried once only when `Retry-After` ≤ 10 s (v0.2 slept on any Retry-After, twice); 500/502/503 and network errors once; 504 never (it already spent a 90 s upstream budget); webhook create/test/delete never. Every call has one deadline (55 s default; v0.2 had no timeout).
- Inputs are validated by the MCP SDK (zod) before any API call.
- CELEX inputs accept consolidated (`02016R0679-20180524`) and corrigendum (`32013R0952R(04)`) forms, lower case and a `CELEX:` prefix — v0.2's pattern rejected the first two.
- Enums synced with the API: document type `staff-working-document` added and `opinion-act` removed (the API ignores it); citation type `corrigendum`; author `civil-service-tribunal`; semantic `language` limited to the indexed languages.
- Defaults lowered to cut credit and token use: `lex_recent_documents` `limit` 20 (was 50, i.e. 15 credits when filtered), citation `limit` 50 (was 100).
- Tool descriptions rewritten: costs per call, when to use which tool, FREE plans can use semantic search (credit plans), legislation `filters` honour only `language`.
- `@modelcontextprotocol/sdk` ^1.0.0 → ^1.32.2 (protocol 2025-11-25), high-level `McpServer` API; `zod` added; dependency overrides removed (`npm audit`: 0 vulnerabilities).
- `User-Agent: lexapi-mcp/<version>` on every request.

### Breaking
- Tool output shape changed (compact; large documents outlined). Prompts that relied on v0.2's raw API JSON (e.g. `document.content.fullText` always present) need `include: ["fullText"]`.
- Inputs are validated before any call; v0.2 forwarded anything. Newly rejected:
  - `documentType: "opinion-act"` (it never filtered anything);
  - `lex_semantic_case_law.query` shorter than 3 characters (the semantic index rejects it; the API answered 502);
  - semantic `language` outside the 10 indexed languages (`en, fr, de, es, it, sl, el, nl, pt, pl`); document/search `language` outside the 24 EU codes;
  - `lex_search.maxPages` above 100 (the highest plan cap); `year` outside 1950–2100; `month` outside 1–12;
  - malformed CELEX numbers, dates not in `YYYY-MM-DD`, unknown webhook `searchCriteria` keys.
- Smaller defaults: `lex_recent_documents` `limit` 20 (was 50), citation `limit` 50 (was 100).
- `LEXAPI_MCP_READ_ONLY` also hides `lex_extract_citations`.
- One 55 s deadline per tool call (v0.2: no timeout at all) unless `LEXAPI_TIMEOUT_MS` is set.
- Hosted HTTP: browser requests with an `Origin` not listed in `LEXAPI_MCP_ALLOWED_ORIGINS` get 403; a malformed key (whitespace inside the value) gets 401 `malformed_api_key`; an oversized body is drained (up to 16 MB / 5 s) and answered 413, then the connection closes.
- Webhook `url` values that are not public https URLs are rejected at validation.
- Tool names are unchanged.

## 0.2.0
- Hosted Streamable HTTP transport (`/v1`, Bearer auth) for mcp.lex-api.com; `server.json` advertises it.

## 0.1.x
- Initial ten tools over stdio; registry metadata; README fixes.
