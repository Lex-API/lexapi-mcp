// Export failure endings (SDK contract §1.8, lex-api #303) and the
// QUOTA_EXHAUSTED code (§1.2/§1.3, lex-api #304).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeError, LexAPIError, parseErrorBody } from '../src/errors.js';
import { runTool } from '../src/server.js';
import { tools, type ToolDef } from '../src/tools.js';
import { clientWith, parseText } from './helpers.js';

const exportTool = tools.find((t) => t.name === 'lex_export') as ToolDef;

async function runExport(lines: unknown[]) {
  const parsed = z.object(exportTool.inputSchema).parse({});
  const { client } = clientWith(() => ({
    raw: lines.map((l) => JSON.stringify(l)).join('\n'),
    headers: { 'content-type': 'application/x-ndjson' },
  }));
  return runTool(exportTool, parsed, client);
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? '';

describe('lex_export failure endings', () => {
  it('an _error line then a complete:false _done is an incomplete export, not a result', async () => {
    const result = await runExport([
      { _meta: {} }, { celex: 'A' }, { celex: 'B' },
      { _error: { code: 'INTERNAL', message: 'x' } },
      { _done: { written: 2, complete: false } },
    ]);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/lex_export is incomplete: the server reported an error mid-stream \(INTERNAL: x\) after 2 row\(s\)/);
    expect(text(result)).not.toContain('"rows"');
  });

  it('a _done with complete:false alone is incomplete', async () => {
    const result = await runExport([{ _meta: {} }, { celex: 'A' }, { _done: { written: 1, complete: false } }]);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/complete: false after 1 row/);
  });

  it('a stream without its _done trailer is incomplete', async () => {
    const result = await runExport([{ _meta: {} }, { celex: 'A' }, { celex: 'B' }]);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/ended without its completion trailer after 2 row/);
  });

  it('an _error line without a _done is incomplete and never a row', async () => {
    const result = await runExport([{ _meta: {} }, { celex: 'A' }, { _error: { code: 'INTERNAL', message: 'x' } }]);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/after 1 row/);
  });

  it('a complete stream with the new _done fields is returned', async () => {
    const result = await runExport([
      { _meta: { totalMatching: 3 } }, { celex: 'A' }, { celex: 'B' },
      { _done: { written: 2, complete: true, truncated: false, truncatedBy: null, skippedStubs: 1, credits: { reserved: 3, charged: 2, refunded: 1 } } },
    ]);
    expect(result.isError).toBeUndefined();
    const data = parseText(result);
    expect(data.returned).toBe(2);
    expect(data.skippedStubs).toBe(1);
  });
});

const QUOTA_BODY = {
  success: false,
  code: 'QUOTA_EXHAUSTED',
  error: 'Daily quota exceeded',
  message: "You've reached your daily limit of 1000 API calls. Resets at midnight UTC.",
  resetsAt: '2026-10-27T00:00:00.000Z',
  usage: { current: 1000, limit: 1000, resetsAt: '2026-10-27T00:00:00.000Z', unit: 'calls' },
};

describe('QUOTA_EXHAUSTED and top-level codes', () => {
  it('parseErrorBody: a top-level code beats the legacy error text; resetsAt from the body', () => {
    const p = parseErrorBody(QUOTA_BODY, JSON.stringify(QUOTA_BODY), 429);
    expect(p.code).toBe('QUOTA_EXHAUSTED');
    expect(p.message).toMatch(/^Daily quota exceeded: /);
    expect(p.resetsAt).toBe('2026-10-27T00:00:00.000Z');
    expect(parseErrorBody({ ...QUOTA_BODY, resetsAt: '2026-11-01T00:00:00.000Z' }, '', 429).resetsAt).toBe('2026-11-01T00:00:00.000Z');
    // Older servers: no code — the legacy behaviour is kept.
    expect(parseErrorBody({ error: 'Daily quota exceeded' }, '', 429).code).toBe('Daily quota exceeded');
  });

  it('a QUOTA_EXHAUSTED 429 is never retried, even with a short Retry-After, and carries no retry-after', async () => {
    const { client, calls, sleeps } = clientWith(() => ({ status: 429, body: QUOTA_BODY, headers: { 'retry-after': '1' } }), { maxRetries: 2 });
    const err = await client.info().catch((e: unknown) => e) as LexAPIError;
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.resetsAt).toBe('2026-10-27T00:00:00.000Z');
    const t = describeError(err);
    expect(t).toContain('exhausted until 2026-10-27T00:00:00.000Z — do not retry, tell the user');
    expect(t).toMatch(/daily call quota/);
    expect(t).not.toMatch(/Per-minute/);
  });

  it('a RATE_LIMITED 429 with a short Retry-After is still retried', async () => {
    const { client, calls } = clientWith((_c, n) =>
      n === 1
        ? { status: 429, body: { success: false, code: 'RATE_LIMITED', error: 'Rate limit exceeded', retryAfter: 1 }, headers: { 'retry-after': '1' } }
        : { body: { ok: true } }, { maxRetries: 2 });
    await client.info();
    expect(calls).toHaveLength(2);
  });
});
