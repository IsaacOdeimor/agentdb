import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { StorageEngine } from './engine.js';
import { Collection } from './collection.js';
import { BackupManager, BackupMeta } from './backup.js';
import { MigrationRunner } from './migration.js';
import { deriveKey, EncryptionKey } from './encryption.js';
import { DatabaseOptions, CollectionOptions, VERSION } from './types.js';
import { EncryptionError, WALError } from './errors.js';

/**
 * AgentDB — a lightweight embedded document database.
 *
 * Features:
 *   - Custom binary format (.agdb files)
 *   - CRC32 checksums per record
 *   - Optional AES-256-GCM encryption
 *   - Optional zlib compression
 *   - Write-Ahead Log for crash safety
 *   - Field indexes with binary search
 *   - Schema validation
 *   - TTL auto-expiry
 *   - Chainable query builder
 *   - Aggregation pipeline
 *   - Streaming cursors
 *   - Event emitters
 *   - Backup & restore
 *   - Version-based migrations
 *
 * Usage:
 *   const db = new AgentDB('/path/to/data', { compressionEnabled: true });
 *   await db.open();
 *
 *   const users = db.collection('users');
 *   users.insert({ name: 'Alice', age: 30 });
 *
 *   const results = users.query()
 *     .where('age', '>=', 18)
 *     .sort('name', 'asc')
 *     .limit(10)
 *     .exec();
 *
 *   db.close();
 */
export class AgentDB {
  private dataDir: string;
  private lockPath: string;
  private lockFd: number | null = null;
  private collections: Map<string, Collection> = new Map();
  private opened = false;
  private options: DatabaseOptions;
  private encryptionKey: EncryptionKey | null = null;
  private backupManager: BackupManager;
  private migrationRunner: MigrationRunner;
  private _ttlInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, options: DatabaseOptions = {}) {
    this.dataDir = dataDir;
    this.lockPath = path.join(dataDir, '.agentdb.lock');
    this.options = {
      autoCompact: true,
      compactThreshold: 0.3,
      maxBackups: 5,
      ...options,
    };
    this.backupManager = new BackupManager(dataDir);
    this.migrationRunner = new MigrationRunner();
  }

  /** Initialize the database */
  async open(): Promise<void> {
    if (this.opened) return;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.acquireLock();

    try {
      // Derive encryption key if password provided
      if (this.options.encryptionKey) {
        const saltPath = path.join(this.dataDir, '.salt');
        let salt: Buffer | undefined;
        if (fs.existsSync(saltPath)) {
          salt = fs.readFileSync(saltPath);
        }
        this.encryptionKey = deriveKey(this.options.encryptionKey, salt);
        if (!salt) {
          fs.writeFileSync(saltPath, this.encryptionKey.salt);
        }
      }

      // Backup on open if configured
      if (this.options.backupOnOpen) {
        try {
          this.backupManager.create('auto-open');
          if (this.options.maxBackups) {
            this.backupManager.prune(this.options.maxBackups);
          }
        } catch { /* best effort */ }
      }

      // Load existing collections
      const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.agdb'));
      for (const file of files) {
        const name = path.basename(file, '.agdb');
        if (!this.collections.has(name)) {
          await this.loadCollection(name);
        }
      }

      // Start TTL purge interval (every 60 seconds)
      this._ttlInterval = setInterval(() => this.purgeAllExpired(), 60_000);

      this.opened = true;
    } catch (err) {
      if (this._ttlInterval) {
        clearInterval(this._ttlInterval);
        this._ttlInterval = null;
      }
      for (const col of this.collections.values()) {
        col.close();
      }
      this.collections.clear();
      this.opened = false;
      this.releaseLock();
      throw err;
    }
  }

  /**
   * Get or create a collection — synchronous, safe to call after `open()`.
   *
   * Use this for collections that already exist on disk (loaded during `open()`)
   * or when you need a synchronous reference. The underlying fs calls are sync
   * so the collection is fully ready by the time this returns.
   *
   * Prefer `getCollection()` when creating a brand-new collection for the first
   * time and you want an explicit async guarantee before inserting.
   */
  collection(name: string, options?: CollectionOptions): Collection {
    const existing = this.collections.get(name);
    if (existing) return existing;

    const opts: CollectionOptions = {
      compression: this.options.compressionEnabled,
      ...options,
    };

    const filePath = path.join(this.dataDir, `${name}.agdb`);
    const engine = new StorageEngine(filePath);
    if (opts.compression) engine.setCompression(true);
    if (this.encryptionKey) engine.setEncryptionKey(this.encryptionKey.key);

    const col = new Collection(name, engine, opts);
    this.collections.set(name, col);

    // Synchronous load — engine uses sync fs calls internally
    // We call load() which is async in signature but sync in implementation
    const loadPromise = col.load();
    // Since fs operations are synchronous, the promise resolves immediately
    // But we still handle it properly
    loadPromise.catch((err) => {
      console.error(`Failed to load collection "${name}":`, err);
    });

    return col;
  }

  /**
   * Get or create a collection — async, guaranteed fully loaded before returning.
   *
   * Use this when creating a collection for the first time and you want a hard
   * async guarantee. For collections already loaded by `open()`, `collection()`
   * is equivalent and simpler.
   */
  async getCollection(name: string, options?: CollectionOptions): Promise<Collection> {
    const existing = this.collections.get(name);
    if (existing) return existing;

    const opts: CollectionOptions = {
      compression: this.options.compressionEnabled,
      ...options,
    };

    return this.loadCollection(name, opts);
  }

  listCollections(): string[] {
    return Array.from(this.collections.keys());
  }

  dropCollection(name: string): boolean {
    const col = this.collections.get(name);
    if (!col) return false;
    col.close();
    this.collections.delete(name);
    const filePath = path.join(this.dataDir, `${name}.agdb`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // Also remove WAL
    const walPath = filePath + '.wal';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    return true;
  }

  close(): void {
    if (this._ttlInterval) {
      clearInterval(this._ttlInterval);
      this._ttlInterval = null;
    }
    for (const col of this.collections.values()) {
      col.close();
    }
    this.collections.clear();
    this.opened = false;
    this.releaseLock();
  }

  // ── Backup & Restore ───────────────────────────────────

  /** Create a snapshot backup */
  backup(label?: string): BackupMeta {
    return this.backupManager.create(label);
  }

  /** List all backups */
  listBackups(): BackupMeta[] {
    return this.backupManager.list();
  }

  /** Restore from a backup — closes and reopens all collections */
  async restore(backupId: string): Promise<void> {
    // Close all collections first
    for (const col of this.collections.values()) col.close();
    this.collections.clear();

    // Restore files
    this.backupManager.restore(backupId);

    // Reload
    this.opened = false;
    await this.open();
  }

  /** Delete a backup */
  deleteBackup(backupId: string): boolean {
    return this.backupManager.delete(backupId);
  }

  /** Export a collection to JSON */
  exportJSON(collectionName: string, outputPath: string): void {
    const col = this.collections.get(collectionName);
    if (!col) throw new Error(`Collection "${collectionName}" not found`);
    this.backupManager.exportJSON(collectionName, outputPath, col.allDocs());
  }

  /** Import documents from JSON into a collection */
  importJSON(collectionName: string, inputPath: string): number {
    const col = this.collection(collectionName);
    const docs = this.backupManager.importJSON(inputPath);
    const ids = col.insertMany(docs);
    return ids.length;
  }

  fullTextSearch(collectionName: string, query: string, fields: string[]) {
    const col = this.collection(collectionName);
    return col.search(query, fields);
  }

  async rotateEncryptionKey(oldPassword: string, newPassword: string): Promise<void> {
    await this.open();

    const saltPath = path.join(this.dataDir, '.salt');
    if (!fs.existsSync(saltPath)) {
      throw new EncryptionError('Encryption salt not found');
    }

    const oldKey = await this.validateEncryptionPassword(oldPassword, saltPath);
    const newKey = deriveKey(newPassword);
    const backupDir = this.createRotationBackup();

    try {
      for (const collection of this.collections.values()) {
        collection.setEncryptionKey(newKey.key);
        await collection.rewriteStorage();
      }

      fs.writeFileSync(saltPath, newKey.salt);
      this.encryptionKey = newKey;
      this.options.encryptionKey = newPassword;
    } catch (err) {
      for (const collection of this.collections.values()) {
        collection.close();
      }
      this.restoreRotationBackup(backupDir);
      fs.writeFileSync(saltPath, oldKey.salt);
      this.encryptionKey = oldKey;
      this.options.encryptionKey = oldPassword;

      for (const collection of this.collections.values()) {
        collection.setEncryptionKey(oldKey.key);
        await collection.load();
      }

      throw err;
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }

  // ── TTL ────────────────────────────────────────────────

  /** Purge expired documents from all collections */
  purgeAllExpired(): number {
    let total = 0;
    for (const col of this.collections.values()) {
      total += col.purgeExpired();
    }
    return total;
  }

  // ── Migrations ─────────────────────────────────────────

  /** Get the migration runner for registering custom migrations */
  getMigrationRunner(): MigrationRunner {
    return this.migrationRunner;
  }

  // ── Stats ──────────────────────────────────────────────

  stats() {
    const cols: Record<string, any> = {};
    for (const [name, col] of this.collections) {
      cols[name] = col.stats();
    }
    return {
      dataDir: this.dataDir,
      version: VERSION,
      collections: cols,
      collectionCount: this.collections.size,
      encrypted: !!this.encryptionKey,
      compression: !!this.options.compressionEnabled,
    };
  }

  /** Check if the database is open */
  isOpen(): boolean {
    return this.opened;
  }

  // ── Private ────────────────────────────────────────────

  private async loadCollection(name: string, options?: CollectionOptions): Promise<Collection> {
    const opts: CollectionOptions = {
      compression: this.options.compressionEnabled,
      ...options,
    };
    const filePath = path.join(this.dataDir, `${name}.agdb`);
    const engine = new StorageEngine(filePath);
    if (opts.compression) engine.setCompression(true);
    if (this.encryptionKey) engine.setEncryptionKey(this.encryptionKey.key);

    const col = new Collection(name, engine, opts);
    await col.load();
    this.collections.set(name, col);
    return col;
  }

  private acquireLock(): void {
    if (this.lockFd !== null) {
      return;
    }

    while (true) {
      try {
        this.lockFd = fs.openSync(this.lockPath, 'wx');
        const payload = JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          dir: this.dataDir,
        });
        fs.writeFileSync(this.lockFd, payload, 'utf-8');
        fs.fsyncSync(this.lockFd);
        return;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') {
          throw err;
        }

        if (!this.clearStaleLock()) {
          throw new WALError(`Database directory is already in use: ${this.dataDir}`);
        }
      }
    }
  }

  private clearStaleLock(): boolean {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf-8');
      const parsed = JSON.parse(raw || '{}');
      const pid = Number(parsed.pid);
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return false;
      }
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      try {
        if (fs.existsSync(this.lockPath)) {
          fs.unlinkSync(this.lockPath);
        }
        return true;
      } catch {
        return false;
      }
    }
  }

  private releaseLock(): void {
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {
        // best effort
      }
      this.lockFd = null;
    }

    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // best effort
    }
  }

  private async validateEncryptionPassword(password: string, saltPath: string): Promise<EncryptionKey> {
    const salt = fs.readFileSync(saltPath);
    const candidate = deriveKey(password, salt);
    const files = fs.readdirSync(this.dataDir).filter((file) => file.endsWith('.agdb'));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-validate-'));

    try {
      for (const file of files) {
        const sourcePath = path.join(this.dataDir, file);
        const tempPath = path.join(tempDir, file);
        const expectedActiveRecords = this.readActiveRecordCount(sourcePath);
        fs.copyFileSync(sourcePath, tempPath);

        const engine = new StorageEngine(tempPath);
        engine.setEncryptionKey(candidate.key);
        try {
          await engine.open();
          const records = engine.scanAll();
          if (expectedActiveRecords > 0 && records.length !== expectedActiveRecords) {
            throw new EncryptionError('Decryption failed - wrong key or corrupted data');
          }
        } finally {
          engine.close();
        }
      }
      return candidate;
    } catch {
      throw new EncryptionError('Decryption failed — wrong key or corrupted data');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private readActiveRecordCount(filePath: string): number {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(4);
      fs.readSync(fd, buffer, 0, 4, 28);
      return buffer.readUInt32LE(0);
    } finally {
      fs.closeSync(fd);
    }
  }

  private createRotationBackup(): string {
    const backupDir = path.join(this.dataDir, `_rotation_${Date.now()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    const files = fs.readdirSync(this.dataDir).filter((file) => file.endsWith('.agdb') || file.endsWith('.agdb.wal') || file === '.salt');
    for (const file of files) {
      fs.copyFileSync(path.join(this.dataDir, file), path.join(backupDir, file));
    }
    return backupDir;
  }

  private restoreRotationBackup(backupDir: string): void {
    const restoreFiles = fs.readdirSync(backupDir);
    for (const file of restoreFiles) {
      fs.copyFileSync(path.join(backupDir, file), path.join(this.dataDir, file));
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === 'EPERM') {
      return true;
    }
    return false;
  }
}
