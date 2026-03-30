import * as fs from 'fs';
import * as path from 'path';
import { Document, RecordStatus, RecordFlags, MAGIC, HEADER_SIZE, VERSION } from './types.js';
import { crc32 } from './crc32.js';
import { smartCompress, decompress } from './compression.js';
import { encrypt, decrypt } from './encryption.js';
import { WriteAheadLog, WALOp } from './wal.js';
import { ChecksumError, CorruptionError } from './errors.js';

/**
 * StorageEngine v2 - binary file I/O with crash safety.
 *
 * Features over v1:
 *   - CRC32 checksum per record
 *   - Optional zlib compression
 *   - Optional AES-256-GCM encryption
 *   - Write-Ahead Log for crash recovery
 *   - Self-healing on corruption
 */
export class StorageEngine {
  private filePath: string;
  private fd: number | null = null;
  private totalRecords = 0;
  private activeRecords = 0;
  private createdAt = 0;
  private modifiedAt = 0;
  private collectionFlags = 0;

  private wal: WriteAheadLog;
  private encryptionKey: Buffer | null = null;
  private compressionEnabled = false;

  /** Corruption stats from last scan */
  corruptedRecords = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.wal = new WriteAheadLog(filePath);
  }

  /** Configure compression */
  setCompression(enabled: boolean): void {
    this.compressionEnabled = enabled;
    if (enabled) this.collectionFlags |= RecordFlags.Compressed;
  }

  /** Configure encryption key */
  setEncryptionKey(key: Buffer | null): void {
    this.encryptionKey = key;
    if (key) this.collectionFlags |= RecordFlags.Encrypted;
  }

  /** Open or create the collection file, replay WAL if needed */
  async open(): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.fd = fs.openSync(this.filePath, 'w+');
      this.createdAt = Date.now();
      this.modifiedAt = this.createdAt;
      this.totalRecords = 0;
      this.activeRecords = 0;
      this.writeHeader();
    } else {
      this.fd = fs.openSync(this.filePath, 'r+');
      this.readHeader();
    }

    if (this.wal.hasPending()) {
      await this.replayWAL();
    }
  }

  close(): void {
    this.wal.close();
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  // Header I/O

  private writeHeader(): void {
    if (this.fd === null) return;
    const buf = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(buf, 0);
    buf.writeUInt8(VERSION, 4);
    buf.writeUInt8(this.collectionFlags, 5);
    buf.writeDoubleLE(this.createdAt, 8);
    buf.writeDoubleLE(this.modifiedAt, 16);
    buf.writeUInt32LE(this.totalRecords, 24);
    buf.writeUInt32LE(this.activeRecords, 28);
    fs.writeSync(this.fd, buf, 0, HEADER_SIZE, 0);
  }

  private readHeader(): void {
    if (this.fd === null) return;
    const buf = Buffer.alloc(HEADER_SIZE);
    fs.readSync(this.fd, buf, 0, HEADER_SIZE, 0);

    if (buf.subarray(0, 4).compare(MAGIC) !== 0) {
      throw new CorruptionError('Invalid magic bytes', this.filePath, 0);
    }

    const version = buf.readUInt8(4);
    if (version > VERSION) {
      throw new CorruptionError(`Unsupported version ${version}`, this.filePath, 4);
    }

    this.collectionFlags = buf.readUInt8(5);
    this.createdAt = buf.readDoubleLE(8);
    this.modifiedAt = buf.readDoubleLE(16);
    this.totalRecords = buf.readUInt32LE(24);
    this.activeRecords = buf.readUInt32LE(28);
  }

  private flushHeader(): void {
    this.modifiedAt = Date.now();
    this.writeHeader();
  }

  /** Get the file version */
  getVersion(): number {
    if (this.fd === null) return 0;
    const buf = Buffer.alloc(1);
    fs.readSync(this.fd, buf, 0, 1, 4);
    return buf.readUInt8(0);
  }

  // Record scanning

  /**
   * Scan all records from disk.
   * Handles both v1 (no CRC/flags) and v2 record formats.
   */
  scanAll(): Array<{ offset: number; doc: Document }> {
    if (this.fd === null) return [];

    const version = this.getVersion();
    const stat = fs.fstatSync(this.fd);
    const fileSize = stat.size;
    let pos = HEADER_SIZE;
    const results: Array<{ offset: number; doc: Document }> = [];

    let scannedTotal = 0;
    let scannedActive = 0;
    this.corruptedRecords = 0;

    while (pos < fileSize) {
      const recordOffset = pos;

      try {
        if (version >= 2) {
          const parsed = this.readRecordV2(pos, fileSize);
          if (!parsed) break;
          pos = parsed.nextPos;
          scannedTotal++;
          if (parsed.active) {
            scannedActive++;
            results.push({ offset: recordOffset, doc: parsed.doc! });
          }
        } else {
          const parsed = this.readRecordV1(pos, fileSize);
          if (!parsed) break;
          pos = parsed.nextPos;
          scannedTotal++;
          if (parsed.active) {
            scannedActive++;
            results.push({ offset: recordOffset, doc: parsed.doc! });
          }
        }
      } catch (err) {
        if (err instanceof ChecksumError) {
          this.corruptedRecords++;
          pos = this.findNextRecord(pos + 1, fileSize);
          if (pos < 0) break;
          continue;
        }
        break;
      }
    }

    if (scannedTotal !== this.totalRecords || scannedActive !== this.activeRecords) {
      this.totalRecords = scannedTotal;
      this.activeRecords = scannedActive;
      this.flushHeader();
    }

    return results;
  }

  /** Read a v2 record at position */
  private readRecordV2(pos: number, fileSize: number): { active: boolean; doc?: Document; nextPos: number } | null {
    if (this.fd === null || pos + 1 > fileSize) return null;

    const statusBuf = Buffer.alloc(1);
    if (fs.readSync(this.fd, statusBuf, 0, 1, pos) < 1) return null;
    const status = statusBuf.readUInt8(0);
    pos += 1;

    if (pos + 4 > fileSize) return null;
    const crcBuf = Buffer.alloc(4);
    fs.readSync(this.fd, crcBuf, 0, 4, pos);
    const expectedCRC = crcBuf.readUInt32LE(0);
    pos += 4;

    const payloadStart = pos;

    if (pos + 2 > fileSize) return null;
    const keyLenBuf = Buffer.alloc(2);
    fs.readSync(this.fd, keyLenBuf, 0, 2, pos);
    const keyLen = keyLenBuf.readUInt16LE(0);
    pos += 2;

    if (pos + keyLen > fileSize) return null;
    const keyBuf = Buffer.alloc(keyLen);
    fs.readSync(this.fd, keyBuf, 0, keyLen, pos);
    const key = keyBuf.toString('utf-8');
    pos += keyLen;

    if (pos + 8 > fileSize) return null;
    const tsBuf = Buffer.alloc(8);
    fs.readSync(this.fd, tsBuf, 0, 8, pos);
    const ts = tsBuf.readDoubleLE(0);
    pos += 8;

    if (pos + 1 > fileSize) return null;
    const flagsBuf = Buffer.alloc(1);
    fs.readSync(this.fd, flagsBuf, 0, 1, pos);
    const flags = flagsBuf.readUInt8(0);
    pos += 1;

    if (pos + 4 > fileSize) return null;
    const dataLenBuf = Buffer.alloc(4);
    fs.readSync(this.fd, dataLenBuf, 0, 4, pos);
    const dataLen = dataLenBuf.readUInt32LE(0);
    pos += 4;

    if (pos + dataLen > fileSize) return null;
    const dataBuf = Buffer.alloc(dataLen);
    fs.readSync(this.fd, dataBuf, 0, dataLen, pos);
    pos += dataLen;

    const payloadLen = pos - payloadStart;
    const payloadBuf = Buffer.alloc(payloadLen);
    fs.readSync(this.fd, payloadBuf, 0, payloadLen, payloadStart);
    const actualCRC = crc32(payloadBuf);
    if (actualCRC !== expectedCRC) {
      throw new ChecksumError(this.filePath, payloadStart - 5, expectedCRC, actualCRC);
    }

    if (status !== RecordStatus.Active) {
      return { active: false, nextPos: pos };
    }

    let decodedData: Buffer = dataBuf;
    if (flags & RecordFlags.Encrypted) {
      if (!this.encryptionKey) {
        return { active: false, nextPos: pos };
      }
      decodedData = Buffer.from(decrypt(decodedData, this.encryptionKey));
    }
    if (flags & RecordFlags.Compressed) {
      decodedData = Buffer.from(decompress(decodedData));
    }

    try {
      const parsed = JSON.parse(decodedData.toString('utf-8'));
      const doc: Document = { ...parsed, _id: key, _ts: ts };
      return { active: true, doc, nextPos: pos };
    } catch {
      this.corruptedRecords++;
      return { active: false, nextPos: pos };
    }
  }

  /** Read a v1 record (backward compatibility) */
  private readRecordV1(pos: number, fileSize: number): { active: boolean; doc?: Document; nextPos: number } | null {
    if (this.fd === null || pos + 1 > fileSize) return null;

    const statusBuf = Buffer.alloc(1);
    if (fs.readSync(this.fd, statusBuf, 0, 1, pos) < 1) return null;
    const status = statusBuf.readUInt8(0);
    pos += 1;

    if (pos + 2 > fileSize) return null;
    const keyLenBuf = Buffer.alloc(2);
    fs.readSync(this.fd, keyLenBuf, 0, 2, pos);
    const keyLen = keyLenBuf.readUInt16LE(0);
    pos += 2;

    if (pos + keyLen > fileSize) return null;
    const keyBuf = Buffer.alloc(keyLen);
    fs.readSync(this.fd, keyBuf, 0, keyLen, pos);
    const key = keyBuf.toString('utf-8');
    pos += keyLen;

    if (pos + 8 > fileSize) return null;
    const tsBuf = Buffer.alloc(8);
    fs.readSync(this.fd, tsBuf, 0, 8, pos);
    const ts = tsBuf.readDoubleLE(0);
    pos += 8;

    if (pos + 4 > fileSize) return null;
    const dataLenBuf = Buffer.alloc(4);
    fs.readSync(this.fd, dataLenBuf, 0, 4, pos);
    const dataLen = dataLenBuf.readUInt32LE(0);
    pos += 4;

    if (pos + dataLen > fileSize) return null;
    const dataBuf = Buffer.alloc(dataLen);
    fs.readSync(this.fd, dataBuf, 0, dataLen, pos);
    pos += dataLen;

    if (status !== RecordStatus.Active) {
      return { active: false, nextPos: pos };
    }

    try {
      const parsed = JSON.parse(dataBuf.toString('utf-8'));
      return { active: true, doc: { ...parsed, _id: key, _ts: ts }, nextPos: pos };
    } catch {
      return { active: false, nextPos: pos };
    }
  }

  /** Attempt to find the next valid record after corruption */
  private findNextRecord(startPos: number, fileSize: number): number {
    if (this.fd === null) return -1;
    const buf = Buffer.alloc(3);
    for (let pos = startPos; pos < fileSize - 3; pos++) {
      fs.readSync(this.fd, buf, 0, 3, pos);
      const status = buf.readUInt8(0);
      if (status === RecordStatus.Active || status === RecordStatus.Deleted) {
        const peek = Buffer.alloc(6);
        if (fs.readSync(this.fd, peek, 0, 6, pos + 1) < 6) continue;
        const keyLen = peek.readUInt16LE(4);
        if (keyLen > 0 && keyLen < 1024) return pos;
      }
    }
    return -1;
  }

  // Write operations

  /**
   * Append a new record with WAL protection.
   * Returns the byte offset of the record.
   */
  append(id: string, ts: number, data: Record<string, any>): number {
    if (this.fd === null) throw new Error('Storage not opened');

    const dataJson = JSON.stringify(data);

    this.wal.log({ op: WALOp.Insert, key: id, ts, data: dataJson });
    try {
      const writePos = this.appendRecord(id, ts, data);
      this.wal.commit();
      return writePos;
    } catch (err) {
      this.wal.close();
      throw err;
    }
  }

  /** Replace an active record with a new version in one WAL-backed batch */
  update(oldOffset: number, id: string, ts: number, data: Record<string, any>): number {
    if (this.fd === null) throw new Error('Storage not opened');

    const dataJson = JSON.stringify(data);

    this.wal.log({ op: WALOp.Update, key: id, ts, data: dataJson });
    try {
      this.markDeletedAt(oldOffset);
      const writePos = this.appendRecord(id, ts, data);
      this.wal.commit();
      return writePos;
    } catch (err) {
      this.wal.close();
      throw err;
    }
  }

  private appendRecord(id: string, ts: number, data: Record<string, any>): number {
    if (this.fd === null) throw new Error('Storage not opened');

    const keyBuf = Buffer.from(id, 'utf-8');
    let dataBuf: Buffer = Buffer.from(JSON.stringify(data), 'utf-8');
    let flags = RecordFlags.None;

    if (this.compressionEnabled) {
      const compressed = smartCompress(dataBuf);
      if (compressed.compressed) {
        dataBuf = Buffer.from(compressed.data);
        flags |= RecordFlags.Compressed;
      }
    }

    if (this.encryptionKey) {
      dataBuf = Buffer.from(encrypt(dataBuf, this.encryptionKey));
      flags |= RecordFlags.Encrypted;
    }

    const payloadSize = 2 + keyBuf.length + 8 + 1 + 4 + dataBuf.length;
    const payload = Buffer.alloc(payloadSize);
    let off = 0;
    payload.writeUInt16LE(keyBuf.length, off); off += 2;
    keyBuf.copy(payload, off); off += keyBuf.length;
    payload.writeDoubleLE(ts, off); off += 8;
    payload.writeUInt8(flags, off); off += 1;
    payload.writeUInt32LE(dataBuf.length, off); off += 4;
    dataBuf.copy(payload, off);

    const crcValue = crc32(payload);
    const recordSize = 1 + 4 + payloadSize;
    const record = Buffer.alloc(recordSize);
    record.writeUInt8(RecordStatus.Active, 0);
    record.writeUInt32LE(crcValue, 1);
    payload.copy(record, 5);

    const writePos = fs.fstatSync(this.fd).size;
    fs.writeSync(this.fd, record, 0, recordSize, writePos);

    this.totalRecords++;
    this.activeRecords++;
    this.flushHeader();

    return writePos;
  }

  /** Mark a record as deleted (tombstone) with WAL */
  markDeleted(offset: number, key?: string): void {
    if (this.fd === null) return;
    if (!key) {
      this.markDeletedAt(offset);
      return;
    }

    this.wal.log({ op: WALOp.Delete, key, ts: Date.now() });
    try {
      this.markDeletedAt(offset);
      this.wal.commit();
    } catch (err) {
      this.wal.close();
      throw err;
    }
  }

  private markDeletedAt(offset: number): void {
    if (this.fd === null) return;
    const tombstone = Buffer.alloc(1);
    tombstone.writeUInt8(RecordStatus.Deleted, 0);
    fs.writeSync(this.fd, tombstone, 0, 1, offset);
    if (this.activeRecords > 0) {
      this.activeRecords--;
    }
    this.flushHeader();
  }

  // Compaction

  compact(docs: Document[]): void {
    if (this.fd === null) return;

    this.wal.log({ op: WALOp.Compact, key: '__compact__', ts: Date.now() });

    const tmpPath = this.filePath + '.tmp';
    const tmpFd = fs.openSync(tmpPath, 'w+');

    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt8(VERSION, 4);
    header.writeUInt8(this.collectionFlags, 5);
    header.writeDoubleLE(this.createdAt, 8);
    header.writeDoubleLE(Date.now(), 16);
    header.writeUInt32LE(docs.length, 24);
    header.writeUInt32LE(docs.length, 28);
    fs.writeSync(tmpFd, header, 0, HEADER_SIZE, 0);

    let pos = HEADER_SIZE;
    for (const doc of docs) {
      const { _id, _ts, ...rest } = doc;
      const keyBuf = Buffer.from(_id, 'utf-8');
      let dataBuf: Buffer = Buffer.from(JSON.stringify(rest), 'utf-8');
      let flags = RecordFlags.None;

      if (this.compressionEnabled) {
        const compressed = smartCompress(dataBuf);
        if (compressed.compressed) {
          dataBuf = Buffer.from(compressed.data);
          flags |= RecordFlags.Compressed;
        }
      }
      if (this.encryptionKey) {
        dataBuf = Buffer.from(encrypt(dataBuf, this.encryptionKey));
        flags |= RecordFlags.Encrypted;
      }

      const payloadSize = 2 + keyBuf.length + 8 + 1 + 4 + dataBuf.length;
      const payload = Buffer.alloc(payloadSize);
      let off = 0;
      payload.writeUInt16LE(keyBuf.length, off); off += 2;
      keyBuf.copy(payload, off); off += keyBuf.length;
      payload.writeDoubleLE(_ts, off); off += 8;
      payload.writeUInt8(flags, off); off += 1;
      payload.writeUInt32LE(dataBuf.length, off); off += 4;
      dataBuf.copy(payload, off);

      const crcValue = crc32(payload);
      const recordSize = 1 + 4 + payloadSize;
      const record = Buffer.alloc(recordSize);
      record.writeUInt8(RecordStatus.Active, 0);
      record.writeUInt32LE(crcValue, 1);
      payload.copy(record, 5);

      fs.writeSync(tmpFd, record, 0, recordSize, pos);
      pos += recordSize;
    }

    fs.closeSync(tmpFd);

    fs.closeSync(this.fd);
    fs.renameSync(tmpPath, this.filePath);
    this.fd = fs.openSync(this.filePath, 'r+');
    this.totalRecords = docs.length;
    this.activeRecords = docs.length;
    this.readHeader();
    this.wal.commit();
  }

  shouldCompact(): boolean {
    if (this.totalRecords < 50) return false;
    const tombstones = this.totalRecords - this.activeRecords;
    return tombstones / this.totalRecords > 0.3;
  }

  // WAL replay

  private async replayWAL(): Promise<void> {
    const entries = this.wal.recover();
    if (entries.length === 0) {
      this.wal.clear();
      return;
    }

    const activeByKey = new Map<string, { offset: number; doc: Document }>();
    for (const record of this.scanAll()) {
      activeByKey.set(record.doc._id, record);
    }

    for (const entry of entries) {
      switch (entry.op) {
        case WALOp.Insert:
        case WALOp.Update: {
          if (!entry.data) {
            continue;
          }

          let parsed: Record<string, any>;
          try {
            parsed = JSON.parse(entry.data);
          } catch {
            continue;
          }

          const existing = activeByKey.get(entry.key);
          if (existing?.doc._ts === entry.ts) {
            continue;
          }
          if (existing) {
            this.markDeletedAt(existing.offset);
          }

          const offset = this.appendRecord(entry.key, entry.ts, parsed);
          activeByKey.set(entry.key, {
            offset,
            doc: { ...parsed, _id: entry.key, _ts: entry.ts },
          });
          break;
        }

        case WALOp.Delete: {
          const existing = activeByKey.get(entry.key);
          if (!existing) {
            continue;
          }
          this.markDeletedAt(existing.offset);
          activeByKey.delete(entry.key);
          break;
        }

        case WALOp.Compact:
          break;
      }
    }

    this.wal.clear();
  }

  // Stats

  getStats() {
    return {
      version: VERSION,
      total: this.totalRecords,
      active: this.activeRecords,
      tombstones: this.totalRecords - this.activeRecords,
      corrupted: this.corruptedRecords,
      compressed: this.compressionEnabled,
      encrypted: !!this.encryptionKey,
      created: this.createdAt,
      modified: this.modifiedAt,
      file: this.filePath,
      fileSize: this.fd !== null ? fs.fstatSync(this.fd).size : 0,
    };
  }
}
