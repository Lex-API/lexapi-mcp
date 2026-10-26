import { LexAPIClient } from '../src/client.js';

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };
type Handler = (call: Call, n: number) => Reply | Promise<Reply>;

/** A fetch stand-in that records calls and answers from `handler`. */
export function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = await handler(call, calls.length);
    const status = r.status ?? 200;
    const text = r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function clientWith(handler: Handler, opts: { maxRetries?: number } = {}) {
  const m = mockFetch(handler);
  const sleeps: number[] = [];
  const client = new LexAPIClient({
    apiKey: 'lex_test_secret_key',
    baseUrl: 'https://api.example.test/api/v1',
    fetch: m.fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    ...opts,
  });
  return { client, calls: m.calls, sleeps };
}

/** A GDPR-like document with `n` articles of `len` characters. */
export function fakeDocument(n = 3, len = 100, extra: Record<string, unknown> = {}) {
  return {
    celex: '32016R0679',
    title: 'Regulation (EU) 2016/679 (General Data Protection Regulation)',
    documentType: 'Regulation',
    documentTypeCode: 'regulation',
    author: 'European Parliament, Council of the European Union',
    dateOfDocument: '27/04/2016',
    dateOfDocumentISO: '2016-04-27',
    celexNumber: '32016R0679',
    language: 'en',
    keywords: ['data protection', 'personal data'],
    urls: {
      html: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679',
      metadata: 'https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32016R0679',
      pdf: 'https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32016R0679',
    },
    textAvailability: { available: true },
    content: {
      fullText: Array.from({ length: n }, (_, i) => `Article ${i + 1}\n\n${'x'.repeat(len)}`).join('\n\n'),
      articles: Array.from({ length: n }, (_, i) => ({
        id: `art_${i + 1}`,
        number: `Article ${i + 1}`,
        title: `Title ${i + 1}`,
        content: 'x'.repeat(len),
      })),
      recitals: [{ number: 1, text: 'Whereas…' }],
      paragraphs: [],
      sections: [{ type: 'chapter', number: 'I', title: 'General provisions', articleRange: ['art_1', `art_${n}`] }],
      tables: [],
      annexes: [],
    },
    ...extra,
  };
}

export function parseText(result: { content: Array<{ type: string; text?: string }> }): any {
  const t = result.content[0];
  if (!t || t.type !== 'text' || typeof t.text !== 'string') throw new Error('no text content');
  return JSON.parse(t.text);
}
