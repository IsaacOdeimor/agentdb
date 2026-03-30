import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentDB } from '../src/database';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-db-'));
}

describe('AgentDB', () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = tmpDir();
    db = new AgentDB(dir);
    await db.open();
  });

  afterEach(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Open / Close ──────────────────────────────────────

  describe('open / close', () => {
    it('opens and reports isOpen', () => {
      expect(db.isOpen()).toBe(true);
    });

    it('close sets isOpen to false', () => {
      db.close();
      expect(db.isOpen()).toBe(false);
    });

    it('double open is a no-op', async () => {
      await db.open(); // second call
      expect(db.isOpen()).toBe(true);
    });

    it('creates data directory if it does not exist', async () => {
      const nested = path.join(dir, 'sub', 'deep');
      const db2 = new AgentDB(nested);
      await db2.open();
      expect(fs.existsSync(nested)).toBe(true);
      db2.close();
    });

    it('rejects opening the same directory twice', async () => {
      const db2 = new AgentDB(dir);
      await expect(db2.open()).rejects.toThrow('already in use');
    });

    it('clears a stale lock file on open', async () => {
      const staleDir = path.join(dir, 'stale');
      fs.mkdirSync(staleDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleDir, '.agentdb.lock'),
        JSON.stringify({ pid: 999999, createdAt: 0, dir: staleDir }),
        'utf-8'
      );

      const db2 = new AgentDB(staleDir);
      await db2.open();
      expect(db2.isOpen()).toBe(true);
      expect(fs.existsSync(path.join(staleDir, '.agentdb.lock'))).toBe(true);
      db2.close();
      expect(fs.existsSync(path.join(staleDir, '.agentdb.lock'))).toBe(false);
    });
  });

  // ── Collections ─────────────────────────────────────────

  describe('collections', () => {
    it('creates and retrieves a collection', () => {
      const col = db.collection('users');
      col.insert({ name: 'Alice' });
      expect(col.count()).toBe(1);
    });

    it('returns same instance for same name', () => {
      const a = db.collection('test');
      const b = db.collection('test');
      expect(a).toBe(b);
    });

    it('listCollections returns all created', () => {
      db.collection('users');
      db.collection('messages');
      expect(db.listCollections().sort()).toEqual(['messages', 'users']);
    });

    it('getCollection returns a loaded collection', async () => {
      const col = await db.getCollection('items');
      col.insert({ x: 1 });
      expect(col.count()).toBe(1);
    });

    it('dropCollection removes collection and file', () => {
      const col = db.collection('temp');
      col.insert({ x: 1 });
      expect(db.dropCollection('temp')).toBe(true);
      expect(db.listCollections().includes('temp')).toBe(false);
      expect(fs.existsSync(path.join(dir, 'temp.agdb'))).toBe(false);
    });

    it('dropCollection returns false for nonexistent', () => {
      expect(db.dropCollection('nope')).toBe(false);
    });
  });

  // ── Persistence ─────────────────────────────────────────

  describe('persistence', () => {
    it('data survives close and reopen', async () => {
      const col = db.collection('persist');
      col.insert({ name: 'Saved' });
      db.close();

      const db2 = new AgentDB(dir);
      await db2.open();
      const col2 = db2.collection('persist');
      expect(col2.count()).toBe(1);
      expect(col2.find()[0].name).toBe('Saved');
      db2.close();

      // Reassign for afterEach cleanup
      db = new AgentDB(dir);
      await db.open();
    });
  });

  // ── Stats ───────────────────────────────────────────────

  describe('stats', () => {
    it('returns database stats', () => {
      db.collection('a').insert({ x: 1 });
      db.collection('b').insert({ y: 2 });
      const s = db.stats();
      expect(s.dataDir).toBe(dir);
      expect(s.collectionCount).toBe(2);
      expect(s.collections).toHaveProperty('a');
      expect(s.collections).toHaveProperty('b');
      expect(s.encrypted).toBe(false);
      expect(s.compression).toBe(false);
    });
  });

  // ── Compression ─────────────────────────────────────────

  describe('compression option', () => {
    it('works with compression enabled', async () => {
      db.close();
      const db2 = new AgentDB(dir, { compressionEnabled: true });
      await db2.open();
      const col = db2.collection('compressed');
      col.insert({ text: 'hello'.repeat(100) });
      expect(col.count()).toBe(1);
      expect(col.find()[0].text).toBe('hello'.repeat(100));
      expect(db2.stats().compression).toBe(true);
      db2.close();

      db = new AgentDB(dir);
      await db.open();
    });
  });

  // ── Encryption ──────────────────────────────────────────

  describe('encryption option', () => {
    it('works with encryption key', async () => {
      db.close();
      const encDir = path.join(dir, 'encrypted');
      const db2 = new AgentDB(encDir, { encryptionKey: 'my-secret' });
      await db2.open();

      const col = db2.collection('secrets');
      col.insert({ password: 'hunter2' });
      expect(col.count()).toBe(1);
      expect(col.find()[0].password).toBe('hunter2');
      expect(db2.stats().encrypted).toBe(true);

      // Verify data is encrypted on disk
      const filePath = path.join(encDir, 'secrets.agdb');
      const raw = fs.readFileSync(filePath);
      expect(raw.includes('hunter2')).toBe(false);

      db2.close();

      // Reopen with same password
      const db3 = new AgentDB(encDir, { encryptionKey: 'my-secret' });
      await db3.open();
      const col3 = db3.collection('secrets');
      expect(col3.find()[0].password).toBe('hunter2');
      db3.close();

      db = new AgentDB(dir);
      await db.open();
    });
  });

  // ── TTL ─────────────────────────────────────────────────

  describe('TTL purge', () => {
    it('purgeAllExpired removes expired docs across collections', () => {
      const a = db.collection('a');
      const b = db.collection('b');
      a.insert({ _ttl: Date.now() - 1000 });
      a.insert({ _ttl: Date.now() + 100000 });
      b.insert({ _ttl: Date.now() - 2000 });

      const purged = db.purgeAllExpired();
      expect(purged).toBe(2);
      expect(a.count()).toBe(1);
      expect(b.count()).toBe(0);
    });
  });

  // ── Export / Import JSON ────────────────────────────────

  describe('JSON export/import', () => {
    it('exports and imports collection as JSON', () => {
      const col = db.collection('data');
      col.insert({ name: 'Alice' });
      col.insert({ name: 'Bob' });

      const jsonPath = path.join(dir, 'export.json');
      db.exportJSON('data', jsonPath);
      expect(fs.existsSync(jsonPath)).toBe(true);

      const imported = db.importJSON('imported', jsonPath);
      expect(imported).toBe(2);

      const col2 = db.collection('imported');
      expect(col2.count()).toBe(2);
    });

    it('exportJSON throws for nonexistent collection', () => {
      expect(() => db.exportJSON('nope', path.join(dir, 'x.json'))).toThrow('not found');
    });
  });

  describe('full text search', () => {
    it('searches a collection by token score', () => {
      const col = db.collection('docs');
      col.insert({ title: 'Ghost memory panel', body: 'export import memory panel' });
      col.insert({ title: 'AgentDB rotation', body: 'rotate encryption key safely' });
      col.insert({ title: 'Ghost shell', body: 'panel without memory tools' });

      const results = db.fullTextSearch('docs', 'ghost memory panel', ['title', 'body']);
      expect(results.length).toBe(2);
      expect(results[0].title).toBe('Ghost memory panel');
    });
  });

  describe('encryption key rotation', () => {
    it('rotates the encryption key and preserves records', async () => {
      db.close();
      const encDir = path.join(dir, 'rotate');
      const encryptedDb = new AgentDB(encDir, { encryptionKey: 'old-secret' });
      await encryptedDb.open();

      const col = encryptedDb.collection('secrets');
      col.insert({ secret: 'ghost' });

      await encryptedDb.rotateEncryptionKey('old-secret', 'new-secret');
      encryptedDb.close();

      const reopened = new AgentDB(encDir, { encryptionKey: 'new-secret' });
      await reopened.open();
      expect(reopened.collection('secrets').find()[0].secret).toBe('ghost');
      await expect(reopened.rotateEncryptionKey('old-secret', 'third-secret')).rejects.toThrow();
      reopened.close();

      db = new AgentDB(dir);
      await db.open();
    });
  });
});
