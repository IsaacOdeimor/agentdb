import { EventEmitter } from 'events';
import { StorageEngine } from './engine.js';
import { Document, WhereClause, Operator, SortDir, CollectionOptions, CollectionEvent, EventListener, generateId } from './types.js';
import { IndexManager, FieldIndex } from './indexer.js';
import { CollectionSchema, validateDocument } from './schema.js';
import { Cursor } from './cursor.js';
import { Aggregation } from './aggregation.js';
import { SchemaError, DocumentNotFoundError } from './errors.js';

// ── Query Builder ────────────────────────────────────────────

export class Query {
  private collection: Collection;
  private filters: WhereClause[] = [];
  private sortField?: string;
  private sortDir: SortDir = 1;
  private limitN?: number;
  private skipN = 0;
  private _projection?: string[];

  constructor(collection: Collection) {
    this.collection = collection;
  }

  where(field: string, op: Operator, value: any): Query {
    this.filters.push({ field, op, value });
    return this;
  }

  sort(field: string, dir: SortDir = 1): Query {
    this.sortField = field;
    this.sortDir = dir;
    return this;
  }

  limit(n: number): Query {
    this.limitN = n;
    return this;
  }

  skip(n: number): Query {
    this.skipN = n;
    return this;
  }

  /** Select only specific fields */
  select(...fields: string[]): Query {
    this._projection = ['_id', '_ts', ...fields];
    return this;
  }

  /** Execute and return documents */
  exec(): Document[] {
    let docs = this.resolveWithIndexes();

    // Sort
    if (this.sortField) {
      const field = this.sortField;
      const dir = (this.sortDir === 'desc' || this.sortDir === -1) ? -1 : 1;
      docs.sort((a, b) => {
        const va = a[field], vb = b[field];
        if (va === vb) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va < vb ? -1 : 1) * dir;
      });
    }

    if (this.skipN > 0) docs = docs.slice(this.skipN);
    if (this.limitN !== undefined) docs = docs.slice(0, this.limitN);

    // Projection
    if (this._projection) {
      const fields = this._projection;
      docs = docs.map(doc => {
        const projected: any = {};
        for (const f of fields) {
          if (f in doc) projected[f] = doc[f];
        }
        return projected as Document;
      });
    }

    return docs;
  }

  /** Return a cursor for lazy iteration */
  cursor(): Cursor {
    return new Cursor(this.exec());
  }

  /** Return an aggregation pipeline over matching docs */
  aggregate(): Aggregation {
    return new Aggregation(this.exec());
  }

  count(): number {
    return this.resolveWithIndexes().length;
  }

  first(): Document | null {
    this.limitN = 1;
    const results = this.exec();
    return results[0] || null;
  }

  /** Check if any documents match */
  exists(): boolean {
    return this.first() !== null;
  }

  /** Try to use indexes for the first equality filter */
  private resolveWithIndexes(): Document[] {
    let docs: Document[] | null = null;

    // Check if any filter can use an index
    for (let i = 0; i < this.filters.length; i++) {
      const f = this.filters[i];
      const index = this.collection.getFieldIndex(f.field);
      if (!index) continue;

      let docIds: string[] | null = null;
      switch (f.op) {
        case '==':  docIds = index.findEqual(f.value); break;
        case '>':   docIds = index.findGreater(f.value); break;
        case '>=':  docIds = index.findGreaterEqual(f.value); break;
        case '<':   docIds = index.findLess(f.value); break;
        case '<=':  docIds = index.findLessEqual(f.value); break;
      }

      if (docIds !== null) {
        docs = docIds.map(id => this.collection.findById(id)).filter(Boolean) as Document[];
        // Remove this filter since it's already applied
        this.filters = [...this.filters.slice(0, i), ...this.filters.slice(i + 1)];
        break;
      }
    }

    if (docs === null) docs = this.collection.allDocs();

    // Apply remaining filters
    for (const f of this.filters) {
      docs = docs.filter(doc => matchFilter(doc, f));
    }

    return docs;
  }
}

/** Match a document against a filter condition */
function matchFilter(doc: Document, f: WhereClause): boolean {
  const val = doc[f.field];
  switch (f.op) {
    case '==':         return val === f.value;
    case '!=':         return val !== f.value;
    case '>':          return val > f.value;
    case '>=':         return val >= f.value;
    case '<':          return val < f.value;
    case '<=':         return val <= f.value;
    case 'in':         return Array.isArray(f.value) && f.value.includes(val);
    case 'nin':        return Array.isArray(f.value) && !f.value.includes(val);
    case 'contains':   return typeof val === 'string' && val.includes(f.value);
    case 'startsWith': return typeof val === 'string' && val.startsWith(f.value);
    case 'endsWith':   return typeof val === 'string' && val.endsWith(f.value);
    case 'exists':     return f.value ? val !== undefined && val !== null : val === undefined || val === null;
    case 'regex':      return typeof val === 'string' && new RegExp(f.value).test(val);
    default:           return false;
  }
}

function getFieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  const segments = field.split('.');
  let current: unknown = doc;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── Collection ───────────────────────────────────────────────

export class Collection {
  readonly name: string;
  private engine: StorageEngine;
  private docs: Map<string, Document> = new Map();
  private offsets: Map<string, number> = new Map();
  private emitter: EventEmitter = new EventEmitter();
  private indexes: IndexManager = new IndexManager();
  private schema: CollectionSchema | null = null;
  private options: CollectionOptions;

  constructor(name: string, engine: StorageEngine, options: CollectionOptions = {}) {
    this.name = name;
    this.engine = engine;
    this.options = options;
    if (options.compression) engine.setCompression(true);
  }

  async load(): Promise<void> {
    await this.engine.open();
    const records = this.engine.scanAll();
    this.docs.clear();
    this.offsets.clear();
    const now = Date.now();
    for (const { offset, doc } of records) {
      // Skip expired TTL documents
      if (doc._ttl && doc._ttl > 0 && doc._ttl < now) continue;
      this.docs.set(doc._id, doc);
      this.offsets.set(doc._id, offset);
    }
    this.indexes.rebuildAll(Array.from(this.docs.values()));
  }

  close(): void {
    this.engine.close();
    this.emitter.removeAllListeners();
  }

  setEncryptionKey(key: Buffer | null): void {
    this.engine.setEncryptionKey(key);
  }

  async rewriteStorage(): Promise<void> {
    this.engine.compact(this.allDocs());
    await this.load();
  }

  // ── Schema ─────────────────────────────────────────────

  /** Set a schema for this collection */
  setSchema(schema: CollectionSchema): void {
    this.schema = schema;
  }

  getSchema(): CollectionSchema | null {
    return this.schema;
  }

  // ── Indexes ────────────────────────────────────────────

  /** Create an index on a field */
  createIndex(field: string, unique = false): FieldIndex {
    const idx = this.indexes.createIndex(field, unique);
    idx.build(Array.from(this.docs.values()));
    return idx;
  }

  /** Drop an index */
  dropIndex(field: string): boolean {
    return this.indexes.dropIndex(field);
  }

  /** Get a field index (used by Query) */
  getFieldIndex(field: string): FieldIndex | undefined {
    return this.indexes.getIndex(field);
  }

  /** List indexed fields */
  listIndexes(): string[] {
    return this.indexes.listIndexes();
  }

  // ── Events ─────────────────────────────────────────────

  /** Subscribe to collection events */
  on(event: CollectionEvent, listener: EventListener): void {
    this.emitter.on(event, listener);
  }

  /** Subscribe once */
  once(event: CollectionEvent, listener: EventListener): void {
    this.emitter.once(event, listener);
  }

  /** Unsubscribe */
  off(event: CollectionEvent, listener: EventListener): void {
    this.emitter.removeListener(event, listener);
  }

  private emit(type: CollectionEvent, docId?: string, doc?: Document, oldDoc?: Document): void {
    this.emitter.emit(type, { type, docId, doc, oldDoc, timestamp: Date.now() });
  }

  // ── CRUD ───────────────────────────────────────────────

  /** Insert a document */
  insert(data: Record<string, any>): string {
    // Size limit check
    if (this.options.maxDocs && this.docs.size >= this.options.maxDocs) {
      throw new Error(`Collection "${this.name}" has reached max docs (${this.options.maxDocs})`);
    }

    const id = data._id || generateId();
    const ts = Date.now();
    const { _id: _, _ts: __, ...rest } = data;

    // Apply TTL
    if (this.options.ttl && !rest._ttl) {
      rest._ttl = ts + this.options.ttl;
    }

    // Schema validation
    let validated = rest;
    if (this.schema) {
      validated = validateDocument(rest, this.schema);
    }

    const doc: Document = { ...validated, _id: id, _ts: ts };

    // Index check (unique constraints)
    if (!this.indexes.onInsert(doc)) {
      throw new Error(`Unique constraint violation in collection "${this.name}"`);
    }

    const offset = this.engine.append(id, ts, validated);
    this.docs.set(id, doc);
    this.offsets.set(id, offset);
    this.emit('insert', id, doc);
    this.maybeCompact();
    return id;
  }

  insertMany(items: Record<string, any>[]): string[] {
    return items.map(item => this.insert(item));
  }

  findById(id: string): Document | null {
    const doc = this.docs.get(id);
    if (!doc) return null;
    // Check TTL
    if (doc._ttl && doc._ttl > 0 && doc._ttl < Date.now()) {
      this.delete(id); // lazy expiry
      return null;
    }
    return doc;
  }

  find(filter?: Record<string, any>): Document[] {
    const now = Date.now();
    let docs: Document[];
    if (!filter || Object.keys(filter).length === 0) {
      docs = Array.from(this.docs.values());
    } else {
      docs = Array.from(this.docs.values()).filter(doc => {
        for (const [key, val] of Object.entries(filter)) {
          if (doc[key] !== val) return false;
        }
        return true;
      });
    }
    // Filter expired docs
    return docs.filter(d => !d._ttl || d._ttl <= 0 || d._ttl >= now);
  }

  query(): Query {
    return new Query(this);
  }

  /** Get an aggregation pipeline over all (or filtered) documents */
  aggregate(filter?: Record<string, any>): Aggregation {
    return new Aggregation(this.find(filter));
  }

  update(id: string, updates: Record<string, any>): Document | null {
    const existing = this.docs.get(id);
    if (!existing) return null;

    const oldOffset = this.offsets.get(id);

    const { _id, _ts, ...oldData } = existing;
    const { _id: _i, _ts: _t, ...newData } = updates;
    const merged = { ...oldData, ...newData };

    // Schema validation on update
    let validated = merged;
    if (this.schema) {
      validated = validateDocument(merged, this.schema);
    }

    const ts = Date.now();
    const doc: Document = { ...validated, _id: id, _ts: ts };

    const newOffset = oldOffset !== undefined
      ? this.engine.update(oldOffset, id, ts, validated)
      : this.engine.append(id, ts, validated);

    this.indexes.onUpdate(existing, doc);
    this.docs.set(id, doc);
    this.offsets.set(id, newOffset);
    this.emit('update', id, doc, existing);
    this.maybeCompact();
    return doc;
  }

  /** Upsert — insert if not exists, update if exists */
  upsert(id: string, data: Record<string, any>): { doc: Document; created: boolean } {
    const existing = this.findById(id);
    if (existing) {
      return { doc: this.update(id, data)!, created: false };
    }
    const newId = this.insert({ ...data, _id: id });
    return { doc: this.findById(newId)!, created: true };
  }

  delete(id: string): boolean {
    const offset = this.offsets.get(id);
    if (offset === undefined) return false;
    const doc = this.docs.get(id);
    this.engine.markDeleted(offset, id);
    this.indexes.onDelete(id);
    this.docs.delete(id);
    this.offsets.delete(id);
    this.emit('delete', id, undefined, doc);
    this.maybeCompact();
    return true;
  }

  deleteMany(filter: Record<string, any>): number {
    const matches = this.find(filter);
    for (const doc of matches) this.delete(doc._id);
    return matches.length;
  }

  clear(): number {
    const count = this.docs.size;
    for (const id of Array.from(this.docs.keys())) this.delete(id);
    return count;
  }

  /** Purge expired TTL documents */
  purgeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, doc] of this.docs) {
      if (doc._ttl && doc._ttl > 0 && doc._ttl < now) {
        this.delete(id);
        count++;
      }
    }
    return count;
  }

  // ── Helpers ────────────────────────────────────────────

  count(filter?: Record<string, any>): number {
    if (!filter) return this.docs.size;
    return this.find(filter).length;
  }

  allDocs(): Document[] {
    const now = Date.now();
    return Array.from(this.docs.values()).filter(d => !d._ttl || d._ttl <= 0 || d._ttl >= now);
  }

  search(query: string, fields: string[]): Document[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    if (tokens.length === 0 || fields.length === 0) {
      return [];
    }

    const scored = this.allDocs()
      .map((doc) => {
        let score = 0;
        for (const token of tokens) {
          const matched = fields.some((field) => {
            const value = getFieldValue(doc, field);
            return typeof value === 'string' && value.toLowerCase().includes(token);
          });
          if (matched) score += 1;
        }
        return { doc, score };
      })
      .filter((item) => item.score > 0);

    scored.sort((left, right) => right.score - left.score);

    return scored.map((item) => item.doc);
  }

  /** Get distinct values of a field */
  distinct(field: string): any[] {
    const idx = this.indexes.getIndex(field);
    if (idx) return idx.distinctValues();
    const seen = new Set<any>();
    for (const doc of this.docs.values()) {
      const v = doc[field];
      if (v != null) seen.add(v);
    }
    return Array.from(seen);
  }

  /** Replace a document entirely (not merge) */
  replace(id: string, data: Record<string, any>): Document | null {
    const existing = this.docs.get(id);
    if (!existing) return null;
    const oldOffset = this.offsets.get(id);

    const { _id: _, _ts: __, ...rest } = data;
    let validated = rest;
    if (this.schema) validated = validateDocument(rest, this.schema);

    const ts = Date.now();
    const doc: Document = { ...validated, _id: id, _ts: ts };
    const newOffset = oldOffset !== undefined
      ? this.engine.update(oldOffset, id, ts, validated)
      : this.engine.append(id, ts, validated);
    this.indexes.onUpdate(existing, doc);
    this.docs.set(id, doc);
    this.offsets.set(id, newOffset);
    this.emit('update', id, doc, existing);
    return doc;
  }

  stats() {
    return {
      ...this.engine.getStats(),
      docs: this.docs.size,
      indexes: this.indexes.listIndexes(),
      hasSchema: !!this.schema,
      options: this.options,
    };
  }

  private maybeCompact(): void {
    if (this.engine.shouldCompact()) {
      this.engine.compact(Array.from(this.docs.values()));
      const records = this.engine.scanAll();
      this.offsets.clear();
      for (const { offset, doc } of records) {
        this.offsets.set(doc._id, offset);
      }
      this.emit('compact');
    }
  }
}
