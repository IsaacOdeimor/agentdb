import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageEngine } from '../src/engine';
import { Collection } from '../src/collection';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-col-'));
}

describe('Collection', () => {
  let dir: string;
  let col: Collection;

  beforeEach(async () => {
    dir = tmpDir();
    const engine = new StorageEngine(path.join(dir, 'test.agdb'));
    col = new Collection('test', engine);
    await col.load();
  });

  afterEach(() => {
    col.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── CRUD ──────────────────────────────────────────────

  describe('CRUD', () => {
    it('inserts and retrieves by ID', () => {
      const id = col.insert({ name: 'Alice', age: 30 });
      const doc = col.findById(id);
      expect(doc).not.toBeNull();
      expect(doc!.name).toBe('Alice');
      expect(doc!.age).toBe(30);
      expect(doc!._id).toBe(id);
      expect(doc!._ts).toBeGreaterThan(0);
    });

    it('insertMany returns array of IDs', () => {
      const ids = col.insertMany([
        { name: 'A' },
        { name: 'B' },
        { name: 'C' },
      ]);
      expect(ids.length).toBe(3);
      expect(col.count()).toBe(3);
    });

    it('find with no filter returns all', () => {
      col.insert({ x: 1 });
      col.insert({ x: 2 });
      col.insert({ x: 3 });
      expect(col.find().length).toBe(3);
    });

    it('find with filter returns matching', () => {
      col.insert({ role: 'admin', name: 'A' });
      col.insert({ role: 'user', name: 'B' });
      col.insert({ role: 'admin', name: 'C' });
      const admins = col.find({ role: 'admin' });
      expect(admins.length).toBe(2);
    });

    it('update merges fields', () => {
      const id = col.insert({ name: 'Alice', age: 30 });
      const updated = col.update(id, { age: 31, verified: true });
      expect(updated!.name).toBe('Alice');
      expect(updated!.age).toBe(31);
      expect(updated!.verified).toBe(true);
    });

    it('update returns null for non-existent ID', () => {
      expect(col.update('nonexistent', { x: 1 })).toBeNull();
    });

    it('upsert creates if not exists', () => {
      const { doc, created } = col.upsert('new_id', { name: 'New' });
      expect(created).toBe(true);
      expect(doc.name).toBe('New');
    });

    it('upsert updates if exists', () => {
      const id = col.insert({ name: 'Old' });
      const { doc, created } = col.upsert(id, { name: 'Updated' });
      expect(created).toBe(false);
      expect(doc.name).toBe('Updated');
    });

    it('delete removes document', () => {
      const id = col.insert({ name: 'Delete me' });
      expect(col.delete(id)).toBe(true);
      expect(col.findById(id)).toBeNull();
      expect(col.count()).toBe(0);
    });

    it('delete returns false for non-existent', () => {
      expect(col.delete('nope')).toBe(false);
    });

    it('deleteMany removes matching docs', () => {
      col.insert({ type: 'a' });
      col.insert({ type: 'b' });
      col.insert({ type: 'a' });
      expect(col.deleteMany({ type: 'a' })).toBe(2);
      expect(col.count()).toBe(1);
    });

    it('clear removes all', () => {
      col.insertMany([{ x: 1 }, { x: 2 }, { x: 3 }]);
      expect(col.clear()).toBe(3);
      expect(col.count()).toBe(0);
    });

    it('replace overwrites entire document', () => {
      const id = col.insert({ name: 'Alice', age: 30, extra: true });
      const replaced = col.replace(id, { name: 'Bob' });
      expect(replaced!.name).toBe('Bob');
      expect(replaced!.age).toBeUndefined();
      expect(replaced!.extra).toBeUndefined();
    });

    it('update persists as a single active document after reload', async () => {
      const id = col.insert({ name: 'Alice', age: 30 });
      col.update(id, { age: 31, verified: true });
      col.close();

      const engine2 = new StorageEngine(path.join(dir, 'test.agdb'));
      const col2 = new Collection('test', engine2);
      await col2.load();

      expect(col2.count()).toBe(1);
      const doc = col2.findById(id);
      expect(doc).not.toBeNull();
      expect(doc!.age).toBe(31);
      expect(doc!.verified).toBe(true);

      col2.close();
      const engine3 = new StorageEngine(path.join(dir, 'test.agdb'));
      col = new Collection('test', engine3);
      await col.load();
    });

    it('distinct returns unique values', () => {
      col.insert({ color: 'red' });
      col.insert({ color: 'blue' });
      col.insert({ color: 'red' });
      col.insert({ color: 'green' });
      const colors = col.distinct('color');
      expect(colors.sort()).toEqual(['blue', 'green', 'red']);
    });
  });

  // ── Query Builder ─────────────────────────────────────

  describe('Query', () => {
    beforeEach(() => {
      col.insert({ name: 'Alice', age: 30, role: 'admin' });
      col.insert({ name: 'Bob', age: 25, role: 'user' });
      col.insert({ name: 'Charlie', age: 35, role: 'user' });
      col.insert({ name: 'Diana', age: 28, role: 'admin' });
    });

    it('where == filters correctly', () => {
      const results = col.query().where('role', '==', 'admin').exec();
      expect(results.length).toBe(2);
    });

    it('where != filters correctly', () => {
      const results = col.query().where('role', '!=', 'admin').exec();
      expect(results.length).toBe(2);
    });

    it('where > filters correctly', () => {
      const results = col.query().where('age', '>', 28).exec();
      expect(results.length).toBe(2); // Alice 30, Charlie 35
    });

    it('where >= filters correctly', () => {
      const results = col.query().where('age', '>=', 30).exec();
      expect(results.length).toBe(2);
    });

    it('where in filters correctly', () => {
      const results = col.query().where('name', 'in', ['Alice', 'Bob']).exec();
      expect(results.length).toBe(2);
    });

    it('where contains filters correctly', () => {
      const results = col.query().where('name', 'contains', 'li').exec();
      expect(results.length).toBe(2); // Alice, Charlie
    });

    it('where startsWith filters correctly', () => {
      const results = col.query().where('name', 'startsWith', 'Ch').exec();
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Charlie');
    });

    it('where exists filters correctly', () => {
      col.insert({ name: 'Eve' }); // no age field
      const results = col.query().where('age', 'exists', true).exec();
      expect(results.length).toBe(4); // original 4 have age
    });

    it('sort ascending', () => {
      const results = col.query().sort('age', 'asc').exec();
      expect(results[0].name).toBe('Bob');     // 25
      expect(results[3].name).toBe('Charlie'); // 35
    });

    it('sort descending', () => {
      const results = col.query().sort('age', -1).exec();
      expect(results[0].name).toBe('Charlie');
      expect(results[3].name).toBe('Bob');
    });

    it('limit works', () => {
      const results = col.query().sort('age', 1).limit(2).exec();
      expect(results.length).toBe(2);
    });

    it('skip works', () => {
      const results = col.query().sort('age', 1).skip(2).exec();
      expect(results.length).toBe(2);
      expect(results[0].name).toBe('Alice'); // age 30
    });

    it('select projection', () => {
      const results = col.query().select('name').exec();
      expect(results[0].name).toBeDefined();
      expect(results[0].age).toBeUndefined();
      expect(results[0]._id).toBeDefined();
    });

    it('first returns single doc', () => {
      const doc = col.query().where('name', '==', 'Alice').first();
      expect(doc).not.toBeNull();
      expect(doc!.name).toBe('Alice');
    });

    it('count returns match count', () => {
      const count = col.query().where('role', '==', 'user').count();
      expect(count).toBe(2);
    });

    it('exists returns boolean', () => {
      expect(col.query().where('name', '==', 'Alice').exists()).toBe(true);
      expect(col.query().where('name', '==', 'Nobody').exists()).toBe(false);
    });

    it('multiple where clauses (AND)', () => {
      const results = col.query()
        .where('role', '==', 'admin')
        .where('age', '>', 29)
        .exec();
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Alice');
    });
  });

  // ── Indexes ───────────────────────────────────────────

  describe('Indexes', () => {
    it('createIndex speeds up equality lookups', () => {
      col.insertMany(Array.from({ length: 100 }, (_, i) => ({
        email: `user${i}@test.com`, i,
      })));
      col.createIndex('email');

      const result = col.query().where('email', '==', 'user50@test.com').exec();
      expect(result.length).toBe(1);
      expect(result[0].i).toBe(50);
    });

    it('unique index rejects duplicates', () => {
      col.createIndex('email', true);
      col.insert({ email: 'alice@test.com' });
      expect(() => col.insert({ email: 'alice@test.com' })).toThrow();
    });

    it('listIndexes returns indexed fields', () => {
      col.createIndex('name');
      col.createIndex('age');
      expect(col.listIndexes().sort()).toEqual(['age', 'name']);
    });

    it('dropIndex removes index', () => {
      col.createIndex('name');
      col.dropIndex('name');
      expect(col.listIndexes()).toEqual([]);
    });
  });

  // ── Schema ────────────────────────────────────────────

  describe('Schema', () => {
    it('validates on insert', () => {
      col.setSchema({
        fields: {
          name: { type: 'string', required: true },
          age: { type: 'number', min: 0 },
        },
      });

      // Valid insert
      const id = col.insert({ name: 'Alice', age: 30 });
      expect(col.findById(id)!.name).toBe('Alice');

      // Missing required field
      expect(() => col.insert({ age: 25 })).toThrow('required');

      // Wrong type
      expect(() => col.insert({ name: 123 })).toThrow('expected string');

      // Below min
      expect(() => col.insert({ name: 'Bob', age: -1 })).toThrow('below minimum');
    });

    it('applies defaults', () => {
      col.setSchema({
        fields: {
          name: { type: 'string', required: true },
          role: { type: 'string', default: 'user' },
        },
      });

      const id = col.insert({ name: 'Alice' });
      expect(col.findById(id)!.role).toBe('user');
    });

    it('strict mode rejects unknown fields', () => {
      col.setSchema({
        strict: true,
        fields: { name: { type: 'string' } },
      });

      expect(() => col.insert({ name: 'Alice', extra: true })).toThrow('unknown field');
    });
  });

  // ── Events ────────────────────────────────────────────

  describe('Events', () => {
    it('emits insert event', () => {
      let received: any = null;
      col.on('insert', (event) => { received = event; });

      const id = col.insert({ name: 'Alice' });
      expect(received).not.toBeNull();
      expect(received.type).toBe('insert');
      expect(received.docId).toBe(id);
      expect(received.doc.name).toBe('Alice');
    });

    it('emits update event with old and new doc', () => {
      let received: any = null;
      col.on('update', (event) => { received = event; });

      const id = col.insert({ name: 'Alice' });
      col.update(id, { name: 'Bob' });

      expect(received.type).toBe('update');
      expect(received.oldDoc.name).toBe('Alice');
      expect(received.doc.name).toBe('Bob');
    });

    it('emits delete event', () => {
      let received: any = null;
      col.on('delete', (event) => { received = event; });

      const id = col.insert({ name: 'Alice' });
      col.delete(id);

      expect(received.type).toBe('delete');
      expect(received.docId).toBe(id);
    });

    it('once fires only once', () => {
      let count = 0;
      col.once('insert', () => { count++; });

      col.insert({ a: 1 });
      col.insert({ b: 2 });
      expect(count).toBe(1);
    });
  });

  // ── TTL ───────────────────────────────────────────────

  describe('TTL', () => {
    it('findById returns null for expired docs', () => {
      const id = col.insert({ name: 'Expired', _ttl: Date.now() - 1000 });
      expect(col.findById(id)).toBeNull();
    });

    it('find excludes expired docs', () => {
      col.insert({ name: 'Valid', _ttl: Date.now() + 100000 });
      col.insert({ name: 'Expired', _ttl: Date.now() - 1000 });
      col.insert({ name: 'NoTTL' });
      const results = col.find();
      expect(results.length).toBe(2);
    });

    it('purgeExpired removes expired docs', () => {
      col.insert({ _ttl: Date.now() - 1000 });
      col.insert({ _ttl: Date.now() - 2000 });
      col.insert({ _ttl: Date.now() + 100000 });
      const purged = col.purgeExpired();
      expect(purged).toBe(2);
      expect(col.count()).toBe(1);
    });
  });

  // ── Persistence ───────────────────────────────────────

  describe('Persistence', () => {
    it('data survives close and reload', async () => {
      col.insert({ name: 'Persistent' });
      col.close();

      const engine2 = new StorageEngine(path.join(dir, 'test.agdb'));
      const col2 = new Collection('test', engine2);
      await col2.load();

      expect(col2.count()).toBe(1);
      expect(col2.find()[0].name).toBe('Persistent');

      col2.close();
      // Reassign so afterEach doesn't double-close
      const engine3 = new StorageEngine(path.join(dir, 'test.agdb'));
      col = new Collection('test', engine3);
      await col.load();
    });
  });

  describe('search', () => {
    it('full text search scores docs across the requested fields', () => {
      col.insert({ title: 'Ghost memory panel', body: 'black white drawer ui' });
      col.insert({ title: 'AgentDB rotation', body: 'rewrite encrypted collections safely' });
      col.insert({ title: 'Ghost drawer', body: 'memory export import panel' });

      const results = col.search('ghost panel memory', ['title', 'body']);
      expect(results.length).toBe(2);
      expect(results[0].title).toBe('Ghost memory panel');
    });
  });
});
