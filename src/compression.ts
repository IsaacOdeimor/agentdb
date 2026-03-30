// ── Compression Layer (zlib deflate) ─────────────────────────
// Uses Node's built-in zlib — zero external dependencies.

import { deflateSync, inflateSync } from 'zlib';

/** Compress a Buffer using deflate. Returns compressed Buffer. */
export function compress(buf: Buffer): Buffer {
  return deflateSync(buf, { level: 6 });
}

/** Decompress a deflated Buffer. Returns original data. */
export function decompress(buf: Buffer): Buffer {
  return inflateSync(buf);
}

/**
 * Only compress if it actually saves space.
 * Returns { data, compressed } — compressed is true if compression was applied.
 */
export function smartCompress(buf: Buffer, minSavings = 0.1): { data: Buffer; compressed: boolean } {
  if (buf.length < 64) return { data: buf, compressed: false }; // too small to bother
  const out = compress(buf);
  const saved = 1 - (out.length / buf.length);
  if (saved >= minSavings) {
    return { data: out, compressed: true };
  }
  return { data: buf, compressed: false };
}
