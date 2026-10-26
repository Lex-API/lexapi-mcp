import { describe, expect, it } from 'vitest';

import { LexAPIError, describeError, parseErrorBody } from '../src/errors.js';

describe('parseErrorBody', () => {
  it('reads the typed envelope', () => {
    const p = parseErrorBody(
      { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted', details: { weight: 5 } } },
      '',
      402,
    );
    expect(p).toEqual({ code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted', details: { weight: 5 }, retryAfter: undefined });
  });

  it('reads the legacy flat shape', () => {
    const p = parseErrorBody({ error: 'Invalid search parameters', details: ['At least one filter is required'] }, '', 400);
    expect(p.code).toBe('Invalid search parameters');
    expect(p.details).toEqual(['At least one filter is required']);
    const q = parseErrorBody({ error: 'Rate limit exceeded', message: 'up to 15 per minute', retryAfter: 30 }, '', 429);
    expect(q.message).toBe('Rate limit exceeded: up to 15 per minute');
    expect(q.retryAfter).toBe(30);
  });

  it('falls back to the status for non-JSON bodies (e.g. a proxy page)', () => {
    const p = parseErrorBody(undefined, '<html>Bad gateway</html>', 502);
    expect(p.code).toBe('HTTP_502');
    expect(p.message).toContain('Bad gateway');
  });
});

describe('describeError — actionable messages', () => {
  it('402 says what was needed, what is left, when it resets, and what to do', () => {
    const text = describeError(new LexAPIError(402, 'CREDITS_EXHAUSTED', 'Credit pool exhausted', {
      operation: 'semantic_case_law', weight: 5, available: 2, resetsAt: '2026-11-01T00:00:00.000Z',
    }));
    expect(text).toContain('needs 5 credits');
    expect(text).toContain('2 are available');
    expect(text).toContain('2026-11-01T00:00:00.000Z');
    expect(text).toMatch(/top-up/);
    expect(text).toMatch(/do not retry/);
  });

  it('429 carries the wait', () => {
    expect(describeError(new LexAPIError(429, 'Rate limit exceeded', 'Rate limit exceeded', undefined, 42))).toContain('Wait 42 s');
  });

  it('401 points to the key configuration', () => {
    expect(describeError(new LexAPIError(401, 'Invalid API key', 'Invalid API key'))).toMatch(/LEXAPI_API_KEY/);
  });

  it('400 includes validation details', () => {
    const t = describeError(new LexAPIError(400, 'Invalid webhook matching rules', 'Invalid webhook matching rules', ['author "ema" never matches']));
    expect(t).toContain('author "ema" never matches');
  });

  it('403, 404, 504 and 5xx have guidance', () => {
    expect(describeError(new LexAPIError(403, 'TIER_FORBIDDEN', 'x'))).toMatch(/plan/);
    expect(describeError(new LexAPIError(404, 'NOT_FOUND', 'x'))).toMatch(/lex_resolve/);
    expect(describeError(new LexAPIError(504, 'TIMEOUT', 'x'))).toMatch(/Retry-safe/);
    expect(describeError(new LexAPIError(500, 'INTERNAL', 'x'))).toMatch(/refunded/);
  });
});
