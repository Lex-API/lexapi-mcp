#!/usr/bin/env node
import { createHttpServer } from './http-server.js';

const portEnv = process.env.PORT ?? '3000';
const port = Number.parseInt(portEnv, 10);
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  console.error(`[lexapi-mcp] invalid PORT: ${portEnv}`);
  process.exit(1);
}

let server: ReturnType<typeof createHttpServer>;
try {
  server = createHttpServer();
} catch (err) {
  // A half-configured OAuth env (a short secret, OAuth variables without the
  // secret, an API base off the issuer's origin …) must fail the deploy, not
  // silently run without sign-in. The message never contains the secret.
  console.error(`[lexapi-mcp] invalid configuration: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
}

server.listen(port, () => {
  const o = server.oauth?.cfg;
  console.error(`[lexapi-mcp] HTTP transport listening on :${port} (POST ${o?.resourcePath ?? '/v1'}, GET /health) · auth: API keys${o ? ` + OAuth (issuer ${o.issuer}, resource ${o.resource}, client ${o.clientId}, API ${o.apiBase})` : ' only (OAuth off: LEXAPI_OAUTH_CLIENT_SECRET not set)'}`);
  if (o) {
    console.error(`[lexapi-mcp] OAuth: client address for per-IP limits = ${server.clientAddressMode}${o.trustProxyHops ? '' : ' — behind a reverse proxy that is the proxy for everyone; set LEXAPI_MCP_TRUST_PROXY_HOPS (verify with the /health operator view)'}`);
    console.error(`[lexapi-mcp] OAuth: at most ${o.exchangesPerUserPerMin} new token exchanges per user a minute (LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN)`);
  }
  const healthToken = Boolean(process.env.LEXAPI_MCP_HEALTH_TOKEN?.trim());
  console.error(`[lexapi-mcp] /health operator view: ${!healthToken ? 'off (set LEXAPI_MCP_HEALTH_TOKEN to enable)' : o ? 'on (LEXAPI_MCP_HEALTH_TOKEN)' : 'nothing to show (LEXAPI_MCP_HEALTH_TOKEN set, OAuth off)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`[lexapi-mcp] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
