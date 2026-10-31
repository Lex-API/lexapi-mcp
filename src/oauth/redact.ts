// Credential scrubbing for anything that is logged or shown: JWT-shaped
// strings, LexAPI API keys, opaque `lx…_` credential handles and explicitly
// named secrets are replaced before the text leaves
// the process.

const JWT_RE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const API_KEY_RE = /\blex_[A-Za-z0-9_]{8,}/g;
const HANDLE_RE = /\blx[a-z]{1,4}_[A-Za-z0-9_-]{8,}/g;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const BEARER_RE = /\bBearer\s+[^\s"',;]{8,}/gi;

export function redact(text: string, secrets: Array<string | undefined> = []): string {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(BASIC_RE, 'Basic [redacted]')
    .replace(JWT_RE, '[token]')
    .replace(API_KEY_RE, '[key]')
    .replace(HANDLE_RE, '[token]')
    .slice(0, 300);
}
