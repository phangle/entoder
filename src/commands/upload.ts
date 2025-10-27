/**
 * Upload command implementation
 */

import type { Logger } from "pino";
import { DatabaseManager, getDefaultDatabasePath } from "../db";
import { APIClient } from "../api/client";
import { AuthenticationService, SessionStorage } from "../auth/service";
import { CollectionService } from "../collections/service";
import { SyncService } from "../sync/service";
import { directoryToCollectionName } from "../collections/naming";
import { scanDirectory } from "../discovery/scanner";
import { isSupported } from "../discovery/file-type";
import { uploadFiles } from "../upload/pipeline";
import { calculateFileHash } from "../upload/hash";
import { mkdir } from "fs/promises";
import { dirname, basename } from "path";
import { ProgressReporter, type UploadJobSummary, formatBytes } from "../utils/progress";

export interface UploadOptions {
  email: string;
  password?: string;
  apiServer: string;
  concurrency: number;
  dryRun: boolean;
  logger: Logger; // Required logger instance
}

export async function uploadCommand(
  paths: string[],
  options: UploadOptions
): Promise<void> {
  const logger = options.logger;
  logger.info("🚀 Entoder (Ente Photo Loader)");

  // Initialize database
  const dbPath = getDefaultDatabasePath();
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseManager(dbPath);

  // Initialize API client
  const client = new APIClient({
    baseURL: options.apiServer,
    logger,
  });

  const authService = new AuthenticationService(client);

  // Try to load existing session
  let session = SessionStorage.load(db);

  // Authenticate if no valid session (skip in dry-run mode)
  if (!session && !options.dryRun) {
    if (!options.password) {
      logger.error("❌ Password required for first-time authentication");
      process.exit(1);
    }

    logger.info(`🔐 Authenticating as ${options.email}...`);

    try {
      const { token, masterKey, userId } = await authService.login(
        options.email,
        options.password
      );

      // Create session (expires in 7 days)
      session = {
        email: options.email,
        token,
        userId,
        masterKey: Buffer.from(masterKey).toString("base64"),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      SessionStorage.save(db, session);
      logger.info("✅ Authentication successful");
    } catch (error) {
      logger.error({ err: error }, `❌ Authentication failed: ${error}`);
      process.exit(1);
    }
  } else if (session) {
    logger.info(`✅ Using cached session for ${session.email}`);
  } else if (options.dryRun) {
    logger.info(`ℹ️  Skipping authentication (dry-run mode)`);
  }

  // Sync existing files from server (before discovery)
  if (!options.dryRun && session) {
    logger.info("📥 Syncing existing files from Ente server...");

    const masterKeyBytes = Buffer.from(session.masterKey, "base64");
    const collectionService = new CollectionService(
      client,
      db,
      session.token,
      masterKeyBytes
    );

    // Fetch all collections from server
    const remoteCollections = await collectionService.fetchCollections();
    logger.info(`   Found ${remoteCollections.length} collections on server`);

    // Sync files from server to build hash cache
    const syncService = new SyncService(
      client,
      db,
      session.token,
      masterKeyBytes
    );

    const { synced, errors } = await syncService.syncAllFiles(remoteCollections);
    logger.info(`   ✓ Synced ${synced} files from server`);
    if (errors > 0) {
      logger.warn(`   ⚠️  ${errors} errors during sync`);
    }
  }

  // Discover files
  logger.info("📁 Scanning directories...");
  let discoveredCount = 0;
  let supportedCount = 0;
  let skippedCount = 0;
  let lastScanProgress = 0;

  for (const path of paths) {
    // Check if we have a previous scan checkpoint
    const checkpoint = db.getScanCheckpoint(path);
    if (checkpoint && !checkpoint.scan_complete) {
      logger.info(`   Resuming scan from: ${checkpoint.last_scanned_path}`);
      logger.info(`   Previously discovered: ${checkpoint.files_discovered} files, ${checkpoint.directories_scanned} dirs`);
    } else {
      logger.info(`   Scanning: ${path}`);
    }

    for await (const file of scanDirectory(path, {
      onProgress: (progress) => {
        // Report scan progress every 2 seconds (not too frequent)
        const now = Date.now();
        if (now - lastScanProgress >= 2000) {
          const elapsed = Math.floor(progress.elapsedMs / 1000);
          logger.info(
            `   📂 Scanning... ${progress.filesScanned} files, ${progress.directoriesScanned} dirs ` +
            `(${formatBytes(progress.bytesFound)}, ${elapsed}s)`
          );
          lastScanProgress = now;

          // Persist checkpoint every 2 seconds for crash recovery
          if (!options.dryRun) {
            db.upsertScanCheckpoint(
              path,
              progress.currentPath,
              progress.filesScanned,
              progress.directoriesScanned,
              progress.bytesFound,
              false
            );
          }
        }
      },
      progressIntervalMs: 2000, // Check every 2 seconds
    })) {
      discoveredCount++;

      if (!isSupported(file.path)) {
        continue;
      }

      supportedCount++;

      // Check if file already in database
      const existingFile = db.getFileByPath(file.path);
      if (existingFile) {
        // Update if modification time changed
        if (existingFile.file_mtime !== file.mtime) {
          db.updateFileStatus(existingFile.id, "pending");
        } else if (existingFile.status === "completed" || existingFile.status === "skipped") {
          // Already uploaded or duplicate, skip
          skippedCount++;
        } else if (existingFile.status === "failed" || existingFile.status === "in_progress") {
          // Retry failed or interrupted uploads
          db.updateFileStatus(existingFile.id, "pending");
        }
        continue;
      }

      // Get or create collection for this directory
      let collection = db.getCollectionByPath(file.directory);
      if (!collection) {
        // Check if we already have a remote collection with a matching basename
        // Extract basename from the collection name (strip any (2), (3) suffixes)
        const collectionName = basename(file.directory) || "root";
        const allCollections = db.getAllCollections();
        const existingRemote = allCollections.find((c) => {
          if (!c.ente_collection_id) return false;
          // Match either exact name or name with number suffix like "video (2)"
          const baseName = c.collection_name.replace(/\s*\(\d+\)$/, "");
          return baseName === collectionName;
        });

        if (existingRemote) {
          // Update the directory path to point to this local directory
          // This links the remote collection to our local directory
          db.updateCollectionPath(existingRemote.id, file.directory);
          collection = db.getCollectionById(existingRemote.id)!;
        } else {
          // Create new collection
          collection = db.createCollection(
            null, // Will be set when created on Ente
            file.directory,
            collectionName
          );
        }
      }

      // Add file to database (or check if duplicate exists on server)
      if (options.dryRun) {
        logger.info(`   [DRY RUN] Would add: ${file.path}`);
      } else {
        try {
          // Calculate hash to check for duplicates
          const hash = await calculateFileHash(file.path);
          const duplicateFile = db.getFileByHash(hash);

          if (duplicateFile) {
            // Duplicate found! Skip this file
            logger.info(`   ⏭️  Skipping duplicate: ${file.path}`);
            logger.info(`      (matches: ${duplicateFile.file_path})`);

            // Create file record and mark as skipped
            const fileRecord = db.createFile(file.path, collection.id, file.size, file.mtime);
            db.updateFileStatus(fileRecord.id, "skipped", "Duplicate file");
            db.setFileHash(fileRecord.id, hash);
            if (duplicateFile.ente_file_id) {
              db.setFileEnteID(fileRecord.id, duplicateFile.ente_file_id);
            }

            skippedCount++;
          } else {
            // New file, add to upload queue
            const fileRecord = db.createFile(file.path, collection.id, file.size, file.mtime);
            db.setFileHash(fileRecord.id, hash);
          }
        } catch (error) {
          // File access error (permission denied, file deleted, etc.)
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`   ⚠️  Failed to process file: ${file.path}`);
          logger.warn(`      Error: ${errorMessage}`);

          // Create file record and mark as failed for later retry
          const fileRecord = db.createFile(file.path, collection.id, file.size, file.mtime);
          db.updateFileStatus(fileRecord.id, "failed", errorMessage);
        }
      }
    }

    // Mark scan as complete for this path
    if (!options.dryRun) {
      db.markScanComplete(path);
    }
  }

  // Get file statistics (memory efficient - doesn't load all files)
  const stats = db.getFileStats();
  const pendingStats = stats.byStatus["pending"] || { count: 0, bytes: 0 };
  const completedStats = stats.byStatus["completed"] || { count: 0, bytes: 0 };
  const skippedStats = stats.byStatus["skipped"] || { count: 0, bytes: 0 };

  const totalBytes = stats.totalBytes;
  const newBytes = pendingStats.bytes;

  // Create job summary
  const jobSummary: UploadJobSummary = {
    totalFiles: supportedCount,
    newFiles: pendingStats.count,
    alreadyUploaded: skippedCount,
    totalBytes,
    newBytes,
  };

  // Create progress reporter
  const progressReporter = new ProgressReporter(jobSummary, {
    logLevel: logger.level,
  });

  // Report job summary
  progressReporter.reportJobSummary();

  if (options.dryRun) {
    logger.info("✅ Dry run complete (no files uploaded)");
    db.close();
    return;
  }

  if (pendingStats.count === 0) {
    logger.info("✅ No files to upload");
    db.close();
    return;
  }

  // Now load pending files for upload (only when actually needed)
  logger.info(`📋 Loading ${pendingStats.count} pending files...`);
  const pendingFiles = db.getFilesByStatus("pending");

  if (!session) {
    logger.error("❌ No valid session - cannot upload");
    process.exit(1);
  }

  // Collection service was already initialized during sync
  const masterKeyBytes = Buffer.from(session.masterKey, "base64");
  const collectionService = new CollectionService(
    client,
    db,
    session.token,
    masterKeyBytes
  );

  // Ensure all collections exist on Ente server
  logger.info("\n📂 Setting up collections...");
  const collections = db.getAllCollections();
  const existingCollectionNames = new Set<string>();

  // Cache collection keys (collectionID -> collectionKey)
  const collectionKeys = new Map<number, string>();

  for (const collection of collections) {
    if (collection.ente_collection_id !== null) {
      // Existing collection - fetch its key
      // Only add to existingNames if it's a real local collection (not a synced placeholder)
      if (!collection.directory_path.startsWith("<remote:")) {
        existingCollectionNames.add(collection.collection_name);
      }

      // Get collection key from server
      const enteCollection = await collectionService.getOrCreateCollectionForDirectory(
        collection.directory_path
      );
      collectionKeys.set(collection.ente_collection_id, enteCollection.key);

      logger.info(`   ✓ ${collection.collection_name} (existing)`);
      continue;
    }

    // Create collection on Ente
    const collectionName = directoryToCollectionName(
      collection.directory_path,
      existingCollectionNames
    );

    logger.info(`   Creating: ${collectionName}...`);

    const enteCollection = await collectionService.getOrCreateCollectionForDirectory(
      collection.directory_path
    );

    // Update database with Ente collection ID
    db.updateCollectionEnteID(collection.id, enteCollection.id);

    // Cache the collection key
    collectionKeys.set(enteCollection.id, enteCollection.key);

    existingCollectionNames.add(collectionName);
    logger.info(`   ✓ ${collectionName} (created)`);
  }

  // Group files by collection for upload
  logger.info("\n📤 Uploading files...");
  const filesByCollection = new Map<number, typeof pendingFiles>();

  for (const file of pendingFiles) {
    const files = filesByCollection.get(file.collection_id) || [];
    files.push(file);
    filesByCollection.set(file.collection_id, files);
  }

  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let bytesCompleted = 0;

  // Upload files for each collection
  for (const [collectionId, files] of filesByCollection.entries()) {
    const collection = db.getCollectionById(collectionId);
    if (!collection || collection.ente_collection_id === null) {
      logger.error(`❌ Collection ${collectionId} not found or not synced`);
      continue;
    }

    logger.info(`\n📁 Collection: ${collection.collection_name} (${files.length} files)`);

    // Get collection key from cache
    const collectionKey = collectionKeys.get(collection.ente_collection_id);

    if (!collectionKey) {
      logger.error(`❌ Collection key not found in cache`);
      continue;
    }

    // Track counts for this collection
    let collectionSuccessful = 0;
    let collectionFailed = 0;
    let collectionSkipped = 0;

    // Upload files with progress reporting
    const { successful, failed, skipped } = await uploadFiles(
      files,
      {
        client,
        authToken: session.token,
        collectionID: collection.ente_collection_id,
        collectionKey,
      },
      db,
      (fileCompleted) => {
        // Update progress after each file
        const totalCompleted = totalSuccessful + totalFailed + totalSkipped + collectionSuccessful + collectionFailed + collectionSkipped;
        bytesCompleted += fileCompleted.file_size;

        progressReporter.reportProgress({
          filesCompleted: totalCompleted + 1,
          filesTotal: pendingFiles.length,
          bytesCompleted,
          bytesTotal: newBytes,
        });

        // Update collection counters based on file status
        const fileRecord = db.getFileById(fileCompleted.id);
        if (fileRecord) {
          if (fileRecord.status === "completed") collectionSuccessful++;
          else if (fileRecord.status === "failed") collectionFailed++;
          else if (fileRecord.status === "skipped") collectionSkipped++;
        }
      }
    );

    totalSuccessful += successful;
    totalFailed += failed;
    totalSkipped += skipped;
  }

  // Report completion
  progressReporter.reportCompletion(totalSuccessful, totalFailed, totalSkipped);

  db.close();
}
