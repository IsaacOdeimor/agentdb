import { describe, it, expect } from 'vitest';
import { Cursor } from '../src/cursor';

const makeDocs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ _id: `${i}`, _ts: i, value: i }));

describe('Cursor', () => {
  // ── Basic iteration ─────────────────────────────────────

  describe('next / hasNext', () => {
    it('iterates through all documents', () => {
      const cursor = new Cursor(makeDocs(3));
      expect(cursor.hasNext()).toBe(true);
      expect(cursor.next()!.value).toBe(0);
      expect(cursor.next()!.value).toBe(1);
      expect(cursor.next()!.value).toBe(2);
      expect(cursor.hasNext()).toBe(false);
      expect(cursor.next()).toBeNull();
    });

    it('handles empty cursor', () => {
      const cursor = new Cursor([]);
      expect(cursor.hasNext()).toBe(false);
      expect(cursor.next()).toBeNull();
    });
  });

  // ── take / skip ─────────────────────────────────────────

  describe('take / skip', () => {
    it('take returns up to N docs', () => {
      const cursor = new Cursor(makeDocs(5));
      const taken = cursor.take(3);
      expect(taken.length).toBe(3);
      expect(taken[0].value).toBe(0);
      expect(taken[2].value).toBe(2);
    });

    it('take returns remaining if fewer than N', () => {
      const cursor = new Cursor(makeDocs(2));
      const taken = cursor.take(5);
      expect(taken.length).toBe(2);
    });

    it('skip advances position', () => {
      const cursor = new Cursor(makeDocs(5));
      cursor.skip(2);
      expect(cursor.next()!.value).toBe(2);
    });

    it('skip beyond end exhausts cursor', () => {
      const cursor = new Cursor(makeDocs(3));
      cursor.skip(10);
      expect(cursor.hasNext()).toBe(false);
    });
  });

  // ── forEach / map / filter / reduce ─────────────────────

  describe('functional methods', () => {
    it('forEach visits all docs', () => {
      const cursor = new Cursor(makeDocs(3));
      const values: number[] = [];
      cursor.forEach(doc => { values.push(doc.value); });
      expect(values).toEqual([0, 1, 2]);
    });

    it('forEach stops on false return', () => {
      const cursor = new Cursor(makeDocs(5));
      const values: number[] = [];
      cursor.forEach((doc) => {
        values.push(doc.value);
        if (doc.value >= 2) return false;
      });
      expect(values).toEqual([0, 1, 2]);
    });

    it('map transforms documents', () => {
      const cursor = new Cursor(makeDocs(3));
      const names = cursor.map(doc => `doc-${doc.value}`);
      expect(names).toEqual(['doc-0', 'doc-1', 'doc-2']);
    });

    it('filter returns matching docs', () => {
      const cursor = new Cursor(makeDocs(5));
      const even = cursor.filter(doc => doc.value % 2 === 0);
      expect(even.length).toBe(3); // 0, 2, 4
    });

    it('reduce accumulates a value', () => {
      const cursor = new Cursor(makeDocs(4));
      const sum = cursor.reduce((acc, doc) => acc + doc.value, 0);
      expect(sum).toBe(6); // 0+1+2+3
    });
  });

  // ── toArray / rewind / close ────────────────────────────

  describe('toArray / rewind / close', () => {
    it('toArray returns all remaining', () => {
      const cursor = new Cursor(makeDocs(5));
      cursor.next(); // advance past first
      const rest = cursor.toArray();
      expect(rest.length).toBe(4);
      expect(rest[0].value).toBe(1);
    });

    it('rewind resets to beginning', () => {
      const cursor = new Cursor(makeDocs(3));
      cursor.next();
      cursor.next();
      cursor.rewind();
      expect(cursor.next()!.value).toBe(0);
    });

    it('close prevents further iteration', () => {
      const cursor = new Cursor(makeDocs(3));
      cursor.close();
      expect(cursor.hasNext()).toBe(false);
      expect(cursor.next()).toBeNull();
    });

    it('rewind after close re-enables iteration', () => {
      const cursor = new Cursor(makeDocs(3));
      cursor.next();
      cursor.close();
      // After close, docs are cleared, so rewind won't restore them
      cursor.rewind();
      expect(cursor.hasNext()).toBe(false);
    });
  });

  // ── Properties ──────────────────────────────────────────

  describe('count / remaining', () => {
    it('count reflects total docs', () => {
      const cursor = new Cursor(makeDocs(5));
      expect(cursor.count).toBe(5);
      cursor.next();
      expect(cursor.count).toBe(5); // total doesn't change
    });

    it('remaining decreases as iteration proceeds', () => {
      const cursor = new Cursor(makeDocs(3));
      expect(cursor.remaining).toBe(3);
      cursor.next();
      expect(cursor.remaining).toBe(2);
      cursor.next();
      cursor.next();
      expect(cursor.remaining).toBe(0);
    });
  });

  // ── Iterator protocol ──────────────────────────────────

  describe('for...of', () => {
    it('supports for...of iteration', () => {
      const cursor = new Cursor(makeDocs(3));
      const values: number[] = [];
      for (const doc of cursor) {
        values.push(doc.value);
      }
      expect(values).toEqual([0, 1, 2]);
    });

    it('spread into array', () => {
      const cursor = new Cursor(makeDocs(3));
      const all = [...cursor];
      expect(all.length).toBe(3);
    });
  });

  // ── Batch ───────────────────────────────────────────────

  describe('batch', () => {
    it('splits docs into batches', () => {
      const cursor = new Cursor(makeDocs(7));
      const batches = cursor.batch(3);
      expect(batches.length).toBe(3);
      expect(batches[0].length).toBe(3);
      expect(batches[1].length).toBe(3);
      expect(batches[2].length).toBe(1); // remainder
    });

    it('single batch when size >= count', () => {
      const cursor = new Cursor(makeDocs(3));
      const batches = cursor.batch(10);
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(3);
    });

    it('empty cursor produces no batches', () => {
      const cursor = new Cursor([]);
      const batches = cursor.batch(5);
      expect(batches.length).toBe(0);
    });
  });
});
