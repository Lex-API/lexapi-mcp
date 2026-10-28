// Validates server.json against the constraints of the schema it declares
// ($schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json),
// so a regression like the one review round 2 found (description over the
// registry's 100-character limit — `mcp-publisher publish` would reject it)
// fails CI instead of being caught by a human reviewer reading the file.
//
// This is a local, hand-maintained mirror of the fields that have actually
// bitten us, not the full JSON Schema (fetching it live would make this test
// network-dependent and flaky in CI). Confirmed against the schema's
// `ServerDetail` / `Package` definitions on 2026-10-28; re-check this file
// against the live schema URL above if `$schema` is ever bumped to a newer
// dated version.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

const serverDetailSchema = z.object({
  $schema: z.string().url(),
  // Reverse-DNS: exactly one '/' separating namespace from server name.
  name: z.string().min(3).max(200).regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
  title: z.string().optional(),
  // The field this round's release blocker was about.
  description: z.string().min(1).max(100),
  websiteUrl: z.string().url().optional(),
  repository: z
    .object({
      url: z.string().url(),
      source: z.string(),
    })
    .optional(),
  version: z.string().max(255),
  packages: z
    .array(
      z.object({
        registryType: z.string(),
        registryBaseUrl: z.string().url().optional(),
        identifier: z.string(),
        // Must be a specific version — ranges and "latest" are rejected.
        version: z
          .string()
          .min(1)
          .refine((v) => v !== 'latest', '"latest" is not a specific version')
          .refine((v) => !/^[\^~]|[x*]$|^>=|^<=/.test(v), 'version ranges are rejected'),
        transport: z.object({ type: z.string() }),
      }),
    )
    .optional(),
  remotes: z
    .array(
      z.object({
        type: z.string(),
        url: z.string().url(),
      }),
    )
    .optional(),
});

describe('server.json (MCP registry manifest)', () => {
  const raw = readFileSync(join(here, '..', 'server.json'), 'utf8');
  const serverJson = JSON.parse(raw);

  it('validates against the mirrored server.schema.json constraints', () => {
    const result = serverDetailSchema.safeParse(serverJson);
    if (!result.success) {
      throw new Error(`server.json failed validation: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
  });

  it('description is at or under the registry\'s 100-character limit (the release blocker this test exists for)', () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    expect(serverJson.description.length).toBeGreaterThan(0);
  });

  it('package.json and the npm package entry carry the same version', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(serverJson.version).toBe(pkg.version);
    const npmPackage = serverJson.packages?.find((p: { registryType: string }) => p.registryType === 'npm');
    expect(npmPackage?.version).toBe(pkg.version);
  });
});
