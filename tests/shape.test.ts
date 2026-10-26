import { describe, expect, it } from 'vitest';

import { consolidatedBaseOf, creditNotice, shapeContent, shapeMetadata } from '../src/shape.js';

describe('consolidatedBaseOf', () => {
  it('derives the base act and date', () => {
    expect(consolidatedBaseOf('02016R0679-20160504')).toEqual({ base: '32016R0679', date: '2016-05-04' });
    expect(consolidatedBaseOf('02019D0003(01)-20210101')).toEqual({ base: '32019D0003(01)', date: '2021-01-01' });
    expect(consolidatedBaseOf('32016R0679')).toBeNull();
    expect(consolidatedBaseOf(undefined)).toBeNull();
  });
});

describe('shapeContent', () => {
  const judgment = {
    articles: [],
    recitals: [],
    paragraphs: Array.from({ length: 120 }, (_, i) => ({ number: i + 1, text: 'g'.repeat(600) })),
    fullText: 'dup',
  };

  it('judgments page through paragraphs, not fullText', () => {
    const r = shapeContent(judgment, { view: 'auto', maxChars: 20_000 });
    expect(r.content).toMatchObject({ paragraphCount: 120 });
    expect(r.note).toMatch(/Outline only/);

    const full = shapeContent(judgment, { view: 'full', maxChars: 20_000 });
    const got = (full.content!.paragraphs as unknown[]).length;
    expect(got).toBeGreaterThan(20);
    expect(got).toBeLessThan(120);
    expect(full.content).not.toHaveProperty('fullText');
    expect(full.note).toMatch(new RegExp(`offset=${got}`));
    expect(full.note).toMatch(/paragraph \d+ … paragraph 120/);
  });

  it('a document with only fullText is served from fullText', () => {
    const r = shapeContent({ fullText: 'a\n\nb\n\nc', articles: [] }, { view: 'auto', maxChars: 10_000 });
    expect(r.content).toEqual({ fullText: 'a\n\nb\n\nc' });
  });

  it('clips a single item longer than the whole budget', () => {
    const r = shapeContent({ annexes: [{ title: 'Annex I', content: 'z'.repeat(50_000) }] }, { view: 'full', maxChars: 5000 });
    const annex = (r.content!.annexes as Array<{ content: string }>)[0];
    expect(annex.content.length).toBeLessThan(5200);
    expect(annex.content).toMatch(/truncated: \d+ more characters/);
    expect(r.note).toMatch(/longer than maxChars/);
  });

  it('explicit include selects parts', () => {
    const r = shapeContent({ articles: [{ id: 'art_1', content: 'a' }], annexes: [{ title: 'I', content: 'b' }] }, { view: 'auto', maxChars: 5000, include: ['annexes'] });
    expect(r.content).toEqual({ annexes: [{ title: 'I', content: 'b' }] });
  });
});

describe('shapeMetadata', () => {
  it('keeps the legacy date only without an ISO twin, caps keywords', () => {
    const m = shapeMetadata({ celexNumber: '31995L0046', dateOfDocument: '24/10/1995', keywords: Array(40).fill('k') });
    expect(m).toMatchObject({ celex: '31995L0046', dateOfDocument: '24/10/1995' });
    expect((m.keywords as unknown[]).length).toBe(20);
  });
});

describe('creditNotice', () => {
  it('only fires when the pool is nearly empty', () => {
    expect(creditNotice({ credits: { remaining: 400, limit: 500 } })).toBeUndefined();
    expect(creditNotice({ credits: { remaining: 40, limit: 500 } })).toMatch(/40 of 500/);
    expect(creditNotice({ credits: { remaining: 2000, limit: 150_000 } })).toMatch(/2000 of 150000/);
    expect(creditNotice({})).toBeUndefined();
  });
});
