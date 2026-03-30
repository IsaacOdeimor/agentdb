// ── CRC32 (IEEE 802.3 polynomial) ────────────────────────────
// Same algorithm as zlib, PNG, gzip. Zero dependencies.

const POLY = 0xEDB88320;

/** Precomputed lookup table — 256 entries */
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? ((crc >>> 1) ^ POLY) : (crc >>> 1);
  }
  TABLE[i] = crc;
}

/** Compute CRC32 checksum of a Buffer. Returns unsigned 32-bit integer. */
export function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Verify a buffer against an expected CRC32 value */
export function verifyCRC32(buf: Buffer, expected: number): boolean {
  return crc32(buf) === expected;
}

/** Compute CRC32 and write it into a 4-byte Buffer (LE) */
export function crc32Buffer(buf: Buffer): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(crc32(buf), 0);
  return out;
}
