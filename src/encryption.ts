// ── Encryption Layer (AES-256-GCM) ───────────────────────────
// Uses Node's built-in crypto module. Each record gets a unique IV.

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { EncryptionError } from './errors.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;       // 96-bit IV for GCM
const TAG_LEN = 16;      // 128-bit auth tag
const SALT_LEN = 16;
const KEY_LEN = 32;       // 256-bit key
const ITERATIONS = 100_000;

export interface EncryptionKey {
  key: Buffer;
  salt: Buffer;
}

/** Derive a 256-bit key from a password using PBKDF2 */
export function deriveKey(password: string, salt?: Buffer): EncryptionKey {
  const s = salt || randomBytes(SALT_LEN);
  const key = pbkdf2Sync(password, s, ITERATIONS, KEY_LEN, 'sha512');
  return { key, salt: s };
}

/**
 * Encrypt a Buffer with AES-256-GCM.
 * Output format: [IV (12 bytes)] [Auth Tag (16 bytes)] [Ciphertext (N bytes)]
 */
export function encrypt(buf: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt a Buffer encrypted with AES-256-GCM.
 * Input format: [IV (12)] [Auth Tag (16)] [Ciphertext (N)]
 */
export function decrypt(buf: Buffer, key: Buffer): Buffer {
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new EncryptionError('Encrypted data too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);

  try {
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EncryptionError('Decryption failed — wrong key or corrupted data');
  }
}

/** Overhead added by encryption (IV + tag) */
export const ENCRYPTION_OVERHEAD = IV_LEN + TAG_LEN;
