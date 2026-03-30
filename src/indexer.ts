// ── Field Indexes ────────────────────────────────────────────
// Sorted array indexes with binary search for O(log n) lookups.
// Each index maintains a sorted list of { value, docId } pairs.

import { Document } from './types.js';

interface IndexEntry {
  value: any;
  docId: string;
}

/**
 * FieldIndex — a sorted array index on a single field.
 *
 * Supports:
 *   - O(log n) equality lookups
 *   - O(log n + k) range queries
 *   - O(1) unique constraint checks
 *   - Auto-maintenance on insert/update/delete
 */
export class FieldIndex {
  readonly field: string;
  readonly unique: boolean;
  private entries: IndexEntry[] = [];
  private _dirty = false;

  constructor(field: string, unique = false) {
    this.field = field;
    this.unique = unique;
  }

  /** Build the index from a set of documents */
  build(docs: Document[]): void {
    this.entries = [];
    for (const doc of docs) {
      const val = doc[this.field];
      if (val !== undefined && val !== null) {
        this.entries.push({ value: val, docId: doc._id });
      }
    }
    this.entries.sort((a, b) => this.compare(a.value, b.value));
    this._dirty = false;
  }

  /** Add a document to the index */
  add(doc: Document): boolean {
    const val = doc[this.field];
    if (val === undefined || val === null) return true;

    if (this.unique) {
      const existing = this.findEqual(val);
      if (existing.length > 0) return false; // unique constraint violation
    }

    const pos = this.bisectRight(val);
    this.entries.splice(pos, 0, { value: val, docId: doc._id });
    return true;
  }

  /** Remove a document from the index */
  remove(docId: string): void {
    const idx = this.entries.findIndex(e => e.docId === docId);
    if (idx !== -1) this.entries.splice(idx, 1);
  }

  /** Update: remove old, add new */
  update(oldDoc: Document, newDoc: Document): boolean {
    this.remove(oldDoc._id);
    return this.add(newDoc);
  }

  // ── Lookups ────────────────────────────────────────────

  /** Find all doc IDs where field == value */
  findEqual(value: any): string[] {
    const start = this.bisectLeft(value);
    const results: string[] = [];
    for (let i = start; i < this.entries.length; i++) {
      if (this.compare(this.entries[i].value, value) !== 0) break;
      results.push(this.entries[i].docId);
    }
    return results;
  }

  /** Find all doc IDs where field > value */
  findGreater(value: any): string[] {
    const start = this.bisectRight(value);
    return this.entries.slice(start).map(e => e.docId);
  }

  /** Find all doc IDs where field >= value */
  findGreaterEqual(value: any): string[] {
    const start = this.bisectLeft(value);
    return this.entries.slice(start).map(e => e.docId);
  }

  /** Find all doc IDs where field < value */
  findLess(value: any): string[] {
    const end = this.bisectLeft(value);
    return this.entries.slice(0, end).map(e => e.docId);
  }

  /** Find all doc IDs where field <= value */
  findLessEqual(value: any): string[] {
    const end = this.bisectRight(value);
    return this.entries.slice(0, end).map(e => e.docId);
  }

  /** Find all doc IDs where field is between min and max (inclusive) */
  findRange(min: any, max: any): string[] {
    const start = this.bisectLeft(min);
    const end = this.bisectRight(max);
    return this.entries.slice(start, end).map(e => e.docId);
  }

  /** Number of entries in the index */
  get size(): number {
    return this.entries.length;
  }

  /** Get all unique values in the index */
  distinctValues(): any[] {
    const seen = new Set<any>();
    return this.entries.filter(e => {
      if (seen.has(e.value)) return false;
      seen.add(e.value);
      return true;
    }).map(e => e.value);
  }

  // ── Binary search helpers ──────────────────────────────

  /** Find insertion point for value (leftmost position) */
  private bisectLeft(value: any): number {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.entries[mid].value, value) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Find insertion point for value (rightmost position) */
  private bisectRight(value: any): number {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.entries[mid].value, value) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Compare two values — handles numbers, strings, dates */
  private compare(a: any, b: any): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
    // Fallback: convert to string
    return String(a) < String(b) ? -1 : 1;
  }
}

/**
 * IndexManager — manages multiple field indexes for a collection.
 */
export class IndexManager {
  private indexes: Map<string, FieldIndex> = new Map();

  /** Create a new index on a field */
  createIndex(field: string, unique = false): FieldIndex {
    const idx = new FieldIndex(field, unique);
    this.indexes.set(field, idx);
    return idx;
  }

  /** Drop an index */
  dropIndex(field: string): boolean {
    return this.indexes.delete(field);
  }

  /** Get an index by field name */
  getIndex(field: string): FieldIndex | undefined {
    return this.indexes.get(field);
  }

  /** Check if a field is indexed */
  hasIndex(field: string): boolean {
    return this.indexes.has(field);
  }

  /** Rebuild all indexes from documents */
  rebuildAll(docs: Document[]): void {
    for (const idx of this.indexes.values()) {
      idx.build(docs);
    }
  }

  /** Notify all indexes of an insert */
  onInsert(doc: Document): boolean {
    for (const idx of this.indexes.values()) {
      if (!idx.add(doc)) return false; // unique constraint violated
    }
    return true;
  }

  /** Notify all indexes of a delete */
  onDelete(docId: string): void {
    for (const idx of this.indexes.values()) {
      idx.remove(docId);
    }
  }

  /** Notify all indexes of an update */
  onUpdate(oldDoc: Document, newDoc: Document): boolean {
    for (const idx of this.indexes.values()) {
      if (!idx.update(oldDoc, newDoc)) return false;
    }
    return true;
  }

  /** List all indexed fields */
  listIndexes(): string[] {
    return Array.from(this.indexes.keys());
  }

  /** Number of indexes */
  get count(): number {
    return this.indexes.size;
  }
}
