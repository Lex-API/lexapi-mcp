// OAuth scopes of a LexAPI connection.
//
//   lex:read      every read tool
//   lex:webhooks  the webhook tools (listing and reading them too)
//   lex           both of the above, and only those two
//
// A name this code does not know permits nothing: it is dropped, it never
// widens the set, and it does not affect the known names beside it. Scopes
// apply to OAuth access tokens only; an API key is not subject to them.

export const SCOPE_ALL = 'lex';
export const SCOPE_READ = 'lex:read';
export const SCOPE_WEBHOOKS = 'lex:webhooks';

/** The scopes a tool can require. */
export const TOOL_SCOPES = Object.freeze([SCOPE_READ, SCOPE_WEBHOOKS] as const);
export type ToolScope = (typeof TOOL_SCOPES)[number];

/** Every scope name that can appear in metadata or a challenge. */
export const KNOWN_SCOPES = Object.freeze([SCOPE_ALL, SCOPE_READ, SCOPE_WEBHOOKS] as const);

const TOOL_SCOPE_SET: ReadonlySet<string> = new Set(TOOL_SCOPES);
const MAX_SCOPE_LENGTH = 500;

export function isToolScope(name: unknown): name is ToolScope {
  return typeof name === 'string' && TOOL_SCOPE_SET.has(name);
}

/** A scope string → the names in it, as written. Anything that is not a usable string is the empty set. */
export function parseScopeSet(raw: unknown): Set<string> {
  if (typeof raw !== 'string' || raw.length > MAX_SCOPE_LENGTH) return new Set();
  return new Set(raw.split(/\s+/).filter(Boolean));
}

/**
 * The tool scopes a scope permits: `lex` becomes its two members, a tool
 * scope stays itself, every other name is dropped. Takes a scope string or
 * a collection of names.
 */
export function expandScopeSet(scope: unknown): Set<ToolScope> {
  const out = new Set<ToolScope>();
  let names: unknown[];
  if (typeof scope === 'string' || scope === undefined || scope === null) {
    names = [...parseScopeSet(scope)];
  } else {
    try {
      names = [...(scope as Iterable<unknown>)];
    } catch {
      return out;
    }
  }
  for (const name of names) {
    if (name === SCOPE_ALL) {
      for (const member of TOOL_SCOPES) out.add(member);
    } else if (isToolScope(name)) {
      out.add(name);
    }
  }
  return out;
}

/**
 * The scopes a client is asked for when a call needs `required` and the
 * connection holds `granted`: what it holds plus what the call needs, in a
 * fixed order. A webhook tool names lex:read as well, since a connection
 * that manages webhooks holds both.
 */
export function stepUpScopes(required: ToolScope, granted: Iterable<ToolScope> = []): ToolScope[] {
  const wanted = new Set<ToolScope>(granted);
  wanted.add(required);
  if (required === SCOPE_WEBHOOKS) wanted.add(SCOPE_READ);
  return TOOL_SCOPES.filter((n) => wanted.has(n));
}
