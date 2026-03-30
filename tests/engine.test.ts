import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageEngine } from '../src/engine';
import { WriteAheadLog, WALOp } from '../src/wal';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-test-'));
}

describe('StorageEngine', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = path.join(dir, 'test.agdb');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new file with valid header', async () => {
    const engine = new StorageEngine(filePath);
    await engine.open();
    expect(fs.existsSync(filePath)).toBe(true);

    const stats = engine.getStats();
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.version).toBe(2);

    engine.close();
  });

  it('appends and scans records', async () => {
    const engine = new StorageEngine(filePath);
    await engine.open();

    engine.append('doc1', Date.now(), { name: 'Alice', age: 30 });
    engine.append('doc2', Date.now(), { name: 'Bob', age: 25 });
    engine.append('doc3', Date.now(), { name: 'Charlie', age: 35 });

    const records = engine.scanAll();
    expect(records.length).toBe(3);
    expect(records[0].doc._id).toBe('doc1');
    expect(records[0].doc.name).toBe('Alice');
    expect(records[1].doc._id).toBe('doc2');
    expect(records[2].doc._id).toBe('doc3');

    const stats = engine.getStats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(3);

    engine.close();
  });

  it('marks records as deleted (tombstone)', async () => {
    const engine = new StorageEngine(filePath);
    await engine.open();

    const offset1 = engine.append('doc1', Date.now(), { x: 1 });
    engine.append('doc2', Date.now(), { x: 2 });

    engine.markDeleted(offset1);

    const records = engine.scanAll();
    expect(records.length).toBe(1);
    expect(records[0].doc._id).toBe('doc2');

    const stats = engine.getStats();
    expect(stats.tombstones).toBe(1);

    engine.close();
  });

  it('compacts the file', async () => {
    const engine = new StorageEngine(filePath);
    await engine.open();

    engine.append('doc1', Date.now(), { x: 1 });
    const offset2 = engine.append('doc2', Date.now(), { x: 2 });
    engine.append('doc3', Date.now(), { x: 3 });
    engine.markDeleted(offset2);

    const sizeBefore = fs.statSync(filePath).size;

    const activeDocs = engine.scanAll().map(r => r.doc);
    engine.compact(activeDocs);

    const sizeAfter = fs.statSync(filePath).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);

    const records = engine.scanAll();
    expect(records.length).toBe(2);
    expect(records[0].doc._id).toBe('doc1');
    expect(records[1].doc._id).toBe('doc3');

    engine.close();
  });

  it('persists across close and reopen', async () => {
    const engine1 = new StorageEngine(filePath);
    await engine1.open();
    engine1.append('persistent', Date.now(), { saved: true });
    engine1.close();

    const engine2 = new StorageEngine(filePath);
    await engine2.open();
    const records = engine2.scanAll();
    expect(records.length).toBe(1);
    expect(records[0].doc._id).toBe('persistent');
    expect(records[0].doc.saved).toBe(true);
    engine2.close();
  });

  it('works with compression enabled', async () => {
    const engine = new StorageEngine(filePath);
    engine.setCompression(true);
    await engine.open();

    const largeData = { text: 'a'.repeat(500), repeated: 'data'.repeat(100) };
    engine.append('compressed', Date.now(), largeData);

    const records = engine.scanAll();
    expect(records.length).toBe(1);
    expect(records[0].doc.text).toBe('a'.repeat(500));

    engine.close();
  });

  it('works with encryption enabled', async () => {
    const { deriveKey } = await import('../src/encryption');
    const key = deriveKey('test-password');

    const engine = new StorageEngine(filePath);
    engine.setEncryptionKey(key.key);
    await engine.open();

    engine.append('secret', Date.now(), { password: 'hunter2' });

    // Verify data is encrypted on disk (raw read shouldn't contain plaintext)
    const raw = fs.readFileSync(filePath);
    expect(raw.includes('hunter2')).toBe(false);

    // But engine can read it back
    const records = engine.scanAll();
    expect(records.length).toBe(1);
    expect(records[0].doc.password).toBe('hunter2');

    engine.close();
  });

  it('self-heals header counts on corruption', async () => {
    const engine = new StorageEngine(filePath);
    await engine.open();
    engine.append('doc1', Date.now(), { x: 1 });
    engine.append('doc2', Date.now(), { x: 2 });

    // Corrupt header: write wrong counts
    const fd = fs.openSync(filePath, 'r+');
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(999, 0);
    fs.writeSync(fd, buf, 0, 4, 24); // total records
    fs.closeSync(fd);

    engine.close();

    // Reopen and scan — should self-heal
    const engine2 = new StorageEngine(filePath);
    await engine2.open();
    const records = engine2.scanAll();
    expect(records.length).toBe(2);

    const stats = engine2.getStats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(2);

    engine2.close();
  });

  it('shouldCompact returns true when threshold exceeded', async () => {
    const engine = new StorageEngine(filePath);
    await engine.open();

    // Create 60 records, delete 25 (>30% tombstones, >50 total)
    const offsets: number[] = [];
    for (let i = 0; i < 60; i++) {
      offsets.push(engine.append(`doc${i}`, Date.now(), { i }));
    }
    for (let i = 0; i < 25; i++) {
      engine.markDeleted(offsets[i]);
    }

    expect(engine.shouldCompact()).toBe(true);
    engine.close();
  });

  it('replays pending WAL inserts on open', async () => {
    const engine1 = new StorageEngine(filePath);
    await engine1.open();
    engine1.close();

    const wal = new WriteAheadLog(filePath);
    wal.log({
      op: WALOp.Insert,
      key: 'recovered',
      ts: 123,
      data: JSON.stringify({ saved: true }),
    });
    wal.close();

    const engine2 = new StorageEngine(filePath);
    await engine2.open();

    const records = engine2.scanAll();
    expect(records.length).toBe(1);
    expect(records[0].doc._id).toBe('recovered');
    expect(records[0].doc._ts).toBe(123);
    expect(records[0].doc.saved).toBe(true);
    expect(fs.existsSync(filePath + '.wal')).toBe(false);

    engine2.close();
  });

  it('replays pending WAL deletes on open', async () => {
    const engine1 = new StorageEngine(filePath);
    await engine1.open();
    engine1.append('doc1', 456, { saved: true });
    engine1.close();

    const wal = new WriteAheadLog(filePath);
    wal.log({
      op: WALOp.Delete,
      key: 'doc1',
      ts: 789,
    });
    wal.close();

    const engine2 = new StorageEngine(filePath);
    await engine2.open();

    expect(engine2.scanAll()).toHaveLength(0);
    expect(fs.existsSync(filePath + '.wal')).toBe(false);

    engine2.close();
  });

  it('replays pending WAL updates atomically on open', async () => {
    const engine1 = new StorageEngine(filePath);
    await engine1.open();
    engine1.append('doc1', 100, { version: 'old', saved: true });
    engine1.close();

    const wal = new WriteAheadLog(filePath);
    wal.log({
      op: WALOp.Update,
      key: 'doc1',
      ts: 200,
      data: JSON.stringify({ version: 'new', saved: false }),
    });
    wal.close();

    const engine2 = new StorageEngine(filePath);
    await engine2.open();

    const records = engine2.scanAll();
    expect(records).toHaveLength(1);
    expect(records[0].doc._id).toBe('doc1');
    expect(records[0].doc._ts).toBe(200);
    expect(records[0].doc.version).toBe('new');
    expect(records[0].doc.saved).toBe(false);
    expect(engine2.getStats().active).toBe(1);
    expect(fs.existsSync(filePath + '.wal')).toBe(false);

    engine2.close();
  });
});
