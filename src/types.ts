// ── AgentDB Types ────────────────────────────────────────────

/** A stored document — always has _id and _ts */
export interface Document {
  _id: string;
  _ts: number;
  _ttl?: number; // optional: expiry timestamp (ms since epoch)
  [key: string]: any;
}

/** Operators for query filters */
export type Operator = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'nin' | 'contains' | 'startsWith' | 'endsWith' | 'exists' | 'regex';

/** A single filter condition */
export interface WhereClause {
  field: string;
  op: Operator;
  value: any;
}

/** Sort direction */
export type SortDir = 1 | -1 | 'asc' | 'desc';

/** Options for a query */
export interface QueryOptions {
  filters: WhereClause[];
  sortField?: string;
  sortDir: SortDir;
  limitN?: number;
  skipN: number;
}

/** Record status in the binary file */
export const enum RecordStatus {
  Deleted = 0x00,
  Active = 0x01,
}

/** Record flags byte — per-record features */
export const enum RecordFlags {
  None       = 0x00,
  Compressed = 0x01, // bit 0: data is zlib compressed
  Encrypted  = 0x02, // bit 1: data is AES-256-GCM encrypted
}

/** File header constants */
export const MAGIC = Buffer.from('AGDB');
export const HEADER_SIZE = 32;
export const VERSION = 2; // v2: CRC32, compression, encryption, WAL

/**
 * File layout (32-byte header):
 *
 *   [0-3]   Magic "AGDB"
 *   [4]     Version (2)
 *   [5]     Collection flags (bit 0: compression, bit 1: encryption)
 *   [6-7]   Reserved
 *   [8-15]  Created timestamp  (float64 LE)
 *   [16-23] Modified timestamp (float64 LE)
 *   [24-27] Total record count (uint32 LE)
 *   [28-31] Active record count (uint32 LE)
 *
 * Record format v2 (sequential after header):
 *
 *   [0]           Status byte (0x01 active, 0x00 deleted)
 *   [1-4]         CRC32 of payload (everything after CRC: key_len..data)
 *   [5-6]         Key length (uint16 LE)
 *   [7..K+6]      Key (UTF-8 string)
 *   [K+7..K+14]   Timestamp (float64 LE)
 *   [K+15]        Flags byte (compression, encryption)
 *   [K+16..K+19]  Data length (uint32 LE)
 *   [K+20..M]     Data (possibly compressed/encrypted UTF-8 JSON)
 */

/** Collection-level options */
export interface CollectionOptions {
  compression?: boolean;  // enable compression for new records
  encryption?: boolean;   // enable encryption for new records
  ttl?: number;           // default TTL in ms (0 = no expiry)
  maxDocs?: number;       // max documents (0 = unlimited)
  maxSizeBytes?: number;  // max file size (0 = unlimited)
}

/** Database-level options */
export interface DatabaseOptions {
  encryptionKey?: string;        // password for encryption
  compressionEnabled?: boolean;  // global compression default
  autoCompact?: boolean;         // auto-compact on tombstone threshold
  compactThreshold?: number;     // tombstone ratio to trigger (0-1, default 0.3)
  backupOnOpen?: boolean;        // create backup on database open
  maxBackups?: number;           // max backup snapshots to keep
}

/** Event types emitted by collections */
export type CollectionEvent = 'insert' | 'update' | 'delete' | 'compact' | 'drop';

/** Event listener callback */
export type EventListener = (event: {
  type: CollectionEvent;
  docId?: string;
  doc?: Document;
  oldDoc?: Document;
  timestamp: number;
}) => void;

/** Generate a unique ID: base36 timestamp + random suffix */
export function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}_${rand}`;
}
