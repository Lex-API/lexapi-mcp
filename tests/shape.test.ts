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

  it('N5: a single item longer than the budget is split into parts that offset can page through', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'); // ~44k chars
    const doc = { annexes: [{ title: 'Annex I', content: big }] };
    const first = shapeContent(doc, { view: 'full', maxChars: 5000 });
    const a1 = (first.content!.annexes as Array<{ content: string; part: string }>)[0];
    expect(a1.content.length).toBeLessThanOrEqual(5000);
    expect(a1.part).toMatch(/^1\/\d+$/);
    const m = /offset=(\d+)/.exec(first.note!);
    expect(m).not.toBeNull();
    // Page to the very end: the last part is reachable.
    let off = Number(m![1]);
    let last: { content: string; part: string } | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const r = shapeContent(doc, { view: 'full', maxChars: 5000, offset: off });
      const list = r.content!.annexes as Array<{ content: string; part: string }>;
      last = list[list.length - 1];
      const n = /offset=(\d+)/.exec(r.note ?? '');
      if (!n) break;
      off = Number(n[1]);
    }
    expect(last!.content).toContain('line 4999');
  });

  it('N5: a fullText without blank lines is paged, not clipped', () => {
    const r = shapeContent({ fullText: 'w '.repeat(30_000) }, { view: 'full', maxChars: 10_000 });
    expect(r.note).toMatch(/offset=1/);
    expect(r.note).not.toMatch(/was cut/);
  });

  it('N4: the outline hint only suggests parts the document has', () => {
    const judgment = shapeContent({ paragraphs: Array.from({ length: 200 }, (_, i) => ({ number: i + 1, text: 'p'.repeat(500) })) }, { maxChars: 5000 });
    expect(judgment.note).toMatch(/include \["paragraphs"\]/);
    expect(judgment.note).not.toMatch(/articleId/);
    const textOnly = shapeContent({ fullText: 'x'.repeat(50_000) }, { maxChars: 5000 });
    expect(textOnly.note).toMatch(/include \["fullText"\]/);
  });

  it('N4: the outline article list is bounded by maxChars and paged by offset', () => {
    const content = { articles: Array.from({ length: 600 }, (_, i) => ({ id: `art_${i + 1}`, number: `Article ${i + 1}`, title: `A rather long article title number ${i + 1}`, content: 'c'.repeat(300) })) };
    const r = shapeContent(content, { view: 'outline', maxChars: 10_000 });
    expect(JSON.stringify(r.content).length).toBeLessThanOrEqual(10_000);
    const listed = (r.content!.articles as unknown[]).length;
    expect(listed).toBeLessThan(600);
    expect(r.content!.articleCount).toBe(600);
    expect(r.note).toMatch(new RegExp(`offset=${listed}`));
    const next = shapeContent(content, { view: 'outline', maxChars: 10_000, offset: listed });
    expect((next.content!.articles as Array<{ id: string }>)[0].id).toBe(`art_${listed + 1}`);
  });

  it('explicit outline view stays an outline even with include', () => {
    const r = shapeContent({ articles: [{ id: 'art_1', content: 'a' }] }, { view: 'outline', maxChars: 5000, include: ['articles'] });
    expect(r.note).toMatch(/Outline only/);
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
