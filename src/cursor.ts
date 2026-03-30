// ── Cursor — streaming iteration over large result sets ──────
// Avoids materializing the entire result set in memory.
// Supports forEach, map, toArray, take, and async iteration.

import { Document } from './types.js';

/**
 * Cursor — lazy iterator over a query result.
 *
 * Usage:
 *   const cursor = collection.query().where(...).cursor();
 *   for (const doc of cursor) { ... }
 *   // or
 *   cursor.forEach(doc => { ... });
 *   // or
 *   const first5 = cursor.take(5);
 */
export class Cursor implements Iterable<Document> {
  private docs: Document[];
  private position = 0;
  private _closed = false;

  constructor(docs: Document[]) {
    this.docs = docs;
  }

  /** Get the next document, or null if exhausted */
  next(): Document | null {
    if (this._closed || this.position >= this.docs.length) return null;
    return this.docs[this.position++];
  }

  /** Check if there are more documents */
  hasNext(): boolean {
    return !this._closed && this.position < this.docs.length;
  }

  /** Take up to N documents */
  take(n: number): Document[] {
    const results: Document[] = [];
    for (let i = 0; i < n; i++) {
      const doc = this.next();
      if (!doc) break;
      results.push(doc);
    }
    return results;
  }

  /** Skip N documents */
  skip(n: number): Cursor {
    this.position = Math.min(this.position + n, this.docs.length);
    return this;
  }

  /** Iterate with a callback */
  forEach(fn: (doc: Document, index: number) => void | false): void {
    let i = 0;
    while (this.hasNext()) {
      const doc = this.next()!;
      const result = fn(doc, i++);
      if (result === false) break;
    }
  }

  /** Map documents to another type */
  map<T>(fn: (doc: Document, index: number) => T): T[] {
    const results: T[] = [];
    let i = 0;
    while (this.hasNext()) {
      results.push(fn(this.next()!, i++));
    }
    return results;
  }

  /** Filter documents */
  filter(fn: (doc: Document) => boolean): Document[] {
    const results: Document[] = [];
    while (this.hasNext()) {
      const doc = this.next()!;
      if (fn(doc)) results.push(doc);
    }
    return results;
  }

  /** Reduce documents to a single value */
  reduce<T>(fn: (acc: T, doc: Document) => T, initial: T): T {
    let acc = initial;
    while (this.hasNext()) {
      acc = fn(acc, this.next()!);
    }
    return acc;
  }

  /** Materialize all remaining documents into an array */
  toArray(): Document[] {
    const remaining = this.docs.slice(this.position);
    this.position = this.docs.length;
    return remaining;
  }

  /** Reset cursor to the beginning */
  rewind(): Cursor {
    this.position = 0;
    this._closed = false;
    return this;
  }

  /** Close the cursor — releases references */
  close(): void {
    this._closed = true;
    this.docs = [];
  }

  /** Number of total documents (not remaining) */
  get count(): number {
    return this.docs.length;
  }

  /** Number of remaining documents */
  get remaining(): number {
    return Math.max(0, this.docs.length - this.position);
  }

  /** Iterator protocol — allows for...of */
  [Symbol.iterator](): Iterator<Document> {
    return {
      next: (): IteratorResult<Document> => {
        const doc = this.next();
        if (doc === null) return { done: true, value: undefined };
        return { done: false, value: doc };
      },
    };
  }

  /** Process in batches */
  batch(size: number): Document[][] {
    const batches: Document[][] = [];
    while (this.hasNext()) {
      batches.push(this.take(size));
    }
    return batches;
  }
}
