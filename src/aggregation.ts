// ── Aggregation Pipeline ─────────────────────────────────────
// MongoDB-inspired aggregation operations on document collections.
// Supports: count, sum, avg, min, max, group, distinct, percentile.

import { Document } from './types.js';

/** Result of a group-by aggregation */
export interface GroupResult {
  key: any;
  count: number;
  docs: Document[];
  [metric: string]: any;
}

/**
 * Aggregation — chainable pipeline for document aggregation.
 *
 * Usage:
 *   new Aggregation(docs)
 *     .match({ role: 'user' })
 *     .group('conversationId')
 *     .compute('msgCount', 'count')
 *     .compute('avgLength', 'avg', 'content.length')
 *     .sort('msgCount', -1)
 *     .limit(10)
 *     .exec();
 */
export class Aggregation {
  private docs: Document[];

  constructor(docs: Document[]) {
    this.docs = [...docs];
  }

  /** Filter documents (like query's where) */
  match(filter: Record<string, any>): Aggregation {
    this.docs = this.docs.filter(doc => {
      for (const [key, val] of Object.entries(filter)) {
        if (doc[key] !== val) return false;
      }
      return true;
    });
    return this;
  }

  /** Sort documents */
  sort(field: string, dir: 1 | -1 = 1): Aggregation {
    this.docs.sort((a, b) => {
      const va = resolveField(a, field);
      const vb = resolveField(b, field);
      if (va === vb) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : 1) * dir;
    });
    return this;
  }

  /** Limit result count */
  limit(n: number): Aggregation {
    this.docs = this.docs.slice(0, n);
    return this;
  }

  /** Skip first N documents */
  skip(n: number): Aggregation {
    this.docs = this.docs.slice(n);
    return this;
  }

  // ── Scalar aggregations ────────────────────────────────

  /** Count documents */
  count(): number {
    return this.docs.length;
  }

  /** Sum a numeric field */
  sum(field: string): number {
    return this.docs.reduce((acc, doc) => {
      const v = resolveField(doc, field);
      return acc + (typeof v === 'number' ? v : 0);
    }, 0);
  }

  /** Average of a numeric field */
  avg(field: string): number {
    if (this.docs.length === 0) return 0;
    return this.sum(field) / this.docs.length;
  }

  /** Minimum value of a field */
  min(field: string): any {
    let result: any = undefined;
    for (const doc of this.docs) {
      const v = resolveField(doc, field);
      if (v == null) continue;
      if (result === undefined || v < result) result = v;
    }
    return result;
  }

  /** Maximum value of a field */
  max(field: string): any {
    let result: any = undefined;
    for (const doc of this.docs) {
      const v = resolveField(doc, field);
      if (v == null) continue;
      if (result === undefined || v > result) result = v;
    }
    return result;
  }

  /** Distinct values of a field */
  distinct(field: string): any[] {
    const seen = new Set<any>();
    for (const doc of this.docs) {
      const v = resolveField(doc, field);
      if (v != null) seen.add(v);
    }
    return Array.from(seen);
  }

  /** Percentile of a numeric field (0-100) */
  percentile(field: string, p: number): number {
    const values = this.docs
      .map(doc => resolveField(doc, field))
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const idx = Math.ceil((p / 100) * values.length) - 1;
    return values[Math.max(0, idx)];
  }

  /** Standard deviation of a numeric field */
  stddev(field: string): number {
    const mean = this.avg(field);
    const squaredDiffs = this.docs.reduce((acc, doc) => {
      const v = resolveField(doc, field);
      if (typeof v !== 'number') return acc;
      return acc + (v - mean) ** 2;
    }, 0);
    return Math.sqrt(squaredDiffs / Math.max(1, this.docs.length));
  }

  // ── Group-by aggregation ───────────────────────────────

  /** Group documents by a field value */
  group(field: string): GroupResult[] {
    const groups = new Map<any, Document[]>();
    for (const doc of this.docs) {
      const key = resolveField(doc, field) ?? '__null__';
      const list = groups.get(key) || [];
      list.push(doc);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([key, docs]) => ({
      key: key === '__null__' ? null : key,
      count: docs.length,
      docs,
    }));
  }

  /** Group and compute metrics */
  groupWith(
    field: string,
    metrics: Record<string, { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }>,
  ): Array<Record<string, any>> {
    const groups = this.group(field);
    return groups.map(g => {
      const row: Record<string, any> = { key: g.key, count: g.count };
      for (const [name, m] of Object.entries(metrics)) {
        const agg = new Aggregation(g.docs);
        switch (m.op) {
          case 'count': row[name] = agg.count(); break;
          case 'sum':   row[name] = agg.sum(m.field || field); break;
          case 'avg':   row[name] = agg.avg(m.field || field); break;
          case 'min':   row[name] = agg.min(m.field || field); break;
          case 'max':   row[name] = agg.max(m.field || field); break;
        }
      }
      return row;
    });
  }

  /** Histogram — bucket numeric values */
  histogram(field: string, bucketSize: number): Array<{ bucket: number; count: number }> {
    const buckets = new Map<number, number>();
    for (const doc of this.docs) {
      const v = resolveField(doc, field);
      if (typeof v !== 'number') continue;
      const bucket = Math.floor(v / bucketSize) * bucketSize;
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    return Array.from(buckets.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => a.bucket - b.bucket);
  }

  /** Get the current document set (for chaining) */
  exec(): Document[] {
    return this.docs;
  }
}

/** Resolve a dot-notation field path (e.g. "address.city") */
function resolveField(doc: any, field: string): any {
  if (!field.includes('.')) return doc[field];
  const parts = field.split('.');
  let current = doc;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}
