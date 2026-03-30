// ── Backup & Restore ─────────────────────────────────────────
// Point-in-time snapshots with atomic restore.
// Supports JSON export/import for interop.

import * as fs from 'fs';
import * as path from 'path';

/** Metadata for a backup */
export interface BackupMeta {
  id: string;
  timestamp: number;
  collections: string[];
  sizeBytes: number;
  path: string;
}

/**
 * BackupManager — create and restore database snapshots.
 *
 * Snapshots are stored as directories containing copies of all .agdb files
 * plus a manifest.json with metadata.
 */
export class BackupManager {
  private dataDir: string;
  private backupDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, '_backups');
  }

  /** Create a snapshot backup. Returns backup metadata. */
  create(label?: string): BackupMeta {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const id = `${Date.now()}_${label || 'snapshot'}`;
    const snapshotDir = path.join(this.backupDir, id);
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Copy all .agdb files
    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.agdb'));
    let totalSize = 0;

    for (const file of files) {
      const src = path.join(this.dataDir, file);
      const dst = path.join(snapshotDir, file);
      fs.copyFileSync(src, dst);
      totalSize += fs.statSync(dst).size;
    }

    const meta: BackupMeta = {
      id,
      timestamp: Date.now(),
      collections: files.map(f => path.basename(f, '.agdb')),
      sizeBytes: totalSize,
      path: snapshotDir,
    };

    // Write manifest
    fs.writeFileSync(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify(meta, null, 2),
    );

    return meta;
  }

  /** List all available backups, newest first */
  list(): BackupMeta[] {
    if (!fs.existsSync(this.backupDir)) return [];

    const entries = fs.readdirSync(this.backupDir, { withFileTypes: true });
    const backups: BackupMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(this.backupDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        meta.path = path.join(this.backupDir, entry.name);
        backups.push(meta);
      } catch {
        // skip corrupt manifest
      }
    }

    return backups.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Restore from a backup.
   * Creates a pre-restore backup automatically before overwriting.
   */
  restore(backupId: string): void {
    const snapshotDir = path.join(this.backupDir, backupId);
    if (!fs.existsSync(snapshotDir)) {
      throw new Error(`Backup "${backupId}" not found`);
    }

    // Safety: create a pre-restore backup
    this.create('pre-restore');

    // Copy all .agdb files from snapshot back to data dir
    const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.agdb'));
    for (const file of files) {
      const src = path.join(snapshotDir, file);
      const dst = path.join(this.dataDir, file);
      fs.copyFileSync(src, dst);
    }
  }

  /** Delete a backup */
  delete(backupId: string): boolean {
    const snapshotDir = path.join(this.backupDir, backupId);
    if (!fs.existsSync(snapshotDir)) return false;
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    return true;
  }

  /** Prune old backups, keeping only the N most recent */
  prune(keepCount: number): number {
    const backups = this.list();
    let pruned = 0;
    for (let i = keepCount; i < backups.length; i++) {
      this.delete(backups[i].id);
      pruned++;
    }
    return pruned;
  }

  /**
   * Export a collection to JSON (for interop / debugging).
   * Reads the .agdb file and outputs a JSON array of documents.
   */
  exportJSON(collectionName: string, outputPath: string, docs: any[]): void {
    const data = JSON.stringify(docs, null, 2);
    fs.writeFileSync(outputPath, data, 'utf-8');
  }

  /**
   * Import documents from a JSON file.
   * Returns the parsed array of documents.
   */
  importJSON(inputPath: string): any[] {
    const raw = fs.readFileSync(inputPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('JSON import must be an array');
    return parsed;
  }
}
