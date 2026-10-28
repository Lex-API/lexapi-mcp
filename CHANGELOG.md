# Changelog

All notable changes to `@lexapi/mcp`. Versions follow [semver](https://semver.org); while the package is 0.x, a minor bump can change behaviour.

## 0.4.0 — unreleased

Targets LexAPI's national-law launch (2026-11-03): member-state legislation and case law. **Requires LexAPI API 2.5.0** (lex-api PRs #306, #314 and #320 — the allowance, the documented contract and the pre-launch hardening pass). **Publish only after all three are deployed**, and smoke-test against the live API once it ships — the contracts were built from the PR diffs and the controllers, not a running server.

### Added
- **5 tools**: `lex_national_coverage` (which countries are live, and their legislation/case-law/semantic coverage, sources, licences and attribution — call this first), `lex_list_national_documents` (browse by title/type), `lex_get_national_document` (fetch one by id), `lex_national_semantic_case_law` and `lex_national_semantic_legislation` (separate tools, mirroring the `lex_semantic_case_law` / `lex_semantic_legislation` split — different filters and billing notes). Every tool but the coverage one states in its description that a country may be registered but not yet available to customers, and to call `lex_national_coverage` first.
- **National-law allowance** (lex-api PR #306): `X-National-Limit` / `X-National-Remaining` / `X-National-Reset` response headers are surfaced as `allowance: { limit, remaining, resetsAt }` on every national tool's result (omitted for BUSINESS and higher, which have no separate limit — the headers are absent for them). A `402 NATIONAL_ALLOWANCE_EXHAUSTED` gets its own actionable message in `describeError`, distinct from the credit-pool `CREDITS_EXHAUSTED` message: it's a separate monthly counter, a credit top-up does not help, and it resets at the start of next UTC month.
- `attribution` (the official source and its licence, e.g. RIS, gesetze-im-internet.de, Normattiva, Légifrance/Judilibre, the Rechtspraak open data) is kept on every national document and every semantic hit — never dropped by response shaping, since it's required legal attribution, not optional context.
- National legislation search has no `asOf` parameter (not supported server-side for national law); national case-law search accepts `hyde` for schema compatibility with `lex_semantic_case_law` but it is always a no-op (the national index never rewrites, so it never costs the 15-credit premium).
- **`includeNational` on the citation-graph tools** (`lex_cited_by`, `lex_cites`, `lex_citation_network`, `lex_citation_path`, `lex_related`, `lex_citation_stats`): also returns/follows national neighbours of live countries (BUSINESS, SCALE and ENTERPRISE only — 403 below that). `celexNumber` and `lex_citation_path`'s `from`/`to` now also accept a national document id directly (e.g. `"AT-NOR-12345"`) via a new `celexOrNationalId` validator; `includeNational` is carried through response shaping (never dropped by `compact`). `lex_extract_citations` is unchanged (CELEX/EU-only).
- `tests/national.test.ts`, plus an `includeNational` describe block in `tests/tools.test.ts`.
- **lex-api PR #320 (hardening, API 2.5.0)**: a national document its source withdrew (a takedown, a pseudonymisation fix) now answers `410 DOCUMENT_WITHDRAWN` — a dedicated `describeError` branch says it's gone for good (not retryable), to drop any cached copy, and not to try to identify who it was about. Covers both envelope shapes: the typed one (`lex_get_national_document`, `details` nested) and the legacy one (citation tools for a withdrawn national id, `id`/`jurisdiction`/`withdrawnAt` as top-level siblings — `parseErrorBody`'s stray-field fallback now also picks up `id`/`withdrawnAt`, not just `jurisdiction`). `lex_list_national_documents` gained `cursor` (pages past the first 1,000 rows that `page` reaches) and the response fields `totalExact`/`hasMore`/`nextCursor` (`nextCursor: null` is preserved explicitly — `compact()` would otherwise drop it indistinguishably from "absent", the `content: null` pitfall again); `q`'s minimum length is now 3 (server 400s shorter); its cost note updated to "1 credit flat" (was 3 — **unconfirmed**, PR #320 calls it "Nejc's call").

### Changed
- Review round (PR #6): 409 `NATIONAL_SEMANTIC_NOT_ENABLED` and 503 `NATIONAL_SEMANTIC_UNAVAILABLE` get their own `describeError` messages (point at the right country/tools, not the account); the 404 branch detects a national miss (typed `{id, jurisdiction}`, the citation-guard's bare `"Document not found: <ID>"`, or an unlaunched country's generic "Unknown API endpoint") and stops pointing at `lex_resolve`/`lex_search`; `parseErrorBody` now falls back to a top-level `jurisdiction` field into `details` (national error bodies carry it as a plain sibling of `error`/`code`, not nested). `lex_national_semantic_legislation`'s `query` is `min(3)` (was `min(1)` — the server 400s shorter queries, same bound as case law). Both national semantic tools' `language` uses the full ISO 639-1 `lang()` validator instead of the 10-language EU `SEMANTIC_LANGUAGES` enum (national lanes are single-language and not all are in that list). `lex_get_national_document`'s cost note corrected to "5 reserved, settles at 1" (was "1 credit" — a pool under 5 credits still 402s). `server.json` and both `description` fields bumped/reworded to mention national law; `server.json`'s version was missed in the first pass.
- Added a licensing/permitted-use guardrail to `SERVER_INSTRUCTIONS` (consolidated national texts are not authentic; never re-identify anonymised/pseudonymised parties; never evaluate/compare/predict individual French judges, art. 33 loi n° 2019-222).
- The `tools/list` size tripwire (`tests/transports.test.ts`) raised from 38,000 to 46,500 characters: the 5 national-law tools (~7.5k, trimmed twice for size) plus `includeNational` on the 6 citation tools, on top of the existing ~36.4k baseline.

### Fixed (review round 3)
- **Release blocker:** `server.json`'s `description` was 134 characters; the MCP registry schema it declares (`ServerDetail.description`) caps it at 100, so `mcp-publisher publish` would have rejected it. Shortened to 94 characters. New `tests/server-json.test.ts` validates `server.json` against a local mirror of the schema's constraints (name pattern, `description` length, package `version` shape) so this class of regression fails CI instead of needing a human reviewer to count characters.
- README tools table: `lex_get_national_document`'s cost corrected to "5 → 1" (was "1" — 5 are reserved upfront, so a pool under 5 still 402s even though it settles at 1).
- `describeError`'s national-404 branch hedges its message ("...or the route itself is wrong") since its `Unknown API endpoint` detection matches any unmatched route, not only an unlaunched country — low risk (these tools only ever build known routes) but the wording shouldn't overclaim.

## 0.3.0 — 2026-10-26

Brings the server in line with the current LexAPI API (API changelog up to the consolidated-text / `asOf` release, LexAPI PR #298).

### Added
- **`asOf` on `lex_semantic_legislation`** — the law as in force on a date. Hits carry `asOf`, `asOfResolved`, `asOfReason`, `asOfVersion`, `matchedVersion`; the response carries `asOf` / `asOfSummary`, plus an `asOfCaveat` when some hits could not be resolved to that date.
- **Consolidated-text labels** surfaced on legislation hits (`consolidated`, `consolidatedAsOf`, `baseCelex`, `consolidatedNote`, `baseAct`) and derived on documents fetched by a consolidated CELEX, with a `citing` note telling the model to cite the authentic act.
- 16 tools for endpoints the server did not cover: `lex_info`, `lex_resolve`, `lex_get_documents_batch`, `lex_document_versions`, `lex_get_document_version`, `lex_citation_path`, `lex_related`, `lex_citation_stats`, `lex_extract_citations`, `lex_export`, `lex_list_webhooks`, `lex_get_webhook`, `lex_create_webhook`, `lex_update_webhook`, `lex_delete_webhook`, `lex_test_webhook`.
- `lex_export` (API 2.3.0, LexAPI #303): `dateFrom` / `dateTo` (the API's document-date filter now works), `changedSince` (rows whose text changed) and `documentTypeCode` (type families); `documentType` is described as an exact, case-insensitive label match; `fetchedSince` / `changedSince` take a date or a date-time with a timezone, validated exactly as the API does (zone `Z`, `±HH:MM` or `±HHMM`; optional seconds; a 1–9 digit fraction; calendar-valid dates, also for `dateFrom` / `dateTo`). The result carries `truncatedBy` (`limit`, `max_rows` or `credits`) next to `truncated`. The cost is stated exactly: 1 credit per row returned, at least 1 per call — a 1-credit admission, a reservation up to `limit`, a refund of unreturned rows, and a 402 before anything is returned when the pool cannot cover the reservation. **Publish only after LexAPI #303 is deployed.**
- Webhook URLs are checked before the call: https, port 443/8443, no credentials, no single-label / internal / reserved hostnames, no private, loopback, link-local or other special-purpose IP literals (IPv4-mapped and NAT64 included) — the DNS-free half of the API's egress guard (eurlex-parser #302); the API remains authoritative.
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
- A top-level string `code` on a legacy-shape error body (LexAPI #304) is now the error code, ahead of the legacy `error` text. A 429 with `code: "QUOTA_EXHAUSTED"` is never retried (even with a short `Retry-After`), carries no retry-after, exposes `resetsAt` (the body's `resetsAt`, else `usage.resetsAt`) and says "exhausted until <resetsAt> — do not retry, tell the user". Servers without the `code` are still recognised by the old shape check.
- `lex_export` no longer presents a partial export as the result: a stream without its `_done` trailer, a `_done` with `complete: false`, or a line whose only key is `_error` returns an error naming the rows received; an `_error` line is never returned as a row (SDK contract §1.8; LexAPI #303).
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
