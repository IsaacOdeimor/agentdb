// ── Write-Ahead Log (WAL) ────────────────────────────────────
// Ensures crash safety by logging operations before applying them.
// On startup, if a .wal file exists, pending operations are replayed.

import * as fs from 'fs';
import { crc32 } from './crc32.js';
import { WALError } from './errors.js';

/** WAL operation types */
export const enum WALOp {
  Insert = 0x01,
  Delete = 0x02,
  Update = 0x03,
  Compact = 0x04,
}

/** A single WAL entry */
export interface WALEntry {
  op: WALOp;
  key: string;
  ts: number;
  data?: string; // JSON string
}

/**
 * WAL file format:
 *   Sequential entries, each:
 *   [0-3]     CRC32 of the rest of the entry (uint32 LE)
 *   [4]       Op type (uint8)
 *   [5-6]     Key length (uint16 LE)
 *   [7..K]    Key (UTF-8)
 *   [K+1..K+8] Timestamp (float64 LE)
 *   [K+9..K+12] Data length (uint32 LE) — 0 if no data
 *   [K+13..M]   Data (UTF-8 JSON)
 *
 * Commit marker: a single byte 0xFF at the end means the batch was committed.
 */
const COMMIT_MARKER = 0xFF;

export class WriteAheadLog {
  private walPath: string;
  private fd: number | null = null;

  constructor(dbFilePath: string) {
    this.walPath = dbFilePath + '.wal';
  }

  /** Check if there's a WAL file with uncommitted entries */
  hasPending(): boolean {
    return fs.existsSync(this.walPath) && fs.statSync(this.walPath).size > 0;
  }

  /** Read all pending entries from the WAL (for crash recovery) */
  recover(): WALEntry[] {
    if (!this.hasPending()) return [];

    const buf = fs.readFileSync(this.walPath);
    const entries: WALEntry[] = [];
    let pos = 0;

    while (pos < buf.length) {
      // Check for commit marker
      if (buf[pos] === COMMIT_MARKER) {
        // This batch was committed — entries are already applied
        entries.length = 0; // clear, they're already on disk
        pos++;
        continue;
      }

      if (pos + 4 >= buf.length) break; // truncated

      // Read CRC
      const expectedCRC = buf.readUInt32LE(pos);
      pos += 4;

      const entryStart = pos;

      // Read op
      if (pos >= buf.length) break;
      const op = buf.readUInt8(pos) as WALOp;
      pos += 1;

      // Read key length
      if (pos + 2 > buf.length) break;
      const keyLen = buf.readUInt16LE(pos);
      pos += 2;

      // Read key
      if (pos + keyLen > buf.length) break;
      const key = buf.subarray(pos, pos + keyLen).toString('utf-8');
      pos += keyLen;

      // Read timestamp
      if (pos + 8 > buf.length) break;
      const ts = buf.readDoubleLE(pos);
      pos += 8;

      // Read data length
      if (pos + 4 > buf.length) break;
      const dataLen = buf.readUInt32LE(pos);
      pos += 4;

      // Read data
      let data: string | undefined;
      if (dataLen > 0) {
        if (pos + dataLen > buf.length) break;
        data = buf.subarray(pos, pos + dataLen).toString('utf-8');
        pos += dataLen;
      }

      // Verify CRC
      const entryBuf = buf.subarray(entryStart, pos);
      const actualCRC = crc32(entryBuf);
      if (actualCRC !== expectedCRC) {
        // Corrupted entry — stop here, don't replay partial data
        break;
      }

      entries.push({ op, key, ts, data });
    }

    return entries;
  }

  /** Begin a new WAL session (opens/truncates the WAL file) */
  begin(): void {
    this.fd = fs.openSync(this.walPath, 'w');
  }

  /** Log an operation to the WAL */
  log(entry: WALEntry): void {
    if (this.fd === null) {
      // Auto-begin if not started
      this.fd = fs.openSync(this.walPath, 'a');
    }

    const keyBuf = Buffer.from(entry.key, 'utf-8');
    const dataBuf = entry.data ? Buffer.from(entry.data, 'utf-8') : Buffer.alloc(0);

    // Build entry (without CRC prefix)
    const entrySize = 1 + 2 + keyBuf.length + 8 + 4 + dataBuf.length;
    const entryBuf = Buffer.alloc(entrySize);
    let off = 0;

    entryBuf.writeUInt8(entry.op, off); off += 1;
    entryBuf.writeUInt16LE(keyBuf.length, off); off += 2;
    keyBuf.copy(entryBuf, off); off += keyBuf.length;
    entryBuf.writeDoubleLE(entry.ts, off); off += 8;
    entryBuf.writeUInt32LE(dataBuf.length, off); off += 4;
    if (dataBuf.length > 0) { dataBuf.copy(entryBuf, off); }

    // Write CRC + entry
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc32(entryBuf), 0);

    fs.writeSync(this.fd, crcBuf);
    fs.writeSync(this.fd, entryBuf);
    fs.fsyncSync(this.fd); // force to disk
  }

  /** Mark the current batch as committed */
  commit(): void {
    if (this.fd === null) return;
    const marker = Buffer.alloc(1);
    marker.writeUInt8(COMMIT_MARKER, 0);
    fs.writeSync(this.fd, marker);
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
    // Remove WAL file after successful commit
    this.clear();
  }

  /** Discard the WAL (rollback) */
  rollback(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    this.clear();
  }

  /** Remove the WAL file */
  clear(): void {
    try {
      if (fs.existsSync(this.walPath)) fs.unlinkSync(this.walPath);
    } catch {
      // best effort
    }
  }

  /** Close the WAL */
  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
