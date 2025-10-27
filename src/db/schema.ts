/**
 * Database schema definitions for upload state tracking
 */

export const SCHEMA_VERSION = 3;

export const CREATE_TABLES_SQL = `
-- Collections table: maps directory paths to Ente collection IDs
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ente_collection_id INTEGER UNIQUE,
  directory_path TEXT UNIQUE NOT NULL,
  collection_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Files table: tracks upload status of each file
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT UNIQUE NOT NULL,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  file_size INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL,
  file_hash TEXT,
  ente_file_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')) DEFAULT 'pending',
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Config table: stores configuration and metadata
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_collection_id ON files(collection_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collections_directory_path ON collections(directory_path);
CREATE INDEX IF NOT EXISTS idx_upload_parts_file_id ON upload_parts(file_id);
CREATE INDEX IF NOT EXISTS idx_upload_parts_status ON upload_parts(status);
`;

export interface Collection {
  id: number;
  ente_collection_id: number | null;
  directory_path: string;
  collection_name: string;
  created_at: number;
}

export interface FileRecord {
  id: number;
  file_path: string;
  collection_id: number;
  file_size: number;
  file_mtime: number;
  file_hash: string | null;
  ente_file_id: number | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConfigEntry {
  key: string;
  value: string;
}

export interface UploadPart {
  id: number;
  file_id: number;
  object_key: string;
  complete_url: string;
  part_number: number;
  part_url: string;
  part_etag: string | null;
  bytes_uploaded: number;
  status: "pending" | "uploading" | "completed" | "failed";
  created_at: number;
  updated_at: number;
}

export interface ScanCheckpoint {
  id: number;
  root_path: string;
  last_scanned_path: string;
  files_discovered: number;
  directories_scanned: number;
  bytes_found: number;
  scan_complete: boolean;
  created_at: number;
  updated_at: number;
}
