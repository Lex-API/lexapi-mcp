#!/usr/bin/env node
import { createHttpServer } from './http-server.js';

const portEnv = process.env.PORT ?? '3000';
const port = Number.parseInt(portEnv, 10);
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  console.error(`[lexapi-mcp] invalid PORT: ${portEnv}`);
  process.exit(1);
}

const server = createHttpServer();

server.listen(port, () => {
  console.error(`[lexapi-mcp] HTTP transport listening on :${port} (POST /v1, GET /health)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`[lexapi-mcp] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
