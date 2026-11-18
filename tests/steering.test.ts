import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeError, LexAPIError, LexAPITransportError, UpstreamAuthError, type UpstreamAuthKind } from '../src/errors.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';
import { asOfCaveat, consolidatedLabel } from '../src/shape.js';
import { tools } from '../src/tools.js';

const STEERING = /\b(tell the user|ask the user|show it to the user|say so|confirm with the user|you must|call this (first|before)|always call|check lex_national_coverage first|do not retry|do not present|do not quote|never present|drop it)\b/i;

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Non-comment lines of a source file: the strings a model can receive. */
function codeLines(file: string): string[] {
  return readFileSync(join(srcDir, file), 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
}

function paramDescriptions(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => paramDescriptions(s, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      else paramDescriptions(v, out);
    }
  }
  return out;
}

describe('model-facing text describes behaviour and does not steer the model', () => {
  it('tool descriptions', () => {
    for (const t of tools) expect(t.description, t.name).not.toMatch(STEERING);
  });

  it('parameter descriptions', () => {
    for (const t of tools) {
      const schema = z.toJSONSchema(z.object(t.inputSchema), { io: 'input' });
      for (const d of paramDescriptions(schema)) expect(d, t.name).not.toMatch(STEERING);
    }
  });

  it('server instructions', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(STEERING);
  });

  it('error texts', () => {
    const statuses = [400, 401, 402, 403, 404, 409, 410, 422, 429, 500, 502, 503, 504];
    const codes = ['X', 'CREDITS_EXHAUSTED', 'NATIONAL_ALLOWANCE_EXHAUSTED', 'NATIONAL_TERMS_NOT_ACCEPTED', 'NATIONAL_SEMANTIC_NOT_ENABLED',
      'NATIONAL_SEMANTIC_UNAVAILABLE', 'NATIONAL_SEMANTIC_FILTER_UNREACHABLE', 'TIMEOUT', 'QUOTA_EXHAUSTED', 'DOCUMENT_WITHDRAWN', 'ENDPOINT_NOT_AVAILABLE'];
    const details = [undefined, { jurisdiction: 'AT', partialReason: 'SEARCH_INCOMPLETE', resetsAt: '2026-12-01T00:00:00Z', limit: 10, id: 'AT-NOR-1' }];
    for (const status of statuses) {
      for (const code of codes) {
        for (const d of details) {
          for (const wait of [undefined, 5]) {
            expect(describeError(new LexAPIError(status, code, 'x', d, wait)), `${status} ${code}`).not.toMatch(STEERING);
          }
        }
      }
    }
    const kinds: UpstreamAuthKind[] = ['invalid_token', 'config', 'client_auth', 'unavailable', 'rate_limited', 'upstream', 'api_rejected'];
    for (const k of kinds) expect(describeError(new UpstreamAuthError(k, 401, 'x')), k).not.toMatch(STEERING);
    for (const e of [new LexAPITransportError('x', true), new LexAPITransportError('x', false), new LexAPITransportError('x', false, true)]) {
      expect(describeError(e)).not.toMatch(STEERING);
    }
  });

  it('shape notes', () => {
    const caveat = asOfCaveat([
      { law_id: 'A', asOfResolved: false, asOfReason: 'not_yet_adopted' },
      { law_id: 'B', asOfResolved: false, asOfReason: 'fetch_pending' },
      { law_id: 'C', asOfResolved: false, asOfReason: 'insufficient_credits' },
      { law_id: 'D', asOfResolved: false, asOfReason: 'article_not_in_version' },
    ], '2019-06-01');
    expect(JSON.stringify(caveat)).not.toMatch(STEERING);
    expect(JSON.stringify(consolidatedLabel('02016R0679-20180524'))).not.toMatch(STEERING);
  });

  it('no string in the source steers the model', () => {
    for (const file of ['tools.ts', 'workflows.ts', 'shape.ts', 'errors.ts', 'server.ts']) {
      for (const line of codeLines(file)) expect(line, file).not.toMatch(STEERING);
    }
  });
});
