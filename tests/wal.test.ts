import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WriteAheadLog, WALOp } from '../src/wal';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-wal-'));
}

describe('WriteAheadLog', () => {
  let dir: string;
  let dbPath: string;
  let wal: WriteAheadLog;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = path.join(dir, 'test.agdb');
    wal = new WriteAheadLog(dbPath);
  });

  afterEach(() => {
    try { wal.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Basic operations ──────────────────────────────────

  describe('basic ops', () => {
    it('hasPending returns false when no WAL', () => {
      expect(wal.hasPending()).toBe(false);
    });

    it('begin creates WAL file', () => {
      wal.begin();
      // File exists but might be empty (truncated)
      expect(fs.existsSync(dbPath + '.wal')).toBe(true);
      wal.close();
    });

    it('log writes entries to WAL', () => {
      wal.begin();
      wal.log({
        op: 0x01 as WALOp, // Insert
        key: 'doc1',
        ts: Date.now(),
        data: JSON.stringify({ name: 'Alice' }),
      });
      // WAL file should be non-empty
      const stat = fs.statSync(dbPath + '.wal');
      expect(stat.size).toBeGreaterThan(0);
      wal.close();
    });

    it('commit clears WAL file', () => {
      wal.begin();
      wal.log({
        op: 0x01 as WALOp,
        key: 'doc1',
        ts: Date.now(),
        data: JSON.stringify({ x: 1 }),
      });
      wal.commit();
      expect(wal.hasPending()).toBe(false);
    });

    it('rollback clears WAL file', () => {
      wal.begin();
      wal.log({
        op: 0x01 as WALOp,
        key: 'doc1',
        ts: Date.now(),
      });
      wal.rollback();
      expect(wal.hasPending()).toBe(false);
    });
  });

  // ── Recovery ──────────────────────────────────────────

  describe('recovery', () => {
    it('recover returns empty for no WAL', () => {
      expect(wal.recover()).toEqual([]);
    });

    it('recover reads uncommitted entries', () => {
      wal.begin();
      const ts = Date.now();
      wal.log({
        op: 0x01 as WALOp,
        key: 'doc1',
        ts,
        data: JSON.stringify({ name: 'Alice' }),
      });
      wal.log({
        op: 0x03 as WALOp, // Update
        key: 'doc2',
        ts,
        data: JSON.stringify({ name: 'Bob' }),
      });
      // Close without commit — simulate crash
      wal.close();

      // New WAL instance reads pending entries
      const wal2 = new WriteAheadLog(dbPath);
      const entries = wal2.recover();
      expect(entries.length).toBe(2);
      expect(entries[0].key).toBe('doc1');
      expect(entries[0].op).toBe(0x01);
      expect(entries[1].key).toBe('doc2');
      expect(entries[1].op).toBe(0x03);
      wal2.close();
    });

    it('recover returns empty after commit', () => {
      wal.begin();
      wal.log({
        op: 0x01 as WALOp,
        key: 'doc1',
        ts: Date.now(),
        data: JSON.stringify({ x: 1 }),
      });
      wal.commit();

      const wal2 = new WriteAheadLog(dbPath);
      expect(wal2.recover()).toEqual([]);
      wal2.close();
    });

    it('recover handles entries without data', () => {
      wal.begin();
      wal.log({
        op: 0x02 as WALOp, // Delete — no data
        key: 'doc1',
        ts: Date.now(),
      });
      wal.close();

      const wal2 = new WriteAheadLog(dbPath);
      const entries = wal2.recover();
      expect(entries.length).toBe(1);
      expect(entries[0].key).toBe('doc1');
      expect(entries[0].data).toBeUndefined();
      wal2.close();
    });
  });

  // ── Integrity ─────────────────────────────────────────

  describe('integrity', () => {
    it('stops recovery at corrupted entry', () => {
      wal.begin();
      wal.log({
        op: 0x01 as WALOp,
        key: 'good',
        ts: Date.now(),
        data: JSON.stringify({ ok: true }),
      });
      wal.close();

      // Corrupt the WAL by flipping a byte
      const walPath = dbPath + '.wal';
      const buf = fs.readFileSync(walPath);
      // Flip a byte in the middle of the entry (after CRC)
      buf[buf.length - 2] ^= 0xFF;
      fs.writeFileSync(walPath, buf);

      const wal2 = new WriteAheadLog(dbPath);
      const entries = wal2.recover();
      // Should stop at corrupted entry — returns 0
      expect(entries.length).toBe(0);
      wal2.close();
    });

    it('clear removes WAL file', () => {
      wal.begin();
      wal.log({
        op: 0x01 as WALOp,
        key: 'doc1',
        ts: Date.now(),
      });
      wal.close();
      wal.clear();
      expect(fs.existsSync(dbPath + '.wal')).toBe(false);
    });
  });

  // ── Auto-begin ────────────────────────────────────────

  describe('auto-begin', () => {
    it('log auto-opens WAL if not begun', () => {
      // Don't call begin — log should auto-open
      wal.log({
        op: 0x01 as WALOp,
        key: 'auto',
        ts: Date.now(),
        data: JSON.stringify({ auto: true }),
      });
      wal.close();

      const wal2 = new WriteAheadLog(dbPath);
      const entries = wal2.recover();
      expect(entries.length).toBe(1);
      expect(entries[0].key).toBe('auto');
      wal2.close();
    });
  });
});
