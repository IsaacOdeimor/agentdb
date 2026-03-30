// ── AgentDB — Public API ─────────────────────────────────────

// Core
export { AgentDB } from './database.js';
export { Collection, Query } from './collection.js';
export { StorageEngine } from './engine.js';

// Types
export { Document, generateId } from './types.js';
export type {
  Operator, SortDir, WhereClause, QueryOptions,
  CollectionOptions, DatabaseOptions,
  CollectionEvent, EventListener,
} from './types.js';

// Features
export { FieldIndex, IndexManager } from './indexer.js';
export { Cursor } from './cursor.js';
export { Aggregation } from './aggregation.js';
export type { GroupResult } from './aggregation.js';
export { WriteAheadLog } from './wal.js';
export { BackupManager } from './backup.js';
export type { BackupMeta } from './backup.js';
export { MigrationRunner } from './migration.js';
export type { Migration } from './migration.js';

// Schema
export { validateDocument, isValid } from './schema.js';
export type { CollectionSchema, FieldDef, FieldType } from './schema.js';

// Encryption
export { deriveKey, encrypt, decrypt } from './encryption.js';
export type { EncryptionKey } from './encryption.js';

// Compression
export { compress, decompress, smartCompress } from './compression.js';

// Checksums
export { crc32, verifyCRC32 } from './crc32.js';

// Errors
export {
  AgentDBError,
  CorruptionError,
  ChecksumError,
  WALError,
  EncryptionError,
  SchemaError,
  MigrationError,
  CollectionNotFoundError,
  DocumentNotFoundError,
} from './errors.js';
