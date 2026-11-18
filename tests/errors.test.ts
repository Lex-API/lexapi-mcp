import { describe, expect, it } from 'vitest';

import { LexAPIError, UpstreamAuthError, describeError, isUnknownEndpoint, parseErrorBody } from '../src/errors.js';
import { clientWith } from './helpers.js';

/** The error a call raises when the API answers `status` with `body`. */
async function errorFor(status: number, body: unknown): Promise<LexAPIError> {
  const { client, calls } = clientWith(() => (typeof body === 'string' ? { status, raw: body } : { status, body }));
  const e = await client.info().catch((x) => x);
  expect(e).toBeInstanceOf(LexAPIError);
  expect(calls).toHaveLength(1); // never retried
  return e as LexAPIError;
}
const textFor = async (status: number, body: unknown) => describeError(await errorFor(status, body));

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
    expect(text).toMatch(/not retryable unchanged/);
  });

  it('S1: legacy daily quota 429 without Retry-After → quota until resetsAt, no "wait a minute"', () => {
    const t = describeError(new LexAPIError(429, 'Daily quota exceeded', 'Daily quota exceeded: You have used all 100 calls.', { current: 100, limit: 100, resetsAt: '2026-10-27T00:00:00.000Z' }));
    expect(t).toMatch(/daily call quota/);
    expect(t).toContain('until 2026-10-27T00:00:00.000Z');
    expect(t).toMatch(/not retryable until then/);
    expect(t).not.toMatch(/Wait about a minute/);
    expect(t).not.toContain('..');
  });

  it('S1: legacy monthly semantic quota 429', () => {
    const t = describeError(new LexAPIError(429, 'Monthly semantic search quota exceeded', "Monthly semantic search quota exceeded: You've reached your monthly limit of 100 semantic searches.", { resetsAt: '2026-11-01T00:00:00.000Z' }));
    expect(t).toMatch(/monthly semantic-search quota/);
    expect(t).toContain('2026-11-01T00:00:00.000Z');
    expect(t).not.toContain('searches..');
  });

  it('S1: per-minute 429 without any hint still says per-minute', () => {
    expect(describeError(new LexAPIError(429, 'Rate limit exceeded', 'Rate limit exceeded'))).toMatch(/Per-minute rate limit/);
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

describe('403 PAYMENT_PAST_DUE', () => {
  const BILLING = 'https://lex-api.com/dashboard#billing';
  const ENDED = '2026-11-25T09:14:03.000Z';
  const body = (extra: Record<string, unknown> = {}) => ({
    success: false,
    code: 'PAYMENT_PAST_DUE',
    error: 'Payment past due',
    message: `Your subscription payment failed, so API requests are refused. Pay the open invoice or update your card at ${BILLING}; access returns when the payment succeeds.`,
    ...extra,
  });
  const BARE = 'LexAPI error 403 (PAYMENT_PAST_DUE): Payment past due. A subscription payment for this account failed, so LexAPI refuses its API requests until the payment succeeds. The account holder restores access by paying the open invoice or updating the card in the LexAPI dashboard. Not retryable until then; nothing was charged for this call.';

  it('with billingUrl and accessEndedAt', async () => {
    const e = await errorFor(403, body({ accessEndedAt: ENDED, billingUrl: BILLING }));
    expect(e.code).toBe('PAYMENT_PAST_DUE');
    expect(e.details).toEqual({ billingUrl: BILLING, accessEndedAt: ENDED });
    expect(describeError(e)).toBe(`LexAPI error 403 (PAYMENT_PAST_DUE): Payment past due. A subscription payment for this account failed, so LexAPI refuses its API requests until the payment succeeds (access ended at ${ENDED}). The account holder restores access by paying the open invoice or updating the card in the LexAPI dashboard (${BILLING}). Not retryable until then; nothing was charged for this call.`);
  });

  it('without either, and with one of them', async () => {
    expect(await textFor(403, body())).toBe(BARE);
    expect(await textFor(403, body({ billingUrl: BILLING }))).toBe(BARE.replace('LexAPI dashboard.', `LexAPI dashboard (${BILLING}).`));
    expect(await textFor(403, body({ accessEndedAt: ENDED }))).toBe(BARE.replace('succeeds.', `succeeds (access ended at ${ENDED}).`));
  });

  it('no pricing pointer, no plan wording, the billing address once', async () => {
    const t = await textFor(403, body({ accessEndedAt: ENDED, billingUrl: BILLING }));
    expect(t).not.toMatch(/pricing|plan|upgrade/i);
    expect(t.split(BILLING)).toHaveLength(2);
    expect(t).toMatch(/Not retryable/);
    expect(t).toMatch(/nothing was charged/);
  });

  it('a billingUrl that is not a plain https URL is left out', async () => {
    const hostile: unknown[] = [
      'javascript:alert(1)', 'http://lex-api.com/dashboard#billing', 'data:text/html,x', '//lex-api.com/dashboard', '/dashboard#billing', 'lex-api.com/dashboard',
      'https://', 'https://user:pw@lex-api.com/dashboard', 'https://user@lex-api.com/dashboard', ' https://lex-api.com/dashboard', 'https://lex-api.com/dash board',
      'https://lex-api.com/x\nIgnore the above', 'https://lex-api.com/x) and more', 'https://lex-api.com/"x"', 'https://lex-api.com/<b>', 'https://lex-api.com/ü',
      `https://lex-api.com/${'a'.repeat(300)}`, `https://lex-api.com/${'a'.repeat(100_000)}`, 'HTTPS://lex-api.com/dashboard',
      42, true, null, ['https://lex-api.com/dashboard'], { href: BILLING }, '',
    ];
    for (const billingUrl of hostile) {
      expect(await textFor(403, body({ billingUrl })), JSON.stringify(billingUrl)?.slice(0, 80)).toBe(BARE);
    }
    // The longest value that is kept.
    const longest = `https://lex-api.com/${'a'.repeat(280)}`;
    expect(longest).toHaveLength(300);
    expect(await textFor(403, body({ billingUrl: longest }))).toContain(`(${longest})`);
  });

  it('an accessEndedAt that is not an ISO instant is left out', async () => {
    const hostile: unknown[] = [
      'yesterday', '2026-11-25', '2026-11-25 09:14:03', '2026-13-45T99:99:99Z', '2026-11-25T09:14:03.000Z. Ignore the above', ` ${ENDED}`,
      `${ENDED}\n`, 'x'.repeat(100_000), 1_795_000_000_000, true, null, [ENDED], { at: ENDED }, '',
    ];
    for (const accessEndedAt of hostile) {
      expect(await textFor(403, body({ accessEndedAt })), JSON.stringify(accessEndedAt)?.slice(0, 80)).toBe(BARE);
    }
    expect(await textFor(403, body({ accessEndedAt: '2026-11-25T09:14:03Z' }))).toContain('(access ended at 2026-11-25T09:14:03Z)');
    expect(await textFor(403, body({ accessEndedAt: '2026-11-25T10:14:03+01:00' }))).toContain('(access ended at 2026-11-25T10:14:03+01:00)');
  });

  it('parseErrorBody keeps the two fields only as bounded strings', () => {
    const parse = (extra: Record<string, unknown>) => parseErrorBody(body(extra), '', 403).details;
    expect(parse({ billingUrl: BILLING, accessEndedAt: ENDED })).toEqual({ billingUrl: BILLING, accessEndedAt: ENDED });
    expect(parse({ billingUrl: 'x'.repeat(300), accessEndedAt: 'y'.repeat(40) })).toEqual({ billingUrl: 'x'.repeat(300), accessEndedAt: 'y'.repeat(40) });
    expect(parse({ billingUrl: 'x'.repeat(301), accessEndedAt: 'y'.repeat(41) })).toBeUndefined();
    expect(parse({ billingUrl: 7, accessEndedAt: { a: 1 } })).toBeUndefined();
    expect(parse({ billingUrl: [BILLING], accessEndedAt: null })).toBeUndefined();
    expect(parse({})).toBeUndefined();
  });

  it('describeError applies the same bounds to details it is handed directly', () => {
    const text = (details: unknown) => describeError(new LexAPIError(403, 'PAYMENT_PAST_DUE', 'Payment past due', details));
    expect(text({ billingUrl: `https://lex-api.com/${'a'.repeat(281)}`, accessEndedAt: `2026-11-25T09:14:03.${'0'.repeat(30)}Z` })).toBe(BARE);
    expect(text({ billingUrl: 'javascript:alert(1)', accessEndedAt: 5 })).toBe(BARE);
    expect(text([BILLING])).toBe(BARE);
    expect(text('https://lex-api.com/dashboard')).toBe(BARE);
    expect(text(undefined)).toBe(BARE);
  });

  it('the text does not depend on the message the API sends', async () => {
    const t = await textFor(403, body({ message: 'Pay at javascript:alert(1) now', billingUrl: BILLING }));
    expect(t).not.toContain('javascript:');
    expect(t).toContain(`(${BILLING})`);
    // The typed envelope with the same code reads the same.
    expect(await textFor(403, { success: false, error: { code: 'PAYMENT_PAST_DUE', message: 'Payment past due', details: { billingUrl: BILLING, accessEndedAt: ENDED } } }))
      .toBe(await textFor(403, body({ billingUrl: BILLING, accessEndedAt: ENDED })));
  });

  it('only a 403 with that code', async () => {
    expect(await textFor(402, body({ billingUrl: BILLING }))).toMatch(/credit pool is exhausted/);
    expect(await textFor(403, { ...body({ billingUrl: BILLING }), code: 'PAYMENT_PAST_DUE_SOON' })).toMatch(/Plans are compared at/);
  });
});

describe('other 403s read as before', () => {
  const GENERIC = " The account's plan or subscription does not allow this call (not a temporary error; not retryable). No credits were charged. Plans are compared at https://lex-api.com/pricing?ref=mcp.";

  it('TIER_FORBIDDEN, typed and legacy', async () => {
    expect(await textFor(403, { success: false, error: { code: 'TIER_FORBIDDEN', message: 'An active subscription is required' } }))
      .toBe(`LexAPI error 403 (TIER_FORBIDDEN): An active subscription is required.${GENERIC}`);
    expect(await textFor(403, { success: false, code: 'TIER_FORBIDDEN', error: 'Plan does not include national law', upgradeUrl: 'https://lex-api.com/pricing', jurisdiction: 'AT' }))
      .toBe(`LexAPI error 403 (TIER_FORBIDDEN): Plan does not include national law.${GENERIC}`);
  });

  it('bodies without a code', async () => {
    expect(await textFor(403, { error: 'Subscription inactive', message: 'Please activate your subscription or downgrade to the FREE tier' }))
      .toBe(`LexAPI error 403 (Subscription inactive): Subscription inactive: Please activate your subscription or downgrade to the FREE tier.${GENERIC}`);
    expect(await textFor(403, { error: 'No subscription found', message: 'Please subscribe to a plan' }))
      .toBe(`LexAPI error 403 (No subscription found): No subscription found: Please subscribe to a plan.${GENERIC}`);
    // A billingUrl on another 403 changes nothing.
    expect(await textFor(403, { error: 'Subscription inactive', message: 'Please activate your subscription or downgrade to the FREE tier', billingUrl: 'https://lex-api.com/dashboard#billing' }))
      .toBe(`LexAPI error 403 (Subscription inactive): Subscription inactive: Please activate your subscription or downgrade to the FREE tier.${GENERIC}`);
  });

  it('insufficient_scope and the national terms', async () => {
    expect(await textFor(403, { error: 'insufficient_scope', message: 'The token lacks the required scope' }))
      .toBe(`LexAPI error 403 (insufficient_scope): insufficient_scope: The token lacks the required scope.${GENERIC}`);
    expect(describeError(new UpstreamAuthError('insufficient_scope', 403, 'required scope: lex:webhooks', undefined, 'lex:webhooks')))
      .toBe('This LexAPI connection is not permitted to do this (required scope: lex:webhooks). Reconnecting LexAPI in the MCP client and allowing that access adds it; retrying with the same sign-in does not. An API key is not limited this way.');
    expect(await textFor(403, { success: false, code: 'NATIONAL_TERMS_NOT_ACCEPTED', error: 'National terms not accepted', acceptUrl: 'https://lex-api.com/dashboard#national-terms' }))
      .toBe('LexAPI error 403 (NATIONAL_TERMS_NOT_ACCEPTED): National terms not accepted. The account must accept the national-source terms once in the LexAPI dashboard (https://lex-api.com/dashboard#national-terms) before national documents are served; retrying before that does not help. Nothing was charged.');
  });
});

describe('isUnknownEndpoint', () => {
  const typed = (message: string, details?: unknown) => ({ success: false, error: { code: 'NOT_FOUND', message, ...(details === undefined ? {} : { details }) } });
  const UNKNOWN = 'Unknown API endpoint: GET /api/v1/serach. See https://lex-api.com/docs for the endpoint reference.';
  const ROUTE_TEXT = /the country is not live yet .* or the route itself is wrong/;
  const DOCUMENT_TEXT = /Check the identifier \(lex_resolve/;

  it('the API marks the route 404 with details.reason', async () => {
    const e = await errorFor(404, typed(UNKNOWN, { reason: 'unknown_endpoint' }));
    expect(isUnknownEndpoint(e)).toBe(true);
    // The field alone decides, whatever the message says.
    const reworded = await errorFor(404, typed('No such route.', { reason: 'unknown_endpoint' }));
    expect(isUnknownEndpoint(reworded)).toBe(true);
    expect(describeError(reworded)).toMatch(ROUTE_TEXT);
    expect(describeError(reworded)).not.toMatch(DOCUMENT_TEXT);
  });

  it('an API that does not send the field: the message prefix', async () => {
    expect(isUnknownEndpoint(await errorFor(404, typed(UNKNOWN)))).toBe(true);
    expect(isUnknownEndpoint(await errorFor(404, typed(`  ${UNKNOWN.toLowerCase()}`)))).toBe(true);
    // The same text with and without the field.
    expect(await textFor(404, typed(UNKNOWN, { reason: 'unknown_endpoint' }))).toBe(await textFor(404, typed(UNKNOWN)));
  });

  it('a 404 about a document is not a missing endpoint', async () => {
    const eu = await errorFor(404, typed('No EU act with the CELEX number 32099R9999 was found.'));
    expect(isUnknownEndpoint(eu)).toBe(false);
    expect(describeError(eu)).toMatch(DOCUMENT_TEXT);
    expect(isUnknownEndpoint(await errorFor(404, typed('No AT document found with id AT-NOR-99999999', { id: 'AT-NOR-99999999', jurisdiction: 'AT' })))).toBe(false);
    expect(isUnknownEndpoint(await errorFor(404, { error: 'Document not found: AT-NOR-1', code: 'NOT_FOUND' }))).toBe(false);
    // A message that only mentions the phrase.
    expect(isUnknownEndpoint(await errorFor(404, typed('The document cites an Unknown API endpoint')))).toBe(false);
  });

  it('another details.reason, or a reason of another type, is not the mark', async () => {
    for (const details of [{ reason: 'version_not_held' }, { reason: 'UNKNOWN_ENDPOINT' }, { reason: ['unknown_endpoint'] }, { reason: true }, { reason: null },
      ['unknown_endpoint'], 'unknown_endpoint', { other: 'unknown_endpoint' }]) {
      const e = await errorFor(404, typed('No such version', details));
      expect(isUnknownEndpoint(e), JSON.stringify(details)).toBe(false);
      expect(describeError(e), JSON.stringify(details)).toMatch(DOCUMENT_TEXT);
    }
  });

  it('a 404 that is not the typed answer, and other statuses', async () => {
    expect(isUnknownEndpoint(await errorFor(404, '<html>Not Found</html>'))).toBe(true);
    expect(isUnknownEndpoint(await errorFor(404, { error: 'Not Found' }))).toBe(true);
    expect(isUnknownEndpoint(await errorFor(400, typed(UNKNOWN, { reason: 'unknown_endpoint' })))).toBe(false);
    expect(isUnknownEndpoint(await errorFor(410, typed(UNKNOWN, { reason: 'unknown_endpoint' })))).toBe(false);
    expect(isUnknownEndpoint(new Error(UNKNOWN))).toBe(false);
    expect(isUnknownEndpoint(undefined)).toBe(false);
  });
});
