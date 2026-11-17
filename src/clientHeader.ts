// The X-LexAPI-Client request header: which client made an API request.
//
//   lexapi-mcp/<version>[; mode=hosted|stdio][; tool=<tool name>][; app=<name>[/<version>]]
//
// LexAPI reads it for usage statistics only. It ignores the whole value when
// it is longer than 256 characters, is not printable ASCII or contains a
// comma, so every part is checked here before it is sent.
import { PACKAGE_VERSION } from './version.js';

export const CLIENT_HEADER = 'x-lexapi-client';

/** How the server is run: the HTTP entry (hosted) or the stdio entry. */
export type ClientMode = 'hosted' | 'stdio';

/** The MCP client's `clientInfo` from the initialize handshake. Untrusted. */
export interface ClientApp {
  name?: unknown;
  version?: unknown;
}

export interface ClientHeaderParts {
  mode?: ClientMode;
  /** The MCP tool being executed. */
  tool?: string;
  /** Sent in stdio mode only. */
  app?: ClientApp;
}

const CLIENT_NAME = 'lexapi-mcp';
const MAX_HEADER = 256;
const MAX_APP = 64;
const MAX_APP_VERSION = 24;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,23}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Letters, digits, spaces and `._()+-` of a client-supplied string, at most `max` characters. */
function label(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Cut first, so a very long value costs nothing.
  return value.slice(0, max * 4)
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/[^A-Za-z0-9 ._()+-]/g, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** `name[/version]` of the MCP client, at most 64 characters; '' without a usable name. */
function appLabel(app: ClientApp | undefined): string {
  if (!app || typeof app !== 'object') return '';
  const version = label(app.version, MAX_APP_VERSION);
  const name = label(app.name, MAX_APP - (version ? version.length + 1 : 0));
  if (!name) return '';
  return version ? `${name}/${version}` : name;
}

/**
 * The header value for one request, or undefined when the package version
 * is not one the header can carry (it is cut to 24 characters, never
 * rewritten). A part that is not valid is left out; never throws.
 */
export function clientHeaderValue(parts: ClientHeaderParts = {}, version: string = PACKAGE_VERSION): string | undefined {
  const v = String(version).slice(0, 24);
  if (!VERSION_RE.test(v)) return undefined;
  let value = `${CLIENT_NAME}/${v}`;
  try {
    if (parts.mode === 'hosted' || parts.mode === 'stdio') value += `; mode=${parts.mode}`;
    if (typeof parts.tool === 'string' && TOOL_RE.test(parts.tool)) value += `; tool=${parts.tool}`;
    // The hosted server does not name the connecting client: on the OAuth
    // path LexAPI knows it from the connection, and on the API-key path it
    // is not sent at all.
    const app = parts.mode === 'stdio' ? appLabel(parts.app) : '';
    // The app is the only part that is dropped for length.
    if (app && value.length + '; app='.length + app.length <= MAX_HEADER) value += `; app=${app}`;
  } catch {
    // A part that could not be read is left out.
  }
  return value;
}
