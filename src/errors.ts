// ── AgentDB Error Types ──────────────────────────────────────

export class AgentDBError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDBError';
  }
}

export class CorruptionError extends AgentDBError {
  readonly filePath: string;
  readonly offset: number;
  constructor(message: string, filePath: string, offset: number) {
    super(`Corruption at offset ${offset} in ${filePath}: ${message}`);
    this.name = 'CorruptionError';
    this.filePath = filePath;
    this.offset = offset;
  }
}

export class ChecksumError extends CorruptionError {
  readonly expected: number;
  readonly actual: number;
  constructor(filePath: string, offset: number, expected: number, actual: number) {
    super(`CRC32 mismatch (expected ${expected.toString(16)}, got ${actual.toString(16)})`, filePath, offset);
    this.name = 'ChecksumError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class WALError extends AgentDBError {
  constructor(message: string) {
    super(message);
    this.name = 'WALError';
  }
}

export class EncryptionError extends AgentDBError {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export class SchemaError extends AgentDBError {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    super(`Schema violation on "${field}": ${reason}`);
    this.name = 'SchemaError';
    this.field = field;
    this.reason = reason;
  }
}

export class MigrationError extends AgentDBError {
  readonly fromVersion: number;
  readonly toVersion: number;
  constructor(from: number, to: number, message: string) {
    super(`Migration v${from} → v${to} failed: ${message}`);
    this.name = 'MigrationError';
    this.fromVersion = from;
    this.toVersion = to;
  }
}

export class CollectionNotFoundError extends AgentDBError {
  constructor(name: string) {
    super(`Collection "${name}" not found`);
    this.name = 'CollectionNotFoundError';
  }
}

export class DocumentNotFoundError extends AgentDBError {
  constructor(id: string, collection: string) {
    super(`Document "${id}" not found in "${collection}"`);
    this.name = 'DocumentNotFoundError';
  }
}
