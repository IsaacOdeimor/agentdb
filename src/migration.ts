// ── Data Migration System ────────────────────────────────────
// Version-based migration runner for upgrading .agdb file formats.
// Migrations are registered by version number and run in order.

import * as fs from 'fs';
import { MAGIC, HEADER_SIZE } from './types.js';
import { MigrationError } from './errors.js';

/** A single migration step */
export interface Migration {
  version: number;
  description: string;
  up: (filePath: string) => void;
}

/**
 * MigrationRunner — manages format migrations for .agdb files.
 *
 * Usage:
 *   const runner = new MigrationRunner();
 *   runner.register({
 *     version: 2,
 *     description: 'Add CRC32 checksums to records',
 *     up: (filePath) => { ... }
 *   });
 *   runner.migrate(filePath, currentVersion, targetVersion);
 */
export class MigrationRunner {
  private migrations: Map<number, Migration> = new Map();

  /** Register a migration */
  register(migration: Migration): void {
    this.migrations.set(migration.version, migration);
  }

  /** Register multiple migrations */
  registerAll(migrations: Migration[]): void {
    for (const m of migrations) this.register(m);
  }

  /** Get the file version from its header */
  getFileVersion(filePath: string): number {
    if (!fs.existsSync(filePath)) return 0;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, buf, 0, HEADER_SIZE, 0);
    fs.closeSync(fd);

    if (buf.subarray(0, 4).compare(MAGIC) !== 0) {
      throw new MigrationError(0, 0, `Not an AgentDB file: ${filePath}`);
    }
    return buf.readUInt8(4);
  }

  /** Update the version byte in a file's header */
  setFileVersion(filePath: string, version: number): void {
    const fd = fs.openSync(filePath, 'r+');
    const buf = Buffer.alloc(1);
    buf.writeUInt8(version, 0);
    fs.writeSync(fd, buf, 0, 1, 4);
    fs.closeSync(fd);
  }

  /**
   * Run all migrations from currentVersion+1 to targetVersion.
   * Creates a backup before each migration step.
   */
  migrate(filePath: string, targetVersion: number): void {
    const currentVersion = this.getFileVersion(filePath);
    if (currentVersion >= targetVersion) return; // already up to date

    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      const migration = this.migrations.get(v);
      if (!migration) {
        throw new MigrationError(currentVersion, targetVersion,
          `No migration registered for version ${v}`);
      }

      // Create backup before migration
      const backupPath = `${filePath}.v${currentVersion}.bak`;
      fs.copyFileSync(filePath, backupPath);

      try {
        migration.up(filePath);
        this.setFileVersion(filePath, v);

        // Clean up backup on success
        try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
      } catch (err: any) {
        // Restore from backup on failure
        try {
          fs.copyFileSync(backupPath, filePath);
          fs.unlinkSync(backupPath);
        } catch { /* best effort */ }

        throw new MigrationError(v - 1, v,
          `${migration.description}: ${err.message}`);
      }
    }
  }

  /** List all registered migrations */
  list(): Migration[] {
    return Array.from(this.migrations.values()).sort((a, b) => a.version - b.version);
  }

  /** Get the highest registered version */
  get latestVersion(): number {
    let max = 0;
    for (const v of this.migrations.keys()) {
      if (v > max) max = v;
    }
    return max;
  }
}
