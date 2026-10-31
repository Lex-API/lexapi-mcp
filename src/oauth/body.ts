// Size-capped reading of an outbound response body (JWKS, token endpoint).
// The cap is enforced while streaming: a body larger than the cap is never
// buffered in full — reading stops, and the stream is cancelled, as soon as
// the running total passes it.

export class ResponseTooLargeError extends Error {
  constructor() {
    super('response body too large');
    this.name = 'ResponseTooLargeError';
  }
}

/** The body as UTF-8 text, or ResponseTooLargeError once more than `maxBytes` arrived. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
