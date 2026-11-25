// OAuth scopes: lex:read, lex:webhooks and `lex` (both).
//  - scope strings are read exactly as the LexAPI API reads them;
//  - every tool declares the scope the API requires for the routes it calls;
//  - an OAuth connection is offered, and may call, only the tools of its scopes;
//  - an API key is not subject to scopes, on stdio and on the hosted server.
// Everything runs against the local mock (tests/oauth-mock.ts) or an injected fetch.
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { LexAPIClient } from '../src/client.js';
import { describeError, UpstreamAuthError } from '../src/errors.js';
import { createHttpServer, refusedToolCall } from '../src/http-server.js';
import { bearerChallenge, insufficientScopeChallenge, OAuthConfigError, oauthConfigFromEnv, protectedResourceMetadata, stepUpScope } from '../src/oauth/config.js';
import { expandScopeSet, KNOWN_SCOPES, parseScopeSet, stepUpScopes, TOOL_SCOPES, type ToolScope } from '../src/oauth/scope.js';
import { isInsufficientScopeChallenge, OAuthUpstreamAuth, ResponseGate, routeScope } from '../src/oauth/upstream.js';
import { createLexServer, NARROWED_INSTRUCTIONS, SERVER_INSTRUCTIONS } from '../src/server.js';
import { selectTools, tools } from '../src/tools.js';
import { clientWith } from './helpers.js';
import { CLIENT_SECRET, RESOURCE, startMockAs, type MockAs } from './oauth-mock.js';

const sorted = (set: Iterable<string>) => [...set].sort();
const WEBHOOK_TOOLS = ['lex_list_webhooks', 'lex_get_webhook', 'lex_create_webhook', 'lex_update_webhook', 'lex_delete_webhook', 'lex_test_webhook'];
const ALL = tools.map((t) => t.name);
const READ_TOOLS = ALL.filter((n) => !WEBHOOK_TOOLS.includes(n));
const NARROW = 'lex lex:read lex:webhooks';
const PRM_URL = 'https://mcp.lex-api.com/.well-known/oauth-protected-resource/v1';
const SECRET32 = 'x'.repeat(32);

describe('scope sets (the same vectors as the API)', () => {
  it('parseScopeSet: the names as written, without repeats; anything unusable is the empty set', () => {
    expect(sorted(parseScopeSet('lex'))).toEqual(['lex']);
    expect(sorted(parseScopeSet('  lex:read\tlex:webhooks \n lex:read '))).toEqual(['lex:read', 'lex:webhooks']);
    for (const bad of [undefined, null, '', '   ', 5, ['lex'], { scope: 'lex' }, 'x'.repeat(501)]) {
      expect(parseScopeSet(bad).size).toBe(0);
    }
  });

  it('expandScopeSet: `lex` is exactly lex:read + lex:webhooks', () => {
    expect(sorted(expandScopeSet('lex'))).toEqual(['lex:read', 'lex:webhooks']);
    expect(sorted(expandScopeSet('lex:read'))).toEqual(['lex:read']);
    expect(sorted(expandScopeSet('lex:webhooks'))).toEqual(['lex:webhooks']);
    expect(sorted(expandScopeSet('lex lex:read'))).toEqual(['lex:read', 'lex:webhooks']);
    expect(sorted(expandScopeSet('lex:read lex:webhooks'))).toEqual(['lex:read', 'lex:webhooks']);
    expect(sorted(expandScopeSet(new Set(['lex:read'])))).toEqual(['lex:read']);
    expect(sorted(expandScopeSet(['lex']))).toEqual(['lex:read', 'lex:webhooks']);
    expect([...TOOL_SCOPES]).toEqual(['lex:read', 'lex:webhooks']);
    expect(Object.isFrozen(TOOL_SCOPES)).toBe(true);
    expect([...KNOWN_SCOPES]).toEqual(['lex', 'lex:read', 'lex:webhooks']);
  });

  it('expandScopeSet fails closed: an unknown name is nothing', () => {
    for (const unknown of ['admin', '*', 'all', 'LEX', 'Lex:Read', 'lex:', 'lex:reads', 'lex:read:all', 'lex:*', 'offline_access',
      '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'lex,lex:read', 'lex;lex:webhooks']) {
      expect([unknown, sorted(expandScopeSet(unknown))]).toEqual([unknown, []]);
    }
    for (const bad of [undefined, null, '', 0, 1, true, {}, { scope: 'lex' }, [['lex']], [5, null], 'lex '.repeat(200), `lex ${'x'.repeat(4096)}`]) {
      expect(expandScopeSet(bad).size).toBe(0);
    }
    // Beside a known name, an unknown one adds nothing and takes nothing away.
    expect(sorted(expandScopeSet('lex:read lex:future offline_access'))).toEqual(['lex:read']);
  });

  it('a step-up asks for what the connection holds plus what the call needs; a webhook tool asks for lex:read as well', () => {
    const both = ['lex:read', 'lex:webhooks'];
    expect(stepUpScopes('lex:read')).toEqual(['lex:read']);
    expect(stepUpScopes('lex:webhooks')).toEqual(both);
    expect(stepUpScopes('lex:read', [])).toEqual(['lex:read']);
    expect(stepUpScopes('lex:read', expandScopeSet('lex:read'))).toEqual(['lex:read']);
    expect(stepUpScopes('lex:read', expandScopeSet('lex:webhooks'))).toEqual(both);
    expect(stepUpScopes('lex:webhooks', expandScopeSet('lex:read'))).toEqual(both);
    expect(stepUpScopes('lex:webhooks', expandScopeSet('lex:webhooks'))).toEqual(both);
    for (const required of TOOL_SCOPES) expect(stepUpScopes(required, expandScopeSet('lex'))).toEqual(both);
  });
});

// ── tool → API route → scope ──────────────────────────────────────────
const ROUTES = (JSON.parse(readFileSync(new URL('./fixtures/api-route-scopes.json', import.meta.url), 'utf8')) as { routes: Array<[string, string, ToolScope | null]> }).routes
  .map(([method, path, scope]) => ({
    key: `${method} ${path}`,
    scope,
    method,
    re: new RegExp(`^${path.replace(/:jurisdiction/g, '[a-z]{2}').replace(/:[A-Za-z]+/g, '[^/]+')}$`),
  }));

/** Arguments that make each tool call every route it can reach. */
const SAMPLES: Record<string, Array<Record<string, unknown>>> = {
  lex_info: [{}],
  lex_check_citation: [
    { identifier: '32016R0679', article: '17' },
    { identifier: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' },
    { identifier: 'AT-BGBLA_2023_I_1' },
  ],
  lex_act_history: [{ celexNumber: '32016R0679', dates: true }],
  lex_research: [{ query: 'data protection', jurisdictions: ['eu', 'at'] }],
  lex_compliance_checklist: [{ topic: 'gdpr', jurisdiction: 'at' }],
  lex_search: [{ query: 'data protection' }],
  lex_recent_documents: [{}],
  lex_resolve: [{ identifier: 'ECLI:EU:C:2014:317' }],
  lex_get_document: [{ celexNumber: '32016R0679' }],
  lex_get_documents_batch: [{ celexNumbers: ['32016R0679', '32018R1725'] }],
  lex_get_metadata: [{ celexNumber: '32016R0679' }],
  lex_get_document_by_url: [{ url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679' }],
  lex_legislation_as_of: [{ document: '32016R0679', asOf: '2019-06-01', provision: 'art_17' }],
  lex_document_versions: [{ celexNumber: '32016R0679' }],
  lex_get_document_version: [{ celexNumber: '32016R0679', version: 1 }, { celexNumber: '32016R0679', date: '2020-01-01' }],
  lex_semantic_legislation: [{ query: 'right to erasure' }],
  lex_semantic_case_law: [{ query: 'right to be forgotten' }],
  lex_national_coverage: [{}],
  lex_list_national_documents: [{ jurisdiction: 'at' }],
  lex_get_national_document: [{ jurisdiction: 'at', id: 'AT-BGBLA_2023_I_1' }],
  lex_national_semantic_case_law: [{ jurisdiction: 'at', query: 'Datenschutz' }],
  lex_national_semantic_legislation: [{ jurisdiction: 'at', query: 'Datenschutz' }],
  lex_cited_by: [{ celexNumber: '32016R0679' }],
  lex_cites: [{ celexNumber: '32016R0679' }],
  lex_citation_network: [{ celexNumber: '32016R0679' }],
  lex_citation_path: [{ from: '32016R0679', to: '32018R1725' }],
  lex_related: [{ celexNumber: '32016R0679' }],
  lex_citation_stats: [{}],
  lex_transposition: [{ celexNumber: '32016L0680' }],
  lex_counterparts: [{ id: '32016L0680' }],
  lex_extract_citations: [{ celexNumber: '32016R0679' }],
  lex_export: [{}],
  lex_list_webhooks: [{}],
  lex_get_webhook: [{ id: 'wh_1' }, { id: 'wh_1', deliveriesLimit: 5 }],
  lex_create_webhook: [{ name: 'n', url: 'https://hooks.example.com/lex', watchCelex: ['32016R0679'] }],
  lex_update_webhook: [{ id: 'wh_1', name: 'n2' }],
  lex_delete_webhook: [{ id: 'wh_1' }],
  lex_test_webhook: [{ id: 'wh_1' }],
};

/** Answers that let multi-call tools go on to their next call. */
function reply(path: string) {
  if (path === '/national/coverage') return { body: { success: true, jurisdictions: [{ code: 'AT', live: true, legislation: true, caseLaw: true }] } };
  if (path === '/resolve') return { body: { success: true, resolved: true, celexNumber: '32016R0679', celex: '32016R0679', type: 'eli' } };
  if (path.startsWith('/citations/cited-by/')) {
    return { body: { success: true, celexNumber: '32016R0679', total: 1, citations: [{ celexNumber: '32018R1725', citationType: 'amendment', title: 't' }], citedBy: [{ celexNumber: '32018R1725', citationType: 'amendment', title: 't' }] } };
  }
  if (path === '/documents/metadata') return { body: { success: true, metadata: { celexNumber: '32016R0679', title: 't', inForce: true } } };
  if (path === '/documentContent') {
    return { body: { success: true, document: { celexNumber: '32016R0679', celex: '32016R0679', title: 't', textAvailability: { available: true }, content: { articles: [{ id: 'art_1', number: 'Article 1', content: 'x' }] } } } };
  }
  return { body: { success: true } };
}

async function routesOf(name: string): Promise<string[]> {
  const tool = tools.find((t) => t.name === name)!;
  const { client, calls } = clientWith((call) => reply(call.url.pathname.replace('/api/v1', '')));
  for (const args of SAMPLES[name] ?? []) {
    try {
      await tool.handler(args, client);
    } catch {
      // A sample answer the tool cannot shape: its requests were recorded.
    }
  }
  return [...new Set(calls.map((c) => {
    const path = c.url.pathname.replace('/api/v1', '');
    const hits = ROUTES.filter((r) => r.method === c.method && r.re.test(path));
    expect(hits.map((r) => r.key), `${name}: ${c.method} ${path}`).toHaveLength(1);
    return hits[0].key;
  }))];
}

describe('each tool declares the scope the API requires for its routes', () => {
  const reached = new Map<string, string[]>();

  it('every tool has samples and a tool scope', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ALL].sort());
    for (const t of tools) expect(TOOL_SCOPES, t.name).toContain(t.scope);
  });

  for (const tool of tools) {
    it(`${tool.name} → ${tool.scope}`, async () => {
      const keys = await routesOf(tool.name);
      reached.set(tool.name, keys);
      expect(keys.length, 'the tool called no route').toBeGreaterThan(0);
      const required = new Set(keys.map((k) => ROUTES.find((r) => r.key === k)!.scope).filter(Boolean));
      // A tool that only reads routes open to everyone is a read tool.
      expect(sorted(required.size ? (required as Set<string>) : ['lex:read'])).toEqual([tool.scope]);
    });
  }

  it('the webhook tools are exactly the tools on /webhooks routes, reads included', () => {
    expect(tools.filter((t) => t.scope === 'lex:webhooks').map((t) => t.name)).toEqual(WEBHOOK_TOOLS);
    expect(tools.filter((t) => t.scope === 'lex:read').map((t) => t.name)).toEqual(READ_TOOLS);
    for (const [name, keys] of reached) {
      expect(keys.some((k) => k.split(' ')[1].startsWith('/webhooks')), name).toBe(WEBHOOK_TOOLS.includes(name));
    }
  });

  it('the samples reach every API route but the one no tool uses', () => {
    const all = new Set([...reached.values()].flat());
    expect(ROUTES.map((r) => r.key).filter((k) => !all.has(k))).toEqual(['POST /parse']);
  });
});

describe('tool selection', () => {
  const names = (scope?: string, readOnly = false) => selectTools({ readOnly, ...(scope === undefined ? {} : { scopes: expandScopeSet(scope) }) }).map((t) => t.name);

  it('by scope', () => {
    expect(names('lex')).toEqual(ALL);
    expect(names('lex:read lex:webhooks')).toEqual(ALL);
    expect(names('lex:read')).toEqual(READ_TOOLS);
    expect(names('lex:webhooks')).toEqual(WEBHOOK_TOOLS);
    expect(names('lex:read lex:future')).toEqual(READ_TOOLS);
    expect(names('admin')).toEqual([]);
    expect(names('')).toEqual([]);
  });

  it('without scopes (an API key) every tool is selected', () => {
    expect(names()).toEqual(ALL);
    expect(selectTools().map((t) => t.name)).toEqual(ALL);
    expect(selectTools({ scopes: undefined }).map((t) => t.name)).toEqual(ALL);
  });

  it('read-only mode and scopes combine', () => {
    const writes = tools.filter((t) => t.write).map((t) => t.name);
    expect(names('lex', true)).toEqual(ALL.filter((n) => !writes.includes(n)));
    expect(names('lex:webhooks', true)).toEqual(['lex_list_webhooks', 'lex_get_webhook']);
  });

  it('without lex:read, lex_create_webhook does not point at lex_info; with it, and for an API key, the description is unchanged', () => {
    const create = (opts: Parameters<typeof selectTools>[0]) => selectTools(opts).find((t) => t.name === 'lex_create_webhook')!.description;
    const full = tools.find((t) => t.name === 'lex_create_webhook')!.description;
    expect(full).toContain('(maxWebhooks in lex_info)');
    expect(create({})).toBe(full);
    expect(create({ scopes: expandScopeSet('lex') })).toBe(full);
    expect(create({ scopes: expandScopeSet('lex:webhooks') })).toBe(full.replace(' (maxWebhooks in lex_info)', ''));
    for (const t of selectTools({ scopes: expandScopeSet('lex:webhooks') })) for (const r of READ_TOOLS) expect(t.description, t.name).not.toContain(r);
  });

  it('what a lex:read connection is shown never names a webhook tool', () => {
    for (const t of selectTools({ scopes: new Set<ToolScope>(['lex:read']) })) {
      const shown = JSON.stringify([t.description, z.toJSONSchema(z.object(t.inputSchema), { io: 'input' })]);
      for (const hidden of WEBHOOK_TOOLS) expect(shown, `${t.name} names ${hidden}`).not.toContain(hidden);
    }
  });

  it('refusedToolCall: single messages and batches; other methods and unknown tools pass', () => {
    const read = expandScopeSet('lex:read');
    const call = (name: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
    expect(refusedToolCall(call('lex_delete_webhook'), tools, read)?.name).toBe('lex_delete_webhook');
    expect(refusedToolCall(call('lex_info'), tools, read)).toBeUndefined();
    expect(refusedToolCall([call('lex_info'), call('lex_list_webhooks')], tools, read)?.name).toBe('lex_list_webhooks');
    expect(refusedToolCall(call('lex_info'), tools, expandScopeSet('lex:webhooks'))?.name).toBe('lex_info');
    expect(refusedToolCall(call('lex_info'), tools, new Set())?.name).toBe('lex_info');
    for (const body of [undefined, null, 5, 'x', [], [null], {}, { method: 'tools/list' }, { method: 'tools/call' }, call('nope'), call(5), call(null), { method: 'tools/call', params: 'lex_delete_webhook' }]) {
      expect(refusedToolCall(body, tools, read)).toBeUndefined();
    }
    for (const t of tools) expect(refusedToolCall(call(t.name), tools, expandScopeSet('lex'))).toBeUndefined();
  });
});

describe('configuration: LEXAPI_OAUTH_SCOPES and LEXAPI_OAUTH_DEFAULT_SCOPE', () => {
  const cfg = (env: Record<string, string> = {}) => oauthConfigFromEnv({ LEXAPI_OAUTH_CLIENT_SECRET: SECRET32, ...env })!;

  it('defaults: the metadata and the challenge are what they were', () => {
    const c = cfg();
    expect(c.scopesSupported).toEqual(['lex']);
    expect(c.defaultScope).toBe('lex');
    expect(JSON.stringify(protectedResourceMetadata(c))).toBe(
      '{"resource":"https://mcp.lex-api.com/v1","authorization_servers":["https://lex-api.com"],"scopes_supported":["lex"],"bearer_methods_supported":["header"],"resource_name":"LexAPI MCP server","resource_documentation":"https://lex-api.com/docs#mcp-oauth"}',
    );
    expect(bearerChallenge(c)).toBe(`Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex"`);
  });

  it('LEXAPI_OAUTH_SCOPES changes scopes_supported and nothing else', () => {
    const before = protectedResourceMetadata(cfg());
    for (const raw of [NARROW, 'lex:webhooks,lex:read, lex', ' lex:read  lex lex:webhooks lex ']) {
      const c = cfg({ LEXAPI_OAUTH_SCOPES: raw });
      expect(protectedResourceMetadata(c)).toEqual({ ...before, scopes_supported: ['lex', 'lex:read', 'lex:webhooks'] });
      expect(Object.keys(protectedResourceMetadata(c))).toEqual(Object.keys(before));
      // The 401 challenge still asks for `lex` unless the default is changed too.
      expect(bearerChallenge(c)).toBe(`Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex"`);
    }
  });

  it('LEXAPI_OAUTH_DEFAULT_SCOPE sets the scope of the 401 challenge', () => {
    const c = cfg({ LEXAPI_OAUTH_SCOPES: NARROW, LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' });
    expect(bearerChallenge(c)).toBe(`Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex:read"`);
    expect(cfg({ LEXAPI_OAUTH_SCOPES: NARROW, LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:webhooks lex:read' }).defaultScope).toBe('lex:read lex:webhooks');
    // Without `lex` among the supported scopes, the default is all of them.
    expect(cfg({ LEXAPI_OAUTH_SCOPES: 'lex:read lex:webhooks' }).defaultScope).toBe('lex:read lex:webhooks');
  });

  it('refuses unknown names, an empty list, a default outside the supported scopes, and either variable without the secret', () => {
    for (const env of [
      { LEXAPI_OAUTH_SCOPES: 'lex admin' },
      { LEXAPI_OAUTH_SCOPES: 'LEX' },
      { LEXAPI_OAUTH_SCOPES: ',' },
      { LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' },
      { LEXAPI_OAUTH_DEFAULT_SCOPE: 'offline_access' },
      { LEXAPI_OAUTH_SCOPES: 'lex:read', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex' },
      // Scopes that do not cover every tool: a challenge could not name what a call needs.
      { LEXAPI_OAUTH_SCOPES: 'lex:read' },
      { LEXAPI_OAUTH_SCOPES: 'lex:webhooks' },
      { LEXAPI_OAUTH_SCOPES: 'lex:read', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' },
      // A default scope without the read tools.
      { LEXAPI_OAUTH_SCOPES: NARROW, LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:webhooks' },
      { LEXAPI_OAUTH_SCOPES: 'lex:read lex:webhooks', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:webhooks' },
      { LEXAPI_OAUTH_SCOPES: 'lex lex:webhooks', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:webhooks' },
    ] as Array<Record<string, string>>) {
      expect(() => cfg(env), JSON.stringify(env)).toThrow(OAuthConfigError);
    }
    expect(() => cfg({ LEXAPI_OAUTH_SCOPES: NARROW, LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:webhooks' })).toThrow('LEXAPI_OAUTH_DEFAULT_SCOPE must include lex or lex:read');
    // A blank value is an unset one.
    expect(cfg({ LEXAPI_OAUTH_SCOPES: '  ', LEXAPI_OAUTH_DEFAULT_SCOPE: ' ' })).toMatchObject({ scopesSupported: ['lex'], defaultScope: 'lex' });
    expect(() => oauthConfigFromEnv({ LEXAPI_OAUTH_SCOPES: 'lex' })).toThrow(/LEXAPI_OAUTH_SCOPES is set but LEXAPI_OAUTH_CLIENT_SECRET is not/);
    expect(() => oauthConfigFromEnv({ LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex' })).toThrow(/LEXAPI_OAUTH_DEFAULT_SCOPE is set but/);
  });

  it('the insufficient_scope challenge names scopes the authorization server accepts', () => {
    const old = cfg();
    const narrow = cfg({ LEXAPI_OAUTH_SCOPES: NARROW });
    expect(() => cfg({ LEXAPI_OAUTH_SCOPES: 'lex:read' })).toThrow('LEXAPI_OAUTH_SCOPES must cover every tool: list lex, or both lex:read and lex:webhooks');
    const read = expandScopeSet('lex:read');
    const hooks = expandScopeSet('lex:webhooks');
    const all = expandScopeSet('lex');
    // Every supported configuration, every held set, every required scope:
    // the challenge names accepted scopes that permit the call and keep what is held.
    const configs = [old, narrow, cfg({ LEXAPI_OAUTH_SCOPES: 'lex lex:read' }), cfg({ LEXAPI_OAUTH_SCOPES: 'lex lex:read', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' }),
      cfg({ LEXAPI_OAUTH_SCOPES: 'lex lex:webhooks' }), cfg({ LEXAPI_OAUTH_SCOPES: 'lex:read lex:webhooks' }), cfg({ LEXAPI_OAUTH_SCOPES: NARROW, LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' })];
    for (const c of configs) {
      for (const held of [new Set<ToolScope>(), read, hooks, all]) {
        for (const required of TOOL_SCOPES) {
          const asked = stepUpScope(c, required, held);
          const label = `${c.scopesSupported.join(' ')} / ${[...held].join(' ')} / ${required}`;
          for (const n of asked.split(' ')) expect(c.scopesSupported, label).toContain(n);
          const permits = expandScopeSet(asked);
          expect(permits.has(required), label).toBe(true);
          for (const h of held) expect(permits.has(h), label).toBe(true);
        }
      }
    }
    expect(stepUpScope(old, 'lex:webhooks', read)).toBe('lex');
    expect(stepUpScope(old, 'lex:read', hooks)).toBe('lex');
    expect(stepUpScope(narrow, 'lex:webhooks', read)).toBe('lex:read lex:webhooks');
    expect(stepUpScope(narrow, 'lex:read', hooks)).toBe('lex:read lex:webhooks');
    expect(stepUpScope(narrow, 'lex:read')).toBe('lex:read');
    // The narrow names are not all accepted: `lex`, never the default scope.
    expect(stepUpScope(cfg({ LEXAPI_OAUTH_SCOPES: 'lex lex:read', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' }), 'lex:webhooks', read)).toBe('lex');
    expect(stepUpScope(cfg({ LEXAPI_OAUTH_SCOPES: 'lex:read lex:webhooks' }), 'lex:read', hooks)).toBe('lex:read lex:webhooks');
    expect(insufficientScopeChallenge(narrow, 'lex_delete_webhook needs the lex:webhooks scope', 'lex:webhooks', read)).toBe(
      `Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex:read lex:webhooks", error="insufficient_scope", error_description="lex_delete_webhook needs the lex:webhooks scope"`,
    );
    expect(insufficientScopeChallenge(old, 'a "quoted"\r\nreason', 'lex:read')).toBe(
      `Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex", error="insufficient_scope", error_description="a  quoted   reason"`,
    );
  });
});

describe('a 403 insufficient_scope from the API', () => {
  const API_READ = 'Bearer realm="lexapi", error="insufficient_scope", scope="lex:read", error_description="The access token does not permit this request"';
  const API_HOOKS = 'Bearer realm="lexapi", error="insufficient_scope", scope="lex:read lex:webhooks", error_description="The access token does not permit this request"';

  it('is recognised by the error parameter of a Bearer challenge, and by nothing else', () => {
    for (const yes of [API_READ, API_HOOKS, 'Bearer error=insufficient_scope', 'bearer  ERROR = "insufficient_scope"', 'Bearer error="insufficient_scope", scope="admin"',
      'Bearer realm="a, b", error_description="say \\"hi\\", ok", error="insufficient_scope"', 'Bearer realm=lexapi,error=insufficient_scope,scope="lex"']) {
      expect(isInsufficientScopeChallenge(yes), yes).toBe(true);
    }
    for (const no of [null, '', 'Bearer', 'Bearer realm="lexapi"', 'Bearer realm="lexapi", error="invalid_token"', 'Basic realm="x", error="insufficient_scope"',
      'Bearer error="insufficient_scopes"', 'Bearer error=insufficient_scopes', 'Bearer error="not_insufficient_scope"', 'Bearer xerror="insufficient_scope"',
      'Bearer error_description="error=insufficient_scope"', 'Bearer realm="lexapi", error_description="x, error=\\"insufficient_scope\\""',
      'Bearer error="invalid_token", error_description="was error=insufficient_scope"', 'Bearer error="invalid_token", error="insufficient_scope"',
      'Bearer error="Insufficient_Scope"', 'error="insufficient_scope"', 'XBearer error="insufficient_scope"', 'x Bearer error="insufficient_scope"',
      'Bearer error=', 'Bearer error= , error="insufficient_scope"', 'Bearer realm=, error="insufficient_scope"', 'Bearer realm= ,error=insufficient_scope', `Bearer realm="${'x'.repeat(1000)}", error="insufficient_scope"`, 'Bearer realm="unterminated, error="insufficient_scope']) {
      expect(isInsufficientScopeChallenge(no), String(no)).toBe(false);
    }
  });

  it('a crafted header is answered at once', () => {
    for (const www of [`Bearer a=${' '.repeat(100_000)}"`, `Bearer a=${' '.repeat(900)}"`, `Bearer ${'a= '.repeat(300)}"`, `Bearer a="${'\\\\'.repeat(450)}`, `Bearer${' '.repeat(100_000)}`]) {
      const t0 = performance.now();
      expect(isInsufficientScopeChallenge(www)).toBe(false);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it('the scope reported is the one the called route requires, whatever the header names', () => {
    expect(routeScope('/webhooks')).toBe('lex:webhooks');
    expect(routeScope('/webhooks/wh_1/deliveries')).toBe('lex:webhooks');
    for (const path of ['/info', '/search', '/webhooksx', '/at/documents/webhooks', '/citations/extract']) expect(routeScope(path)).toBe('lex:read');
    const required = (www: string, path: string) => (new OAuthUpstreamAuth('t', 0, {} as never).onForbidden({ wwwAuthenticate: www, path }) as UpstreamAuthError).requiredScope;
    for (const scope of ['lex', 'lex:read', 'lex:read lex:webhooks', 'admin', '']) {
      const www = `Bearer realm="lexapi", error="insufficient_scope", scope="${scope}"`;
      expect(required(www, '/info'), scope).toBe('lex:read');
      expect(required(www, '/webhooks/wh_1'), scope).toBe('lex:webhooks');
    }
  });

  it('fails the call with the scope, and reaches the response gate', () => {
    const gate = new ResponseGate();
    const auth = new OAuthUpstreamAuth('t', 0, {} as never, gate);
    expect(auth.onForbidden({ wwwAuthenticate: null, path: '/webhooks' })).toBeUndefined();
    expect(auth.onForbidden({ wwwAuthenticate: 'Bearer realm="lexapi"', path: '/webhooks' })).toBeUndefined();
    expect(gate.failure).toBeUndefined();
    const e = auth.onForbidden({ wwwAuthenticate: API_HOOKS, path: '/webhooks' }) as UpstreamAuthError;
    expect(e).toBeInstanceOf(UpstreamAuthError);
    expect(e).toMatchObject({ kind: 'insufficient_scope', httpStatus: 403, requiredScope: 'lex:webhooks', description: 'required scope: lex:webhooks' });
    expect(gate.failure).toBe(e);
    expect(describeError(e)).toBe('This LexAPI connection is not permitted to do this (required scope: lex:webhooks). Reconnecting LexAPI in the MCP client and allowing that access adds it; retrying with the same sign-in does not.');
  });

  it('an API key sees the ordinary 403', async () => {
    const { client } = clientWith(() => ({ status: 403, body: { success: false, error: { code: 'TIER_FORBIDDEN', message: 'no' } }, headers: { 'www-authenticate': API_HOOKS } }));
    await expect(client.listWebhooks()).rejects.toMatchObject({ name: 'LexAPIError', status: 403, code: 'TIER_FORBIDDEN' });
  });
});

// ── over HTTP, against the mock authorization server and API ──────────
let as: MockAs;
const servers: Server[] = [];
const logSpies: Array<ReturnType<typeof vi.spyOn>> = [];
const KEY = `lex_test_${'ab'.repeat(32)}`;

async function start(extraEnv: Record<string, string> = {}, opts: { oauthOff?: boolean } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/.test(as.apiBase)) throw new Error('the API base must be the local mock');
  const env: NodeJS.ProcessEnv = {
    LEXAPI_BASE_URL: as.apiBase,
    ...(opts.oauthOff ? {} : { LEXAPI_OAUTH_CLIENT_SECRET: CLIENT_SECRET, LEXAPI_OAUTH_ISSUER: as.issuer }),
    ...extraEnv,
  };
  const http = createHttpServer({ env });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  servers.push(http);
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

async function rpc(base: string, headers: Record<string, string>, method: string, params: unknown = {}, raw?: unknown) {
  const r = await fetch(`${base}/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(raw ?? { jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  const data = text.match(/^data: (.*)$/m);
  let json: any;
  try { json = JSON.parse(data ? data[1] : text); } catch { json = undefined; }
  return { status: r.status, headers: r.headers, text, json };
}

const bearer = (scope: unknown, sub = 'scoped') => ({ authorization: `Bearer ${as.mint({ sub, claims: { scope } })}` });
const listed = async (base: string, headers: Record<string, string>) => (await rpc(base, headers, 'tools/list')).json.result.tools.map((t: { name: string }) => t.name) as string[];
const call = (base: string, headers: Record<string, string>, name: string, args: unknown = {}) => rpc(base, headers, 'tools/call', { name, arguments: args });
const upstreamSince = (n: number) => as.seen.slice(n).filter((s) => s.path.startsWith('/api/v1/') || s.path === '/oauth/token');
const challenge = (scope: string, description: string) => `Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="${scope}", error="insufficient_scope", error_description="${description}"`;

beforeAll(async () => {
  as = await startMockAs();
  for (const m of ['error', 'warn', 'log'] as const) logSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
});

afterAll(async () => {
  for (const s of logSpies) s.mockRestore();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  await as.close();
});

describe('OAuth connections over HTTP', () => {
  it('scope `lex` (every token issued so far): every tool is listed and callable', async () => {
    const base = await start();
    const auth = bearer('lex');
    expect(await listed(base, auth)).toEqual(ALL);
    const info = await call(base, auth, 'lex_info');
    expect(info.status).toBe(200);
    expect(info.json.result.isError).toBeUndefined();
    const hooks = await call(base, auth, 'lex_list_webhooks');
    expect(hooks.status).toBe(200);
    expect(JSON.parse(hooks.json.result.content[0].text)).toEqual({ count: 0, webhooks: [] });
  });

  it('`lex:read lex:webhooks` is the same as `lex`', async () => {
    const base = await start();
    const auth = bearer('lex:read lex:webhooks');
    expect(await listed(base, auth)).toEqual(ALL);
    expect((await call(base, auth, 'lex_info')).json.result.isError).toBeUndefined();
    expect((await call(base, auth, 'lex_list_webhooks')).json.result.isError).toBeUndefined();
  });

  it('`lex:read`: the read tools; a webhook tool is refused with 403 insufficient_scope before anything is sent upstream', async () => {
    const base = await start();
    const auth = bearer('lex:read');
    expect(await listed(base, auth)).toEqual(READ_TOOLS);
    expect((await call(base, auth, 'lex_info')).json.result.isError).toBeUndefined();
    for (const name of WEBHOOK_TOOLS) {
      const before = as.seen.length;
      const r = await call(base, auth, name, { id: 'wh_1' });
      expect(r.status, name).toBe(403);
      expect(r.headers.get('www-authenticate')).toBe(challenge('lex', `${name} needs the lex:webhooks scope`));
      expect(r.headers.get('access-control-expose-headers')).toMatch(/WWW-Authenticate/);
      expect(r.json).toEqual({ error: 'insufficient_scope', error_description: `${name} needs the lex:webhooks scope`, scope: 'lex' });
      expect(upstreamSince(before)).toEqual([]);
    }
  });

  it('`lex:webhooks`: only the webhook tools; a read tool is refused', async () => {
    const base = await start();
    const auth = bearer('lex:webhooks');
    expect(await listed(base, auth)).toEqual(WEBHOOK_TOOLS);
    expect((await call(base, auth, 'lex_list_webhooks')).json.result.isError).toBeUndefined();
    const before = as.seen.length;
    const r = await call(base, auth, 'lex_info');
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toBe(challenge('lex', 'lex_info needs the lex:read scope'));
    expect(upstreamSince(before)).toEqual([]);
  });

  it('with the narrow scopes configured, the challenge names them', async () => {
    const base = await start({ LEXAPI_OAUTH_SCOPES: NARROW });
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/v1`)).json();
    expect(prm).toEqual({
      resource: RESOURCE,
      authorization_servers: [as.issuer],
      scopes_supported: ['lex', 'lex:read', 'lex:webhooks'],
      bearer_methods_supported: ['header'],
      resource_name: 'LexAPI MCP server',
      resource_documentation: 'https://lex-api.com/docs#mcp-oauth',
    });
    const keyless = await rpc(base, {}, 'tools/list');
    expect(keyless.status).toBe(401);
    expect(keyless.headers.get('www-authenticate')).toBe(`Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex"`);
    const hook = await call(base, bearer('lex:read'), 'lex_delete_webhook', { id: 'wh_1' });
    expect(hook.status).toBe(403);
    expect(hook.headers.get('www-authenticate')).toBe(challenge('lex:read lex:webhooks', 'lex_delete_webhook needs the lex:webhooks scope'));
    expect(hook.json.scope).toBe('lex:read lex:webhooks');
    const read = await call(base, bearer('lex:webhooks'), 'lex_search', { query: 'x' });
    // A step-up keeps what the connection holds.
    expect(read.headers.get('www-authenticate')).toBe(challenge('lex:read lex:webhooks', 'lex_search needs the lex:read scope'));
  });

  it('scopes that are not all accepted: the challenge asks for lex, not for the default scope', async () => {
    const base = await start({ LEXAPI_OAUTH_SCOPES: 'lex lex:read', LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' });
    const keyless = await rpc(base, {}, 'tools/list');
    expect(keyless.headers.get('www-authenticate')).toBe(`Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex:read"`);
    const hook = await call(base, bearer('lex:read'), 'lex_delete_webhook', { id: 'wh_1' });
    expect(hook.status).toBe(403);
    expect(hook.headers.get('www-authenticate')).toBe(challenge('lex', 'lex_delete_webhook needs the lex:webhooks scope'));
  });

  it('a narrowed connection is told so in the instructions, without tool names; a full one and an API key are not', async () => {
    const base = await start();
    const instructions = async (headers: Record<string, string>) => (await rpc(base, headers, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json.result.instructions;
    expect(NARROWED_INSTRUCTIONS).toBe('Some LexAPI features are not enabled on this connection; reconnect to grant them.');
    expect(await instructions(bearer('lex'))).toBe(SERVER_INSTRUCTIONS);
    expect(await instructions(bearer('lex:read lex:webhooks'))).toBe(SERVER_INSTRUCTIONS);
    expect(await instructions({ 'x-api-key': KEY })).toBe(SERVER_INSTRUCTIONS);
    for (const scope of ['lex:read', 'lex:webhooks']) expect(await instructions(bearer(scope))).toBe(`${SERVER_INSTRUCTIONS}\n\n${NARROWED_INSTRUCTIONS}`);
  });

  it('a batch with one refused call is refused as a whole', async () => {
    const base = await start();
    const before = as.seen.length;
    const r = await rpc(base, bearer('lex:read'), '', {}, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lex_info', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lex_test_webhook', arguments: { id: 'wh_1' } } },
    ]);
    expect(r.status).toBe(403);
    expect(upstreamSince(before)).toEqual([]);
  });

  it('unknown names beside a known one are ignored; repeats and extra white space are tolerated', async () => {
    const base = await start();
    expect(await listed(base, bearer('lex:read lex:future offline_access'))).toEqual(READ_TOOLS);
    expect(await listed(base, bearer('offline_access lex'))).toEqual(ALL);
    expect(await listed(base, bearer('lex:read  lex:read'))).toEqual(READ_TOOLS);
    expect(await listed(base, bearer('  lex:read\tlex:webhooks \n lex:read '))).toEqual(ALL);
  });

  it('no recognised scope fails closed: 401, nothing listed, nothing sent upstream', async () => {
    const base = await start();
    for (const scope of ['admin', '', '   ', 'LEX', 'Lex:Read', 'lex:', 'lex:*', '*', 'lexx', 'lex,lex:read', 'offline_access',
      'lex '.repeat(200), `lex ${'x'.repeat(4096)}`, 5, ['lex'], { lex: true }, null, true]) {
      const before = as.seen.length;
      const auth = bearer(scope);
      for (const r of [await rpc(base, auth, 'tools/list'), await call(base, auth, 'lex_info'), await call(base, auth, 'lex_list_webhooks')]) {
        expect(r.status, JSON.stringify(scope).slice(0, 40)).toBe(401);
        expect(r.headers.get('www-authenticate')).toBe(`Bearer realm="lexapi", resource_metadata="${PRM_URL}", scope="lex", error="invalid_token", error_description="insufficient scope"`);
        expect(r.json.result).toBeUndefined();
      }
      expect(upstreamSince(before)).toEqual([]);
    }
  });

  it('a connection narrower than its token: the API\'s 403 insufficient_scope is passed on', async () => {
    const base = await start({ LEXAPI_OAUTH_SCOPES: NARROW });
    const auth = bearer('lex', 'narrowed');
    as.grants.get('grant_narrowed')!.scope = 'lex:read';
    expect(await listed(base, auth)).toEqual(ALL);
    expect((await call(base, auth, 'lex_info')).json.result.isError).toBeUndefined();
    const r = await call(base, auth, 'lex_list_webhooks');
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toBe(challenge('lex:read lex:webhooks', 'required scope: lex:webhooks'));
    expect(r.json).toEqual({ error: 'insufficient_scope', error_description: 'required scope: lex:webhooks', scope: 'lex:read lex:webhooks' });
  });
});

describe('a refusal by the API keeps the scopes the token holds', () => {
  it('token `lex:read lex:webhooks`, connection without lex:read: the challenge for a read tool asks for both', async () => {
    const base = await start({ LEXAPI_OAUTH_SCOPES: NARROW });
    const auth = bearer('lex:read lex:webhooks', 'hooksonly');
    as.grants.get('grant_hooksonly')!.scope = 'lex:webhooks';
    expect((await call(base, auth, 'lex_list_webhooks')).json.result.isError).toBeUndefined();
    const r = await call(base, auth, 'lex_info');
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toBe(challenge('lex:read lex:webhooks', 'required scope: lex:read'));
    expect(r.json).toEqual({ error: 'insufficient_scope', error_description: 'required scope: lex:read', scope: 'lex:read lex:webhooks' });
  });
});

describe('API keys are not subject to scopes', () => {
  it('hosted server, OAuth on, any scope configuration: every tool is listed and a webhook tool is callable', async () => {
    for (const env of [{}, { LEXAPI_OAUTH_SCOPES: NARROW, LEXAPI_OAUTH_DEFAULT_SCOPE: 'lex:read' }] as Array<Record<string, string>>) {
      const base = await start(env);
      for (const headers of [{ 'x-api-key': KEY }, { authorization: `Bearer ${KEY}` }] as Array<Record<string, string>>) {
        expect(await listed(base, headers)).toEqual(ALL);
        const before = as.seen.length;
        const hooks = await call(base, headers, 'lex_list_webhooks');
        expect(hooks.status).toBe(200);
        expect(JSON.parse(hooks.json.result.content[0].text)).toEqual({ count: 0, webhooks: [] });
        expect((await call(base, headers, 'lex_info')).json.result.isError).toBeUndefined();
        const sent = as.seen.slice(before);
        expect(sent.map((s) => s.path)).toEqual(['/api/v1/webhooks', '/api/v1/info']);
        for (const s of sent) expect(s.apiKey).toBe(KEY);
      }
    }
  });

  it('hosted server, OAuth off: every tool, as before', async () => {
    const base = await start({}, { oauthOff: true });
    expect(await listed(base, { 'x-api-key': KEY })).toEqual(ALL);
    expect((await call(base, { 'x-api-key': KEY }, 'lex_list_webhooks')).json.result.isError).toBeUndefined();
  });

  it('stdio (createLexServer without scopes): every tool, and a webhook tool is callable', async () => {
    const server = createLexServer(new LexAPIClient({ apiKey: KEY, baseUrl: as.apiBase }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(ALL);
    const r = await client.callTool({ name: 'lex_list_webhooks', arguments: {} });
    expect(r.isError).toBeUndefined();
    await client.close();
    await server.close();
  });
});
