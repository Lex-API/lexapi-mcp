// OpenAI domain verification with sign-in on and off: the challenge path is
// public (no credential, no outbound request) and is answered before the
// Origin check; without the variable it is an ordinary unknown path.
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer, OPENAI_CHALLENGE_PATH } from '../src/http-server.js';

const TOKEN = 'challenge-value-oauth-1';
const OAUTH_ENV = { LEXAPI_OAUTH_CLIENT_SECRET: 'test-client-secret-0123456789abcdef0123456789' };
const FOREIGN_ORIGIN = 'https://not-listed.example';

const servers: Array<ReturnType<typeof createHttpServer>> = [];

async function start(env: NodeJS.ProcessEnv) {
  const outbound = vi.fn(async () => { throw new Error('no outbound request expected'); });
  const server = createHttpServer({ env, fetch: outbound as unknown as typeof fetch });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, outbound, server };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('OpenAI domain verification with OAuth on', () => {
  it('serves the token without a credential and without any outbound request', async () => {
    const { base, outbound, server } = await start({ ...OAUTH_ENV, LEXAPI_MCP_OPENAI_CHALLENGE: TOKEN });
    expect(server.oauth).not.toBeNull();
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(await r.text()).toBe(TOKEN);
    const head = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(TOKEN.length));
    expect(head.headers.get('www-authenticate')).toBeNull();
    expect(await head.text()).toBe('');
    expect(outbound).not.toHaveBeenCalled();
  });

  it('without the variable the path is a generic JSON 404', async () => {
    const { base, outbound } = await start({ ...OAUTH_ENV });
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect((await r.json()).error.code).toBe('not_found');
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe.each([
  ['API keys only', {}],
  ['OAuth on', OAUTH_ENV],
])('OpenAI domain verification and the Origin check (%s)', (_mode, modeEnv) => {
  it('with the token set, the path answers before the Origin check', async () => {
    const { base } = await start({ ...modeEnv, LEXAPI_MCP_OPENAI_CHALLENGE: TOKEN });
    const headers = { origin: FOREIGN_ORIGIN };
    expect((await fetch(`${base}/health`, { headers })).status).toBe(403);
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`, { headers });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(await r.text()).toBe(TOKEN);
  });

  it('with the variable unset, the same request reaches the Origin check', async () => {
    const { base } = await start({ ...modeEnv });
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`, { headers: { origin: FOREIGN_ORIGIN } });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('origin_not_allowed');
  });
});
