/**
 * Database connection and operations
 */

import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL, SCHEMA_VERSION, type FileRecord, type Collection, type ConfigEntry, type UploadPart, type ScanCheckpoint } from "./schema";
import { logger } from "../utils/logger";

export class DatabaseManager {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.initialize();
  }

  private initialize() {
    // Enable WAL mode for better crash resilience
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    // Create tables
    this.db.exec(CREATE_TABLES_SQL);

    // Check/set schema version
    const versionStr = this.getConfig("schema_version");
    const currentVersion = versionStr ? parseInt(versionStr) : 0;

    if (currentVersion === 0) {
      // New database
      this.setConfig("schema_version", SCHEMA_VERSION.toString());
    } else if (currentVersion < SCHEMA_VERSION) {
      // Migrate from older version
      this.migrate(currentVersion, SCHEMA_VERSION);
      this.setConfig("schema_version", SCHEMA_VERSION.toString());
    } else if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}. Please update entoder.`);
    }
  }

  private migrate(fromVersion: number, toVersion: number) {
    logger().info(`Migrating database from version ${fromVersion} to ${toVersion}...`);

    // Migration from v1 to v2: Add upload_parts table
    if (fromVersion === 1 && toVersion >= 2) {
      this.db.exec(`
        -- Upload parts table: tracks progress of multipart uploads
        CREATE TABLE IF NOT EXISTS upload_parts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          object_key TEXT NOT NULL,
          complete_url TEXT NOT NULL,
          part_number INTEGER NOT NULL,
          part_url TEXT NOT NULL,
          part_etag TEXT,
          bytes_uploaded INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('pending', 'uploading', 'completed', 'failed')) DEFAULT 'pending',
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          UNIQUE(file_id, part_number)
        );

        CREATE INDEX IF NOT EXISTS idx_upload_parts_file_id ON upload_parts(file_id);
        CREATE INDEX IF NOT EXISTS idx_upload_parts_status ON upload_parts(status);
      `);
      logger().info(`✓ Migrated to version 2: Added upload_parts table for resumable uploads`);
    }

    // Migration from v2 to v3: Add scan_checkpoints table
    if (fromVersion <= 2 && toVersion >= 3) {
      this.db.exec(`
        -- Scan checkpoints table: tracks scan progress for resumability
        CREATE TABLE IF NOT EXISTS scan_checkpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL,
          last_scanned_path TEXT NOT NULL,
          files_discovered INTEGER NOT NULL DEFAULT 0,
          directories_scanned INTEGER NOT NULL DEFAULT 0,
          bytes_found INTEGER NOT NULL DEFAULT 0,
          scan_complete BOOLEAN NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          UNIQUE(root_path)
        );
      `);
      logger().info(`✓ Migrated to version 3: Added scan_checkpoints table for resumable directory scanning`);
    }
  }

  // Config operations
  getConfig(key: string): string | null {
    const result = this.db.query("SELECT value FROM config WHERE key = ?").get(key) as ConfigEntry | null;
    return result?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db.run(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
  }

  // Collection operations
  createCollection(enteCollectionId: number | null, directoryPath: string, collectionName: string): Collection {
    const result = this.db.run(
      "INSERT INTO collections (ente_collection_id, directory_path, collection_name) VALUES (?, ?, ?)",
      [enteCollectionId, directoryPath, collectionName]
    );

    return this.getCollectionById(Number(result.lastInsertRowid))!;
  }

  getCollectionByPath(directoryPath: string): Collection | null {
    return this.db.query("SELECT * FROM collections WHERE directory_path = ?").get(directoryPath) as Collection | null;
  }

  getCollectionById(id: number): Collection | null {
    return this.db.query("SELECT * FROM collections WHERE id = ?").get(id) as Collection | null;
  }

  getAllCollections(): Collection[] {
    return this.db.query("SELECT * FROM collections").all() as Collection[];
  }

  updateCollectionEnteID(id: number, enteCollectionId: number): void {
    // Check if this ente_collection_id is already assigned to a different collection
    const existing = this.db.query(
      "SELECT id FROM collections WHERE ente_collection_id = ? AND id != ?"
    ).get(enteCollectionId, id) as { id: number } | null;

    if (existing) {
      // Already assigned to another collection - this is a database inconsistency
      // Log warning but don't fail - the collection might be shared or duplicated
      logger().warn(
        `Ente collection ID ${enteCollectionId} already assigned to collection ${existing.id}, skipping update for collection ${id}`
      );
      return;
    }

    this.db.run(
      "UPDATE collections SET ente_collection_id = ? WHERE id = ?",
      [enteCollectionId, id]
    );
  }

  updateCollectionPath(id: number, directoryPath: string): void {
    this.db.run(
      "UPDATE collections SET directory_path = ? WHERE id = ?",
      [directoryPath, id]
    );
  }

  // File operations
  createFile(filePath: string, collectionId: number, fileSize: number, fileMtime: number): FileRecord {
    const result = this.db.run(
      "INSERT INTO files (file_path, collection_id, file_size, file_mtime, status) VALUES (?, ?, ?, ?, 'pending')",
      [filePath, collectionId, fileSize, fileMtime]
    );

    return this.getFileById(Number(result.lastInsertRowid))!;
  }

  getFileByPath(filePath: string): FileRecord | null {
    return this.db.query("SELECT * FROM files WHERE file_path = ?").get(filePath) as FileRecord | null;
  }

  getFileById(id: number): FileRecord | null {
    return this.db.query("SELECT * FROM files WHERE id = ?").get(id) as FileRecord | null;
  }

  getFileByHash(hash: string): FileRecord | null {
    return this.db.query("SELECT * FROM files WHERE file_hash = ? AND status = 'completed'").get(hash) as FileRecord | null;
  }

  getFileByEnteID(enteFileId: number): FileRecord | null {
    return this.db.query("SELECT * FROM files WHERE ente_file_id = ?").get(enteFileId) as FileRecord | null;
  }

  getFilesByStatus(status: FileRecord["status"]): FileRecord[] {
    return this.db.query("SELECT * FROM files WHERE status = ?").all(status) as FileRecord[];
  }

  getAllFiles(): FileRecord[] {
    return this.db.query("SELECT * FROM files").all() as FileRecord[];
  }

  // Get file statistics without loading all files into memory
  getFileStats(): { totalFiles: number; totalBytes: number; byStatus: Record<string, { count: number; bytes: number }> } {
    const stats = this.db.query(`
      SELECT
        status,
        COUNT(*) as count,
        COALESCE(SUM(file_size), 0) as bytes
      FROM files
      GROUP BY status
    `).all() as Array<{ status: string; count: number; bytes: number }>;

    const byStatus: Record<string, { count: number; bytes: number }> = {};
    let totalFiles = 0;
    let totalBytes = 0;

    for (const row of stats) {
      byStatus[row.status] = { count: row.count, bytes: row.bytes };
      totalFiles += row.count;
      totalBytes += row.bytes;
    }

    return { totalFiles, totalBytes, byStatus };
  }

  updateFileStatus(
    id: number,
    status: FileRecord["status"],
    errorMessage?: string
  ): void {
    this.db.run(
      "UPDATE files SET status = ?, error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
      [status, errorMessage ?? null, id]
    );
  }

  updateFileHash(id: number, hash: string): void {
    this.db.run(
      "UPDATE files SET file_hash = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
      [hash, id]
    );
  }

  setFileHash(id: number, hash: string): void {
    this.updateFileHash(id, hash);
  }

  setFileEnteID(id: number, enteFileId: number): void {
    this.db.run(
      "UPDATE files SET ente_file_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
      [enteFileId, id]
    );
  }

  markFileCompleted(id: number, enteFileId: number): void {
    this.db.run(
      "UPDATE files SET status = 'completed', ente_file_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
      [enteFileId, id]
    );
  }

  markFileFailed(id: number, errorMessage: string): void {
    this.db.run(
      "UPDATE files SET status = 'failed', error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
      [errorMessage, id]
    );
  }

  // Upload part operations
  createUploadPart(
    fileId: number,
    objectKey: string,
    completeUrl: string,
    partNumber: number,
    partUrl: string
  ): UploadPart {
    const result = this.db.run(
      "INSERT INTO upload_parts (file_id, object_key, complete_url, part_number, part_url, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      [fileId, objectKey, completeUrl, partNumber, partUrl]
    );

    return this.getUploadPartById(Number(result.lastInsertRowid))!;
  }

  getUploadPartById(id: number): UploadPart | null {
    return this.db.query("SELECT * FROM upload_parts WHERE id = ?").get(id) as UploadPart | null;
  }

  getUploadPartsByFileId(fileId: number): UploadPart[] {
    return this.db.query("SELECT * FROM upload_parts WHERE file_id = ? ORDER BY part_number").all(fileId) as UploadPart[];
  }

  updateUploadPartStatus(
    id: number,
    status: UploadPart["status"],
    etag?: string,
    bytesUploaded?: number
  ): void {
    if (etag !== undefined && bytesUploaded !== undefined) {
      this.db.run(
        "UPDATE upload_parts SET status = ?, part_etag = ?, bytes_uploaded = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
        [status, etag, bytesUploaded, id]
      );
    } else if (bytesUploaded !== undefined) {
      this.db.run(
        "UPDATE upload_parts SET status = ?, bytes_uploaded = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
        [status, bytesUploaded, id]
      );
    } else {
      this.db.run(
        "UPDATE upload_parts SET status = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
        [status, id]
      );
    }
  }

  deleteUploadPartsByFileId(fileId: number): void {
    this.db.run("DELETE FROM upload_parts WHERE file_id = ?", [fileId]);
  }

  getFilesWithUploadParts(): FileRecord[] {
    return this.db.query(
      "SELECT DISTINCT f.* FROM files f INNER JOIN upload_parts up ON f.id = up.file_id"
    ).all() as FileRecord[];
  }

  cleanupStaleUploadParts(maxAgeSeconds: number = 86400): number {
    // Clean up upload parts older than maxAge (default 24 hours)
    const cutoffTime = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    const result = this.db.run(
      "DELETE FROM upload_parts WHERE updated_at < ?",
      [cutoffTime]
    );
    return result.changes;
  }

  // Scan checkpoint operations
  getScanCheckpoint(rootPath: string): ScanCheckpoint | null {
    return this.db.query("SELECT * FROM scan_checkpoints WHERE root_path = ?").get(rootPath) as ScanCheckpoint | null;
  }

  upsertScanCheckpoint(
    rootPath: string,
    lastScannedPath: string,
    filesDiscovered: number,
    directoriesScanned: number,
    bytesFound: number,
    scanComplete: boolean = false
  ): void {
    this.db.run(
      `INSERT INTO scan_checkpoints (root_path, last_scanned_path, files_discovered, directories_scanned, bytes_found, scan_complete, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(root_path) DO UPDATE SET
         last_scanned_path = excluded.last_scanned_path,
         files_discovered = excluded.files_discovered,
         directories_scanned = excluded.directories_scanned,
         bytes_found = excluded.bytes_found,
         scan_complete = excluded.scan_complete,
         updated_at = strftime('%s', 'now')`,
      [rootPath, lastScannedPath, filesDiscovered, directoriesScanned, bytesFound, scanComplete ? 1 : 0]
    );
  }

  markScanComplete(rootPath: string): void {
    this.db.run(
      "UPDATE scan_checkpoints SET scan_complete = 1, updated_at = strftime('%s', 'now') WHERE root_path = ?",
      [rootPath]
    );
  }

  deleteScanCheckpoint(rootPath: string): void {
    this.db.run("DELETE FROM scan_checkpoints WHERE root_path = ?", [rootPath]);
  }

  cleanupOldScanCheckpoints(maxAgeSeconds: number = 86400): number {
    // Clean up scan checkpoints older than maxAge (default 24 hours)
    const cutoffTime = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    const result = this.db.run(
      "DELETE FROM scan_checkpoints WHERE updated_at < ? AND scan_complete = 1",
      [cutoffTime]
    );
    return result.changes;
  }

  // Utility operations
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN TRANSACTION");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function getDefaultDatabasePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return `${homeDir}/.entoder/state.db`;
}
