import { describe, it, expect } from 'vitest';
import { crc32, verifyCRC32, crc32Buffer } from '../src/crc32';

describe('CRC32', () => {
  it('produces correct checksum for known input', () => {
    // "hello" CRC32 = 0x3610A686
    const result = crc32(Buffer.from('hello'));
    expect(result).toBe(0x3610A686);
  });

  it('produces correct checksum for empty buffer', () => {
    const result = crc32(Buffer.alloc(0));
    expect(result).toBe(0x00000000);
  });

  it('produces different checksums for different inputs', () => {
    const a = crc32(Buffer.from('hello'));
    const b = crc32(Buffer.from('world'));
    expect(a).not.toBe(b);
  });

  it('produces same checksum for same input', () => {
    const buf = Buffer.from('test data 12345');
    expect(crc32(buf)).toBe(crc32(buf));
  });

  it('verifyCRC32 returns true for matching checksum', () => {
    const buf = Buffer.from('verify me');
    const checksum = crc32(buf);
    expect(verifyCRC32(buf, checksum)).toBe(true);
  });

  it('verifyCRC32 returns false for wrong checksum', () => {
    const buf = Buffer.from('verify me');
    expect(verifyCRC32(buf, 0xDEADBEEF)).toBe(false);
  });

  it('crc32Buffer returns 4-byte LE buffer', () => {
    const buf = Buffer.from('test');
    const result = crc32Buffer(buf);
    expect(result.length).toBe(4);
    expect(result.readUInt32LE(0)).toBe(crc32(buf));
  });

  it('handles binary data', () => {
    const buf = Buffer.from([0x00, 0xFF, 0x80, 0x7F, 0x01]);
    const checksum = crc32(buf);
    expect(typeof checksum).toBe('number');
    expect(checksum >>> 0).toBe(checksum); // unsigned 32-bit
  });

  it('handles large buffers', () => {
    const buf = Buffer.alloc(1024 * 1024, 0x42); // 1MB
    const checksum = crc32(buf);
    expect(typeof checksum).toBe('number');
    expect(verifyCRC32(buf, checksum)).toBe(true);
  });
});
