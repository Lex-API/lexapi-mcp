// OpenAI domain verification: /.well-known/openai-apps-challenge serves the
// configured token as plain text, and nothing when it is not configured.
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpServer, OPENAI_CHALLENGE_PATH } from '../src/http-server.js';

const servers: Array<ReturnType<typeof createHttpServer>> = [];

async function start(env: NodeJS.ProcessEnv): Promise<string> {
  const server = createHttpServer({ env, oauth: null });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('OpenAI domain verification', () => {
  it('the path is the documented one', () => {
    expect(OPENAI_CHALLENGE_PATH).toBe('/.well-known/openai-apps-challenge');
  });

  it('serves exactly the token as plain text', async () => {
    const base = await start({ LEXAPI_MCP_OPENAI_CHALLENGE: '  tok_abc-123.XYZ \n' });
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-length')).toBe('15');
    expect(await r.text()).toBe('tok_abc-123.XYZ');
    // A query string does not change the answer; a browser Origin is not needed and not refused.
    const q = await fetch(`${base}${OPENAI_CHALLENGE_PATH}?x=1`, { headers: { origin: 'https://example.com' } });
    expect(q.status).toBe(200);
    expect(await q.text()).toBe('tok_abc-123.XYZ');
  });

  it('HEAD answers 200 without a body', async () => {
    const base = await start({ LEXAPI_MCP_OPENAI_CHALLENGE: 'tok' });
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('3');
    expect(await r.text()).toBe('');
  });

  it.each([
    ['unset', {}],
    ['empty', { LEXAPI_MCP_OPENAI_CHALLENGE: '' }],
    ['whitespace only', { LEXAPI_MCP_OPENAI_CHALLENGE: '  \n' }],
  ])('404 when the variable is %s', async (_name, env) => {
    const base = await start(env);
    const r = await fetch(`${base}${OPENAI_CHALLENGE_PATH}`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe('application/json');
  });

  it('other methods and neighbouring paths are not served', async () => {
    const base = await start({ LEXAPI_MCP_OPENAI_CHALLENGE: 'challenge-value-1' });
    expect((await fetch(`${base}${OPENAI_CHALLENGE_PATH}`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}${OPENAI_CHALLENGE_PATH}/`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/openai-apps-challenge.txt`)).status).toBe(404);
    const health = await fetch(`${base}/health`).then((x) => x.text());
    expect(health).not.toContain('challenge-value-1');
  });
});
