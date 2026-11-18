// lex_legislation_as_of against a local stand-in for POST /legislation/as-of.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { LexAPIClient } from '../src/client.js';
import { expandScopeSet } from '../src/oauth/scope.js';
import { createLexServer, runTool, SERVER_INSTRUCTIONS } from '../src/server.js';
import { AS_OF_PROVISION_BUDGET, asOfLookupCaveat, shapeAsOfLookup } from '../src/shape.js';
import { inputSchemaOf, selectTools, tools } from '../src/tools.js';
import { clientWith, parseText, type Call } from './helpers.js';

const NAME = 'lex_legislation_as_of';
const tool = tools.find((t) => t.name === NAME)!;
const TODAY = new Date().toISOString().slice(0, 10);
const LEAK = 'TEXT-THAT-MUST-NOT-BE-RETURNED';

// Every asOfReason of the endpoint, with the class the result reports.
const REASONS: Record<string, 'notInForce' | 'retryable' | 'needsCredits' | 'unavailable'> = {
  not_yet_adopted: 'notInForce', not_yet_in_force: 'notInForce', no_longer_in_force: 'notInForce',
  in_force_dates_unknown: 'unavailable',
  act_type_not_supported: 'unavailable',
  version_list_unavailable: 'retryable', version_lookup_cap: 'retryable',
  not_in_language: 'unavailable',
  amendment_not_consolidated: 'unavailable',
  text_unavailable: 'unavailable', article_not_in_version: 'unavailable', provision_ambiguous: 'unavailable', version_not_parsed: 'unavailable',
  fetch_budget_exhausted: 'retryable', fetch_pending: 'retryable', fetch_capacity: 'retryable', fetch_failed: 'retryable', fetch_timeout: 'retryable', request_deadline: 'retryable',
  insufficient_credits: 'needsCredits', credit_check_failed: 'retryable',
};
// Reasons reached after the version was settled: the answer names it.
const WITH_VERSION = new Set([
  'text_unavailable', 'article_not_in_version', 'provision_ambiguous', 'version_not_parsed',
  'fetch_budget_exhausted', 'fetch_pending', 'fetch_capacity', 'fetch_failed', 'fetch_timeout', 'request_deadline',
  'insufficient_credits', 'credit_check_failed',
]);

// ── The stand-in ──────────────────────────────────────────────────────
// GDPR (32016R0679) with one consolidated version; `provision: "why_<reason>"`
// is not a provision the API accepts, so the stand-in reads it as "answer
// with that reason"; `leak` makes an unresolved answer carry a text.
const USE_RESOLVE = 'For an ELI, an ECLI or a URL, call POST /api/v1/resolve first and send the CELEX number it returns.';
const err = (status: number, code: string, message: string) => ({ status, body: { success: false, error: { code, message } } });
const VERSION = { celex: '02016R0679-20160504', kind: 'consolidated', date: '2016-05-04', validUntil: '2030-12-31', checkedAt: '2026-11-18T04:43:00.000Z' };
const ACT = { celex: '32016R0679', dateOfDocument: '2016-04-27', entryIntoForce: '2016-05-24', inForceToday: true };
const provenance = (celex: string, language: string, hasText: boolean) => ({
  publisher: 'Publications Office of the European Union',
  sourceUrl: `https://eur-lex.europa.eu/legal-content/${language.toUpperCase()}/${hasText ? 'TXT/HTML' : 'ALL'}/?uri=CELEX:${celex}`,
  sourceIdentifier: celex, retrievedAt: null, contentHash: null, versionIdentifier: celex, language, licence: 'EUR-Lex legal notice',
});

interface StandIn { leak?: boolean; credits?: Record<string, unknown>; text?: string }

function asOfApi(opts: StandIn = {}) {
  return (call: Call) => {
    const path = call.url.pathname;
    if (call.method !== 'POST' || path !== '/api/v1/legislation/as-of') {
      return err(404, 'NOT_FOUND', `Unknown API endpoint: ${call.method} ${path}. See https://lex-api.com/docs for the endpoint reference.`);
    }
    const b = (call.body ?? {}) as Record<string, unknown>;
    if (b.document === undefined || b.document === '') return err(400, 'INVALID_PARAMS', 'document is required: the CELEX number of an EU act, e.g. "32016R0679".');
    let document = String(b.document).trim().toUpperCase();
    if (/^(HTTPS?:|WWW\.)|\/\/|^ELI[/:]|^ECLI:/.test(document)) return err(400, 'INVALID_CELEX', `document must be a CELEX number, not an ELI, an ECLI or a URL. ${USE_RESOLVE}`);
    if (document.startsWith('6')) return err(400, 'INVALID_CELEX', `"${document}" is case law. This endpoint covers EU legislation only.`);
    const cons = /^0(\d{4}[A-Z]\d{4})-\d{8}$/.exec(document);
    if (cons) document = `3${cons[1]}`;
    if (b.asOf === undefined || b.asOf === '') return err(400, 'INVALID_PARAMS', 'asOf is required: a date in YYYY-MM-DD form');
    const asOf = String(b.asOf);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return err(400, 'INVALID_PARAMS', 'asOf must be a date in YYYY-MM-DD form');
    if (asOf > TODAY) return err(400, 'INVALID_PARAMS', 'asOf cannot be in the future');
    const language = b.language === undefined ? 'en' : String(b.language);
    if (!/^[a-z]{2}$/.test(language)) return err(400, 'INVALID_PARAMS', 'language must be one of: en, fr, de');
    const raw = b.provision === undefined ? undefined : String(b.provision).trim();
    const forced = raw && /^why_/.test(raw) ? raw.slice(4) : undefined;
    let provision: string | undefined;
    if (raw && !forced) {
      const art = /^(?:art_|article )?(\d{1,4}[a-z]{0,3})$/i.exec(raw);
      const other = /^(?:anx_[IVXLC]+[a-z]?|anx_[A-Z]|rct_\d+(?:-\d+)?)$/.exec(raw);
      if (art) provision = `art_${art[1].toLowerCase()}`;
      else if (other) provision = raw;
      else return err(400, 'INVALID_PARAMS', 'Only whole articles, annexes and recitals are addressable: send "art_17", not a paragraph or point of it.');
    }
    if (document === '32099R9999') return err(404, 'NOT_FOUND', `No EU act with the CELEX number ${document} was found. ${USE_RESOLVE}`);

    const envelope = { credits: opts.credits ?? { remaining: 29_000, limit: 30_000, operation_weight: 1 }, usage: { tier: 'STARTER' } };
    const unresolved = (reason: string, act: Record<string, unknown>, version?: Record<string, unknown>) => ({
      body: {
        success: true, document, language, asOf, asOfResolved: false, asOfReason: reason,
        ...(version ? { asOfVersion: version } : {}),
        act,
        ...(opts.leak ? { provision: { id: 'art_17', number: 'Article 17', text: LEAK }, consolidated: true, consolidatedNote: LEAK } : {}),
        provenance: provenance(version ? String(version.celex) : document, language, false),
        ...envelope,
      },
    });
    if (/^[124]/.test(document)) return unresolved('act_type_not_supported', { celex: document });
    if (forced) return unresolved(forced, ACT, WITH_VERSION.has(forced) ? VERSION : undefined);
    if (asOf < '2016-04-27') return unresolved('not_yet_adopted', ACT);
    if (asOf < '2016-05-04') {
      // Before the first consolidated version: the act as published.
      const version = { celex: document, kind: 'as_published' };
      return { body: { success: true, document, language, asOf, asOfResolved: true, asOfVersion: version, act: ACT, provenance: provenance(document, language, false), ...envelope } };
    }
    if (provision && provision !== 'art_17' && provision !== 'anx_I') return unresolved('article_not_in_version', ACT, VERSION);
    const text = provision === 'anx_I' ? (opts.text ?? 'x') : '1. The data subject shall have the right to obtain from the controller the erasure of personal data …';
    return {
      body: {
        success: true, document, language, asOf, asOfResolved: true, asOfVersion: VERSION, act: ACT,
        ...(provision ? { provision: { id: provision, number: provision === 'anx_I' ? 'ANNEX I' : 'Article 17', ...(provision === 'art_17' ? { title: 'Right to erasure (‘right to be forgotten’)' } : {}), text } } : {}),
        consolidated: true, consolidatedAsOf: '2016-05-04', baseCelex: document,
        consolidatedNote: `The act as amended, consolidated as of 2016-05-04; not the authentic text. Only the act as published in the Official Journal is authentic (${document}).`,
        provenance: provenance(VERSION.celex, language, !!provision),
        ...envelope,
      },
    };
  };
}

/** Validate args as the MCP SDK does for this tool, then run it against the stand-in. */
async function call(args: Record<string, unknown>, opts: StandIn | Parameters<typeof clientWith>[0] = {}) {
  const { client, calls } = clientWith(typeof opts === 'function' ? opts : asOfApi(opts));
  const result = await runTool(tool, inputSchemaOf(tool).parse(args) as Record<string, unknown>, client);
  const text = result.content[0].text;
  return { result, calls, text, data: result.isError ? undefined : parseText(result) };
}

describe('lex_legislation_as_of: input', () => {
  const ok = (args: unknown) => inputSchemaOf(tool).safeParse(args).success;
  const base = { document: '32016R0679', asOf: '2019-06-01' };

  it('takes document, asOf, provision and language, and nothing else', () => {
    expect(Object.keys(tool.inputSchema)).toEqual(['document', 'asOf', 'provision', 'language']);
    const schema = z.toJSONSchema(inputSchemaOf(tool), { io: 'input' }) as { required: string[]; additionalProperties: unknown };
    expect(schema.required).toEqual(['document', 'asOf']);
    expect(schema.additionalProperties).toBe(false);
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, provision: 'art_17', language: 'de' })).toBe(true);
    for (const extra of ['maxChars', 'celexNumber', 'articleId', 'date', 'bypassCorpus', 'limit']) expect(ok({ ...base, [extra]: 1 }), extra).toBe(false);
  });

  it('document and asOf are required and checked', () => {
    expect(ok({ document: '32016R0679' })).toBe(false);
    expect(ok({ asOf: '2019-06-01' })).toBe(false);
    for (const asOf of ['2019-6-1', '2019-02-30', '01/06/2019', 'today', '', 20190601, null]) expect(ok({ ...base, asOf }), String(asOf)).toBe(false);
    for (const document of ['02016R0679-20160504', '32016r0679', 'CELEX:32016R0679', '12016E101']) expect(ok({ ...base, document }), document).toBe(true);
    for (const document of ['GDPR!', 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', '', 5]) expect(ok({ ...base, document }), String(document)).toBe(false);
  });

  it('provision and language are optional and checked', () => {
    for (const provision of ['art_5', '5', '6a', 'anx_III', 'rct_26', 'rct_26-28']) expect(ok({ ...base, provision }), provision).toBe(true);
    for (const provision of ['', 'x'.repeat(41), 5]) expect(ok({ ...base, provision }), String(provision)).toBe(false);
    for (const language of ['en', 'sl', 'ga']) expect(ok({ ...base, language }), language).toBe(true);
    for (const language of ['xx', 'EN', 'eng', '']) expect(ok({ ...base, language }), language).toBe(false);
  });

  it('sends the CELEX in upper case without a prefix, and only what was given', async () => {
    const a = await call({ document: 'celex:32016r0679', asOf: '2019-06-01' });
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0].method).toBe('POST');
    expect(a.calls[0].url.pathname).toBe('/api/v1/legislation/as-of');
    expect(a.calls[0].body).toEqual({ document: '32016R0679', asOf: '2019-06-01' });
    const b = await call({ document: '32016R0679', asOf: '2019-06-01', provision: ' art_17 ', language: 'fr' });
    expect(b.calls[0].body).toEqual({ document: '32016R0679', asOf: '2019-06-01', provision: 'art_17', language: 'fr' });
  });
});

describe('lex_legislation_as_of: a resolved answer', () => {
  it('one article of the consolidated version: the allowlisted fields, nothing else', async () => {
    const { data } = await call({ document: '32016R0679', asOf: '2019-06-01', provision: '17' });
    expect(data).toEqual({
      document: '32016R0679',
      language: 'en',
      asOf: '2019-06-01',
      asOfResolved: true,
      asOfVersion: VERSION,
      act: ACT,
      provenance: {
        publisher: 'Publications Office of the European Union',
        sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02016R0679-20160504',
        sourceIdentifier: '02016R0679-20160504', versionIdentifier: '02016R0679-20160504', language: 'en', licence: 'EUR-Lex legal notice',
      },
      provision: {
        id: 'art_17', number: 'Article 17', title: 'Right to erasure (‘right to be forgotten’)',
        text: '1. The data subject shall have the right to obtain from the controller the erasure of personal data …',
      },
      consolidated: true,
      consolidatedAsOf: '2016-05-04',
      baseCelex: '32016R0679',
      consolidatedNote: 'The act as amended, consolidated as of 2016-05-04; not the authentic text. Only the act as published in the Official Journal is authentic (32016R0679).',
    });
  });

  it('the version only; a consolidated CELEX is answered for its base act', async () => {
    const { data } = await call({ document: '02016R0679-20160504', asOf: '2019-06-01' });
    expect(data).toMatchObject({ document: '32016R0679', asOfResolved: true, asOfVersion: { celex: '02016R0679-20160504', kind: 'consolidated' }, consolidated: true });
    expect(data).not.toHaveProperty('provision');
    expect(data).not.toHaveProperty('asOfReason');
    expect(data).not.toHaveProperty('asOfCaveat');
  });

  it('the act as published carries no consolidated label', async () => {
    const { data } = await call({ document: '32016R0679', asOf: '2016-04-30' });
    expect(data.asOfVersion).toEqual({ celex: '32016R0679', kind: 'as_published' });
    expect(data.asOfResolved).toBe(true);
    for (const k of ['consolidated', 'consolidatedAsOf', 'baseCelex', 'consolidatedNote', 'provision']) expect(data, k).not.toHaveProperty(k);
  });

  it('a long text is cut to the budget of the document tools, with a note', async () => {
    const long = 'y'.repeat(AS_OF_PROVISION_BUDGET + 1234);
    const { data } = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'anx_I' }, { text: long });
    expect(data.provision.text).toBe(`${'y'.repeat(AS_OF_PROVISION_BUDGET)} …[truncated: 1234 more characters]`);
    expect(data.note).toBe(`provision.text is cut to ${AS_OF_PROVISION_BUDGET} of ${long.length} characters. lex_get_document reads 02016R0679-20160504 in parts (articleId or include, with offset).`);
    const exact = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'anx_I' }, { text: 'y'.repeat(AS_OF_PROVISION_BUDGET) });
    expect(exact.data.provision.text).toHaveLength(AS_OF_PROVISION_BUDGET);
    expect(exact.data).not.toHaveProperty('note');
  });

  it('the credits block is not copied; a nearly empty pool adds a notice', async () => {
    const full = await call({ document: '32016R0679', asOf: '2019-06-01' });
    for (const k of ['credits', 'usage', 'success', 'notice']) expect(full.data, k).not.toHaveProperty(k);
    const low = await call({ document: '32016R0679', asOf: '2019-06-01' }, { credits: { remaining: 3, limit: 500, resetsAt: '2026-12-01T00:00:00.000Z' } });
    expect(low.data.notice).toBe('LexAPI credit pool is low: 3 of 500 credits left (resets 2026-12-01T00:00:00.000Z).');
    expect(low.data).not.toHaveProperty('credits');
  });
});

describe('lex_legislation_as_of: an unresolved answer', () => {
  it('the stand-in and the tool know the same 21 reasons', () => {
    expect(Object.keys(REASONS)).toHaveLength(21);
    for (const reason of Object.keys(REASONS)) {
      const c = asOfLookupCaveat(reason, '2019-06-01', false);
      expect(c.group, reason).toBe(REASONS[reason]);
      expect(typeof c.meaning, reason).toBe('string');
    }
  });

  for (const [reason, group] of Object.entries(REASONS)) {
    it(`${reason} → ${group}: asOfResolved false, the reason, a caveat, and no text even if one is sent`, async () => {
      for (const leak of [false, true]) {
        const { data, text } = await call({ document: '32016R0679', asOf: '2019-06-01', provision: `why_${reason}` }, { leak });
        expect(data.asOfResolved).toBe(false);
        expect(data.asOfReason).toBe(reason);
        expect(data.asOfCaveat.group).toBe(group);
        expect(data.asOfCaveat.guidance.startsWith(`${group}: `)).toBe(true);
        expect(data.asOfCaveat.note).toMatch(/^Unresolved: no (text is|version and no text are) returned for 2019-06-01\./);
        expect(Object.keys(data).sort()).toEqual(['act', 'asOf', 'asOfCaveat', 'asOfReason', 'asOfResolved', ...(WITH_VERSION.has(reason) ? ['asOfVersion'] : []), 'document', 'language', 'provenance'].sort());
        expect(text).not.toContain(LEAK);
        expect(text).not.toContain('"text"');
      }
    });
  }

  it('the three reasons only this lookup returns, with their meaning', async () => {
    const treaty = await call({ document: '12016E101', asOf: '2019-06-01' });
    expect(treaty.data).toMatchObject({ document: '12016E101', asOfResolved: false, asOfReason: 'act_type_not_supported', act: { celex: '12016E101' } });
    expect(treaty.data.asOfCaveat).toEqual({
      note: 'Unresolved: no version and no text are returned for 2019-06-01.',
      group: 'unavailable',
      meaning: 'The act is not a regulation, directive, decision or other act of the institutions (CELEX sector 3), for example a treaty or an international agreement; the lookup does not cover it.',
      guidance: 'unavailable: the text for 2019-06-01 was not established (see meaning).',
    });
    const ambiguous = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'why_provision_ambiguous' });
    expect(ambiguous.data.asOfVersion).toEqual(VERSION);
    expect(ambiguous.data.asOfCaveat).toMatchObject({
      note: 'Unresolved: no text is returned for 2019-06-01. asOfVersion is the version listed for that date; the requested provision of it was not established.',
      group: 'unavailable',
      meaning: 'More than one part of the text answers to the requested provision.',
    });
    const unparsed = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'why_version_not_parsed' });
    expect(unparsed.data.asOfCaveat).toMatchObject({ group: 'unavailable', meaning: 'The text is not split into identifiable parts of the requested kind.' });
  });

  it('the other classes say what follows', async () => {
    const early = await call({ document: '32016R0679', asOf: '2015-01-01', provision: 'art_17' });
    expect(early.data.asOfCaveat).toMatchObject({ group: 'notInForce', meaning: 'The date is outside the act\'s dates.' });
    expect(early.data.asOfCaveat.guidance).toMatch(/not in force on 2015-01-01.*that is the answer for this date/);
    expect(early.data).not.toHaveProperty('asOfVersion');
    const missing = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'art_999' });
    expect(missing.data).toMatchObject({ asOfReason: 'article_not_in_version', asOfVersion: VERSION, asOfCaveat: { meaning: 'The version has no such article, annex or recital.' } });
    const pending = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'why_fetch_pending' });
    expect(pending.data.asOfCaveat.guidance).toMatch(/calling again shortly may resolve it/);
    const credits = await call({ document: '32016R0679', asOf: '2019-06-01', provision: 'why_insufficient_credits' });
    expect(credits.data.asOfCaveat.guidance).toBe('needsCredits: the credit pool could not cover fetching the text.');
  });

  it('only asOfResolved: true is a resolved answer', () => {
    const body = (asOfResolved: unknown) => ({ success: true, document: '32016R0679', language: 'en', asOf: '2019-06-01', asOfResolved, asOfVersion: VERSION, act: ACT, provision: { id: 'art_17', text: LEAK }, consolidated: true, consolidatedNote: LEAK });
    for (const v of [false, undefined, null, 'true', 1, {}]) {
      const out = shapeAsOfLookup(body(v));
      expect(out.asOfResolved, String(v)).toBe(false);
      expect(JSON.stringify(out), String(v)).not.toContain(LEAK);
      expect(out.asOfCaveat).toBeDefined();
    }
    expect((shapeAsOfLookup(body(true)).provision as { text: string }).text).toBe(LEAK);
    // A reason the tool does not know is still unresolved; nothing is said about its meaning.
    const unknown = shapeAsOfLookup({ ...body(false), asOfReason: 'something_new' });
    expect(unknown.asOfCaveat).toMatchObject({ group: 'unavailable' });
    expect(unknown.asOfCaveat).not.toHaveProperty('meaning');
    // A resolved answer without a text has no provision; fields the API did not send are not added.
    expect(shapeAsOfLookup({ asOfResolved: true, provision: { id: 'art_17' } })).toEqual({ asOfResolved: true });
    expect(shapeAsOfLookup(undefined)).toMatchObject({ asOfResolved: false });
  });
});

describe('lex_legislation_as_of: errors', () => {
  const args = { document: '32016R0679', asOf: '2019-06-01' };
  const unknownRoute = () => err(404, 'NOT_FOUND', 'Unknown API endpoint: POST /api/v1/legislation/as-of. See https://lex-api.com/docs for the endpoint reference.');

  it('a 400 from the API is passed on with its message', async () => {
    const caseLaw = await call({ document: '62018CJ0311', asOf: '2019-06-01' });
    expect(caseLaw.result.isError).toBe(true);
    expect(caseLaw.text).toContain('LexAPI error 400 (INVALID_CELEX): "62018CJ0311" is case law. This endpoint covers EU legislation only.');
    const part = await call({ ...args, provision: '17(1)' });
    expect(part.text).toContain('LexAPI error 400 (INVALID_PARAMS): Only whole articles, annexes and recitals are addressable');
    const future = await call(args, () => err(400, 'INVALID_PARAMS', 'asOf cannot be in the future'));
    expect(future.text).toContain('asOf cannot be in the future');
  });

  it('an act the API does not know: the endpoint\'s own 404', async () => {
    const r = await call({ document: '32099R9999', asOf: '2019-06-01' });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain('LexAPI error 404 (NOT_FOUND): No EU act with the CELEX number 32099R9999 was found.');
    expect(r.text).toContain('Check the identifier');
    expect(r.text).not.toMatch(/deployment|ENDPOINT_NOT_AVAILABLE|country/);
  });

  it('an API without the endpoint: the 404 for the route says so', async () => {
    const r = await call(args, unknownRoute);
    expect(r.result.isError).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toBe('LexAPI error 404 (ENDPOINT_NOT_AVAILABLE): This LexAPI deployment does not offer this endpoint yet (POST /legislation/as-of, LexAPI API 2.26.0 or later). lex_semantic_legislation with asOf, and lex_get_document with a consolidated CELEX, do not need it. The same call is answered the same way until the API is updated, so it is not retryable.');
    expect(r.text).not.toMatch(/Unknown API endpoint|country|lex_national|Check the identifier|No EU act/);
  });

  it('a 404 that is not the API\'s typed answer is read as a missing endpoint too', async () => {
    for (const reply of [{ status: 404, raw: '<html>Not Found</html>' }, { status: 404, body: { error: 'Not Found' } }]) {
      const r = await call(args, () => reply);
      expect(r.text).toContain('ENDPOINT_NOT_AVAILABLE');
    }
  });

  it('other errors are not rewritten', async () => {
    const exhausted = await call(args, () => ({ status: 402, body: { success: false, error: { code: 'CREDITS_EXHAUSTED', message: 'Credit pool exhausted', details: { weight: 1, available: 0 } } } }));
    expect(exhausted.text).toContain('LexAPI error 402 (CREDITS_EXHAUSTED)');
    const forbidden = await call(args, () => err(403, 'FORBIDDEN', 'no'));
    expect(forbidden.text).toContain('LexAPI error 403');
  });
});

describe('lex_legislation_as_of: scope, read-only mode and texts', () => {
  const names = (scope?: string, readOnly = false) => selectTools({ readOnly, ...(scope === undefined ? {} : { scopes: expandScopeSet(scope) }) }).map((t) => t.name);

  it('needs lex:read, the scope of its route', () => {
    expect(tool.scope).toBe('lex:read');
    const { routes } = JSON.parse(readFileSync(new URL('./fixtures/api-route-scopes.json', import.meta.url), 'utf8')) as { routes: unknown[][] };
    expect(routes).toContainEqual(['POST', '/legislation/as-of', 'lex:read']);
    expect(names('lex:read')).toContain(NAME);
    expect(names('lex')).toContain(NAME);
    expect(names()).toContain(NAME);
    expect(names('lex:webhooks')).not.toContain(NAME);
    expect(names('')).not.toContain(NAME);
  });

  it('is a read-only tool, listed in read-only mode', () => {
    expect(tool.write).toBeUndefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
    expect(names(undefined, true)).toContain(NAME);
    expect(names('lex:read', true)).toContain(NAME);
    expect(tools).toHaveLength(37);
    expect(names(undefined, true)).toHaveLength(32);
  });

  it('the description says what the answer is and is not', () => {
    const d = tool.description;
    expect(d.length).toBeLessThan(900);
    expect(d).toContain('only when asOfResolved is true');
    expect(d).toContain('no text is returned');
    expect(d).toContain('It does not say whether an individual provision applied on the date');
    expect(d).toContain('Consolidated versions have no legal force');
    expect(d).toContain('lex_semantic_legislation with asOf is the search by meaning');
    expect(d).not.toMatch(/current law|in force on (a|the|that) date/i);
  });

  it('the server instructions point at it for a known act', () => {
    expect(SERVER_INSTRUCTIONS).toContain('otherwise lex_legislation_as_of resolves it for a known act, and asOf in a search.');
    expect(SERVER_INSTRUCTIONS).toContain('lex_semantic_legislation with asOf returns the law in force on a date');
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(3_750);
  });
});

// ── Over MCP, against a local HTTP server ─────────────────────────────
describe('lex_legislation_as_of over MCP', () => {
  let api: Server;
  let baseUrl: string;
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const standIn = asOfApi();

  beforeAll(async () => {
    api = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ method: req.method ?? '', path: req.url ?? '', body });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const old = url.pathname.startsWith('/old/');
        const r = old
          ? err(404, 'NOT_FOUND', `Unknown API endpoint: ${req.method} ${url.pathname.replace('/old', '')}. See https://lex-api.com/docs for the endpoint reference.`)
          : await standIn({ method: req.method ?? '', url, headers: {}, body });
        res.statusCode = (r as { status?: number }).status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
  });

  async function connect(base: string, opts: Parameters<typeof createLexServer>[1] = {}) {
    const server = createLexServer(new LexAPIClient({ apiKey: 'lex_good', baseUrl: base }), opts);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    return client;
  }
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

  it('is listed with a closed schema; an unknown parameter is refused before any request', async () => {
    const client = await connect(`${baseUrl}/api/v1`);
    const listed = (await client.listTools()).tools.find((t) => t.name === NAME)!;
    expect(listed.inputSchema).toMatchObject({ required: ['document', 'asOf'], additionalProperties: false });
    expect(Object.keys(listed.inputSchema.properties ?? {})).toEqual(['document', 'asOf', 'provision', 'language']);
    const before = seen.length;
    for (const bad of [{ document: '32016R0679', asOf: '2019-06-01', maxChars: 2000 }, { document: '32016R0679' }, { document: '32016R0679', asOf: 'June 2019' }]) {
      const r = await client.callTool({ name: NAME, arguments: bad });
      expect(r.isError).toBe(true);
    }
    expect(seen.length).toBe(before);
    const good = await client.callTool({ name: NAME, arguments: { document: '32016R0679', asOf: '2019-06-01', provision: 'art_17' } });
    expect(good.isError).toBeFalsy();
    expect(JSON.parse(textOf(good))).toMatchObject({ asOfResolved: true, provision: { id: 'art_17' }, asOfVersion: { celex: '02016R0679-20160504' } });
    expect(seen.at(-1)).toEqual({ method: 'POST', path: '/api/v1/legislation/as-of', body: { document: '32016R0679', asOf: '2019-06-01', provision: 'art_17' } });
  });

  it('an API without the endpoint, and an unknown act', async () => {
    const old = await connect(`${baseUrl}/old/api/v1`);
    const missing = await old.callTool({ name: NAME, arguments: { document: '32016R0679', asOf: '2019-06-01' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('This LexAPI deployment does not offer this endpoint yet (POST /legislation/as-of, LexAPI API 2.26.0 or later)');
    const client = await connect(`${baseUrl}/api/v1`);
    const unknown = await client.callTool({ name: NAME, arguments: { document: '32099R9999', asOf: '2019-06-01' } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('No EU act with the CELEX number 32099R9999 was found');
    expect(textOf(unknown)).not.toContain('deployment');
  });

  it('a connection with lex:webhooks only is not offered the tool; lex:read and read-only mode are', async () => {
    const list = async (opts: Parameters<typeof createLexServer>[1]) => (await (await connect(`${baseUrl}/api/v1`, opts)).listTools()).tools.map((t) => t.name);
    expect(await list({ scopes: expandScopeSet('lex:webhooks') })).not.toContain(NAME);
    expect(await list({ scopes: expandScopeSet('lex:read') })).toContain(NAME);
    expect(await list({ scopes: expandScopeSet('lex') })).toContain(NAME);
    expect(await list({ readOnly: true })).toContain(NAME);
  });
});
