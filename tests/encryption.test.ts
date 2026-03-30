import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, deriveKey } from '../src/encryption';

describe('Encryption', () => {
  const testKey = deriveKey('test-password');

  it('encrypt and decrypt round-trips', () => {
    const original = Buffer.from('Secret message');
    const encrypted = encrypt(original, testKey.key);
    const decrypted = decrypt(encrypted, testKey.key);
    expect(decrypted.toString()).toBe('Secret message');
  });

  it('encrypted data differs from original', () => {
    const original = Buffer.from('plaintext');
    const encrypted = encrypt(original, testKey.key);
    expect(encrypted.toString()).not.toBe('plaintext');
    expect(encrypted.length).toBeGreaterThan(original.length);
  });

  it('different encryptions produce different ciphertexts (unique IV)', () => {
    const original = Buffer.from('same data');
    const enc1 = encrypt(original, testKey.key);
    const enc2 = encrypt(original, testKey.key);
    expect(enc1.compare(enc2)).not.toBe(0); // different IVs
  });

  it('wrong key fails to decrypt', () => {
    const original = Buffer.from('Secret');
    const encrypted = encrypt(original, testKey.key);
    const wrongKey = deriveKey('wrong-password');
    expect(() => decrypt(encrypted, wrongKey.key)).toThrow();
  });

  it('tampered ciphertext fails to decrypt', () => {
    const original = Buffer.from('Secret');
    const encrypted = encrypt(original, testKey.key);
    encrypted[encrypted.length - 1] ^= 0xFF; // flip last byte
    expect(() => decrypt(encrypted, testKey.key)).toThrow();
  });

  it('handles empty buffer', () => {
    const original = Buffer.alloc(0);
    const encrypted = encrypt(original, testKey.key);
    const decrypted = decrypt(encrypted, testKey.key);
    expect(decrypted.length).toBe(0);
  });

  it('handles large data', () => {
    const original = Buffer.alloc(10000, 0x42);
    const encrypted = encrypt(original, testKey.key);
    const decrypted = decrypt(encrypted, testKey.key);
    expect(decrypted.compare(original)).toBe(0);
  });

  describe('deriveKey', () => {
    it('same password and salt produces same key', () => {
      const k1 = deriveKey('test-password', testKey.salt);
      expect(k1.key.compare(testKey.key)).toBe(0);
    });

    it('different passwords produce different keys', () => {
      const k1 = deriveKey('password1');
      const k2 = deriveKey('password2');
      expect(k1.key.compare(k2.key)).not.toBe(0);
    });

    it('generates salt if not provided', () => {
      const k = deriveKey('test');
      expect(k.salt.length).toBe(16);
      expect(k.key.length).toBe(32);
    });
  });
});
