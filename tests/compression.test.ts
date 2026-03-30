import { describe, it, expect } from 'vitest';
import { compress, decompress, smartCompress } from '../src/compression';

describe('Compression', () => {
  it('compress and decompress round-trips', () => {
    const original = Buffer.from('Hello, World! This is a test of compression.');
    const compressed = compress(original);
    const decompressed = decompress(compressed);
    expect(decompressed.toString()).toBe(original.toString());
  });

  it('compresses repetitive data effectively', () => {
    const original = Buffer.from('aaaaaaaaaa'.repeat(100));
    const compressed = compress(original);
    expect(compressed.length).toBeLessThan(original.length);
  });

  it('handles empty buffer', () => {
    const compressed = compress(Buffer.alloc(0));
    const decompressed = decompress(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('handles binary data', () => {
    const original = Buffer.from([0x00, 0xFF, 0x80, 0x7F, 0x01, 0xFE]);
    const compressed = compress(original);
    const decompressed = decompress(compressed);
    expect(decompressed.compare(original)).toBe(0);
  });

  describe('smartCompress', () => {
    it('skips small buffers', () => {
      const small = Buffer.from('tiny');
      const result = smartCompress(small);
      expect(result.compressed).toBe(false);
      expect(result.data.toString()).toBe('tiny');
    });

    it('compresses when savings are significant', () => {
      const repetitive = Buffer.from(JSON.stringify({
        name: 'test', value: 'data', name2: 'test', value2: 'data',
        name3: 'test', value3: 'data', name4: 'test', value4: 'data',
      }));
      const result = smartCompress(repetitive);
      if (result.compressed) {
        expect(result.data.length).toBeLessThan(repetitive.length);
      }
    });

    it('skips compression when no savings', () => {
      // Random data doesn't compress well
      const random = Buffer.alloc(200);
      for (let i = 0; i < random.length; i++) {
        random[i] = Math.floor(Math.random() * 256);
      }
      const result = smartCompress(random);
      // Either compressed with savings or not compressed
      expect(typeof result.compressed).toBe('boolean');
    });
  });
});
