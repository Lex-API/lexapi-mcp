// Client-side mirror of the DNS-free half of LexAPI's webhook egress guard
// (eurlex-parser server/utils/safeOutboundUrl.js, checkUrlSyntax). Defence in
// depth only: the API is authoritative and also checks every resolved
// address at send time. This lets a model hear "not allowed" before a call
// instead of after one.
import { isIP } from 'node:net';

const MAX_URL_LENGTH = 2048;
const HTTPS_PORTS = [443, 8443];

// Internal by construction (RFC 6761/6762/8375, cloud internal zones, LAN
// suffixes, reserved TLDs) — the same list the API uses.
const INTERNAL_SUFFIXES = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home', 'corp',
  'intranet', 'private', 'arpa', 'test', 'invalid', 'example', 'onion',
];

// IANA IPv4 special-purpose ranges (+ multicast / reserved).
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(a: string): number {
  return a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

export function isPublicIPv4(a: string): boolean {
  const ip = v4ToInt(a);
  for (const [base, bits] of BLOCKED_V4) {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    if (ip >= start && ip < start + size) return false;
  }
  return true;
}

/** Expand an IPv6 literal (as normalised by the WHATWG URL parser) into 8 16-bit groups. */
function v6Groups(a: string): number[] | null {
  let text = a;
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const o = v4[2].split('.').map(Number);
    text = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((g) => Number.parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(fill).fill(0), ...tail];
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : groups;
}

export function isPublicIPv6(a: string): boolean {
  const g = v6Groups(a);
  if (!g) return false;
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::/96 (NAT64) reach an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIPv4(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIPv4(embeddedV4());
  if ((g[0] & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF protocol assignments
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4
  if ((g[0] & 0xfff0) === 0x3ff0) return false; // 3fff::/20 documentation
  return true;
}

/** null when the URL passes every DNS-free rule; otherwise why it is refused. */
export function webhookUrlProblem(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Webhook URL must be a non-empty string';
  if (raw.length > MAX_URL_LENGTH) return `Webhook URL must be at most ${MAX_URL_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'Webhook URL is not a valid absolute URL';
  }
  if (url.protocol !== 'https:') return `Webhook URL must use https (got "${url.protocol.replace(/:$/, '')}")`;
  if (url.username || url.password) return 'Webhook URL must not contain credentials (user:password@)';
  const port = url.port ? Number(url.port) : 443;
  if (!HTTPS_PORTS.includes(port)) return `Webhook URL port ${port} is not allowed; use 443 or 8443`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return 'Webhook URL has no hostname';
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPublicIPv4(host) ? null : `Webhook URL points to a non-public address (${host})`;
  if (ipVersion === 6) return isPublicIPv6(host) ? null : `Webhook URL points to a non-public address (${host})`;
  if (!host.includes('.')) return `"${host}" is a single-label hostname; use a fully-qualified public domain name`;
  const tld = host.split('.').pop() as string;
  if (INTERNAL_SUFFIXES.includes(tld)) return `"${host}" is an internal or reserved hostname`;
  if (/^[0-9]+$/.test(tld) || /^0x[0-9a-f]*$/i.test(tld)) return `"${host}" is not a valid public hostname`;
  return null;
}
