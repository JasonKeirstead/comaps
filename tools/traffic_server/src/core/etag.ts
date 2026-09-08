/**
 * ETags for the values payload.
 *
 * Derived from the *uncompressed* value array rather than the deflated body, because zlib
 * output is implementation-defined: the same values compressed by Node and by workerd may
 * differ byte for byte, and a tag that flipped when you moved between them would force every
 * client to re-download.
 *
 * The client compares tags verbatim (quotes included) and only ever echoes back what we sent,
 * so any stable string works. Sending an ETag on every 200 is mandatory -- the client only
 * updates its stored tag from the response header, and without one it will resend a stale
 * If-None-Match forever.
 */

/** FNV-1a, 64-bit, in two 32-bit halves. No crypto dependency and stable across runtimes. */
export function etagFor(values: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < values.length; i++) {
    h1 ^= values[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= values[i] + i;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const hex = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  return `"${values.length.toString(16)}-${hex}"`;
}

/**
 * Whether an If-None-Match header matches. The client sends the tag verbatim, and an empty
 * header (its state before the first successful response) must never match.
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const candidates = ifNoneMatch.split(',').map((s) => s.trim());
  return candidates.some((c) => c === etag || c === `W/${etag}` || c === '*');
}
