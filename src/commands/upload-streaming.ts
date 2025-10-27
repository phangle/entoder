/**
 * Streaming upload command implementation
 * Uses rsync-like strategy: scan and upload in parallel
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
import { calculateFileHash } from "../upload/hash";
import {
  StreamingUploadCoordinator,
  type CollectionContext,
} from "../upload/streaming-pipeline";
import { mkdir } from "fs/promises";
import { dirname, basename } from "path";
import { formatBytes } from "../utils/progress";

export interface StreamingUploadOptions {
  email: string;
  password?: string;
  apiServer: string;
  concurrency: number;
  dryRun: boolean;
  skipSync: boolean;
  logger: Logger;
  batchSize?: number; // Files to buffer before reporting
  maxQueueSize?: number; // Maximum pending files in memory
  maxMemoryMB?: number; // Maximum memory budget for concurrent uploads
}

export async function uploadCommandStreaming(
  paths: string[],
  options: StreamingUploadOptions
): Promise<void> {
  const logger = options.logger;
  const batchSize = options.batchSize ?? 50;
  const maxQueueSize = options.maxQueueSize ?? 200;

  logger.info("🚀 Entoder (Ente Photo Loader) (Streaming Mode)");

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
  if (!options.dryRun && session && !options.skipSync) {
    logger.info("📥 Syncing existing files from Ente server...");

    const masterKeyBytes = Buffer.from(session.masterKey, "base64");
    const collectionService = new CollectionService(
      client,
      db,
      session.token,
      masterKeyBytes
    );

    const remoteCollections = await collectionService.fetchCollections();
    logger.info(`   Found ${remoteCollections.length} collections on server`);

    const syncService = new SyncService(
      client,
      db,
      session.token,
      masterKeyBytes
    );

    const { synced, errors } = await syncService.syncAllFiles(
      remoteCollections
    );
    logger.info(`   ✓ Synced ${synced} files from server`);
    if (errors > 0) {
      logger.warn(`   ⚠️  ${errors} errors during sync`);
    }
  } else if (!options.dryRun && session && options.skipSync) {
    logger.info("⏭️  Skipping sync (--skip-sync enabled, trusting local database)");
  }

  if (options.dryRun) {
    logger.info("ℹ️  Dry-run mode: scanning only (no uploads)");
  }

  // Get initial file stats from database
  const initialStats = db.getFileStats();
  const previouslyCompleted = initialStats.byStatus?.completed?.count ?? 0;
  const previouslySkipped = initialStats.byStatus?.skipped?.count ?? 0;
  const previouslyFailed = initialStats.byStatus?.failed?.count ?? 0;
  const previouslyPending = initialStats.byStatus?.pending?.count ?? 0;
  const totalPreviouslyDone = previouslyCompleted + previouslySkipped;

  // Show baseline status if resuming
  if (totalPreviouslyDone > 0 || previouslyFailed > 0 || previouslyPending > 0) {
    logger.info("📊 Database status:");
    logger.info(`   Already uploaded: ${previouslyCompleted} files`);
    if (previouslySkipped > 0) {
      logger.info(`   Skipped (duplicates): ${previouslySkipped} files`);
    }
    if (previouslyPending > 0) {
      logger.info(`   Pending upload: ${previouslyPending} files`);
    }
    if (previouslyFailed > 0) {
      logger.info(`   Failed (will retry): ${previouslyFailed} files`);
    }
  }

  // Initialize streaming coordinator
  const coordinator = new StreamingUploadCoordinator(
    {
      client,
      authToken: session?.token ?? "",
      masterKey: session ? Buffer.from(session.masterKey, "base64") : new Uint8Array(32),
      db,
      concurrency: options.concurrency,
      batchSize,
      maxQueueSize,
      maxMemoryMB: options.maxMemoryMB,
    },
    {
      onProgress: (progress) => {
        // Calculate total progress including previously completed files
        const totalCompleted = previouslyCompleted + progress.filesCompleted;
        const totalSkipped = previouslySkipped + progress.filesSkipped;
        const totalDone = totalCompleted + totalSkipped;
        const totalDiscovered = totalPreviouslyDone + progress.filesScanned;
        const totalFailed = previouslyFailed + progress.filesFailed;

        // Calculate unique files (excluding duplicates/skipped)
        // This matches what Ente web client shows
        const uniqueFiles = totalCompleted;
        const duplicates = totalSkipped;

        // Memory usage monitoring
        const memUsage = process.memoryUsage();
        const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

        // Simple progress report (only essential info at info level)
        logger.info(
          `📊 Unique: ${uniqueFiles} | Total: ${totalDone}/${totalDiscovered} | ` +
          `+${progress.filesCompleted} | Dups: ${duplicates} | ` +
          `Failed: ${totalFailed}${progress.filesFailed > 0 ? ` (+${progress.filesFailed})` : ''} | ` +
          `Mem: ${memMB}/${memTotalMB}MB`
        );

        // Detailed stats at trace level for debugging
        logger.trace(
          `   Queued: ${progress.filesQueued} | ` +
          `Processing: ${progress.filesProcessing} | ` +
          `Previously done: ${totalPreviouslyDone}`
        );

        // Warn if memory usage is high
        if (memMB > 1024) {
          logger.warn(`   ⚠️  High memory usage: ${memMB}MB`);
        }
      },
      onFileComplete: (file) => {
        // Individual file completions at trace level
        logger.trace(`   ✓ ${file.file_path}`);
      },
    }
  );

  // Prepare collection contexts (needed for upload workers)
  const collectionContexts = new Map<number, CollectionContext>();

  // Start upload workers in background FIRST (before enqueuing files!)
  // CRITICAL: Workers must be running before enqueuing, otherwise deadlock when queue fills
  let uploadPromise: Promise<void> | null = null;
  if (!options.dryRun && session) {
    uploadPromise = coordinator.processQueue(collectionContexts);
  }

  // Track files already enqueued from pending status (to avoid double-enqueueing during scan)
  const alreadyEnqueuedPaths = new Set<string>();

  // Pre-load existing pending files from database (from previous runs)
  if (!options.dryRun && session) {
    const existingPendingFiles = db.getFilesByStatus("pending");
    if (existingPendingFiles.length > 0) {
      logger.info(`📋 Found ${existingPendingFiles.length} pending files from previous run`);

      // Load collection contexts for existing files
      const masterKeyBytes = Buffer.from(session.masterKey, "base64");
      const collectionService = new CollectionService(
        client,
        db,
        session.token,
        masterKeyBytes
      );

      const seenCollections = new Set<number>();
      for (const file of existingPendingFiles) {
        if (!seenCollections.has(file.collection_id)) {
          const collection = db.getCollectionById(file.collection_id);
          if (collection) {
            // Get or create collection on Ente server
            const enteCollection = await collectionService.getOrCreateCollectionForDirectory(
              collection.directory_path
            );

            // Update database if collection wasn't created yet
            if (collection.ente_collection_id === null) {
              db.updateCollectionEnteID(collection.id, enteCollection.id);
            }

            // Add to collection contexts
            collectionContexts.set(collection.id, {
              collectionId: collection.id,
              enteCollectionId: enteCollection.id,
              collectionKey: enteCollection.key,
            });
            seenCollections.add(file.collection_id);
          }
        }
      }

      // Enqueue pending files for upload (workers are already running!)
      for (const file of existingPendingFiles) {
        await coordinator.enqueueFile(file);
        // Track that we already enqueued this file
        alreadyEnqueuedPaths.add(file.file_path);
      }

      logger.info(`   ✓ Enqueued ${existingPendingFiles.length} pending files for upload`);
    }
  }

  // Scanner: discover and enqueue files
  logger.info("📁 Scanning directories (streaming mode)...");
  let discoveredCount = 0;
  let supportedCount = 0;
  let skippedCount = 0;
  let lastScanProgress = 0;
  const masterKeyBytes = session
    ? Buffer.from(session.masterKey, "base64")
    : new Uint8Array(32);

  const collectionService = session
    ? new CollectionService(client, db, session.token, masterKeyBytes)
    : null;

  for (const path of paths) {
    // Check if we have a previous scan checkpoint
    const checkpoint = db.getScanCheckpoint(path);
    if (checkpoint && !checkpoint.scan_complete) {
      logger.info(`   Resuming scan from: ${checkpoint.last_scanned_path}`);
      logger.info(
        `   Previously discovered: ${checkpoint.files_discovered} files, ${checkpoint.directories_scanned} dirs`
      );
    } else {
      logger.info(`   Scanning: ${path}`);
    }

    for await (const file of scanDirectory(path, {
      onProgress: (progress) => {
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
      progressIntervalMs: 2000,
    })) {
      discoveredCount++;

      if (!isSupported(file.path)) {
        continue;
      }

      supportedCount++;

      // Check if file already in database
      const existingFile = db.getFileByPath(file.path);
      if (existingFile) {
        let shouldEnqueue = false;

        if (existingFile.file_mtime !== file.mtime) {
          // File modified since last scan - retry upload
          db.updateFileStatus(existingFile.id, "pending");
          shouldEnqueue = true;
        } else if (
          existingFile.status === "completed" ||
          existingFile.status === "skipped"
        ) {
          // Already uploaded or duplicate, skip
          skippedCount++;
          continue;
        } else if (existingFile.status === "pending") {
          // Check if already enqueued at startup
          if (alreadyEnqueuedPaths.has(file.path)) {
            // Already enqueued from pending files at startup, skip
            continue;
          }
          // Previously discovered but not yet uploaded
          shouldEnqueue = true;
        } else if (
          existingFile.status === "failed" ||
          existingFile.status === "in_progress"
        ) {
          // Retry failed or interrupted uploads
          db.updateFileStatus(existingFile.id, "pending");
          shouldEnqueue = true;
        }

        // Enqueue existing file for processing
        if (!options.dryRun && shouldEnqueue) {
          await coordinator.enqueueFile(existingFile);
        }
        continue;
      }

      // Get or create collection for this directory
      let collection = db.getCollectionByPath(file.directory);
      if (!collection) {
        const collectionName = basename(file.directory) || "root";
        const allCollections = db.getAllCollections();
        const existingRemote = allCollections.find((c) => {
          if (!c.ente_collection_id) return false;
          const baseName = c.collection_name.replace(/\s*\(\d+\)$/, "");
          return baseName === collectionName;
        });

        if (existingRemote) {
          db.updateCollectionPath(existingRemote.id, file.directory);
          collection = db.getCollectionById(existingRemote.id)!;
        } else {
          collection = db.createCollection(null, file.directory, collectionName);
        }
      }

      // Ensure collection exists on Ente (if not dry-run)
      if (
        !options.dryRun &&
        collection.ente_collection_id === null &&
        collectionService
      ) {
        const existingCollectionNames = new Set(
          db
            .getAllCollections()
            .filter((c) => c.ente_collection_id !== null)
            .map((c) => c.collection_name)
        );

        const collectionName = directoryToCollectionName(
          collection.directory_path,
          existingCollectionNames
        );

        const enteCollection =
          await collectionService.getOrCreateCollectionForDirectory(
            collection.directory_path
          );

        db.updateCollectionEnteID(collection.id, enteCollection.id);

        // Cache collection context
        collectionContexts.set(collection.id, {
          collectionId: collection.id,
          enteCollectionId: enteCollection.id,
          collectionKey: enteCollection.key,
        });

        logger.info(`   ✓ Created collection: ${collectionName}`);
      } else if (
        !options.dryRun &&
        collection.ente_collection_id !== null &&
        !collectionContexts.has(collection.id)
      ) {
        // Load collection context from server
        const enteCollection =
          await collectionService!.getOrCreateCollectionForDirectory(
            collection.directory_path
          );

        collectionContexts.set(collection.id, {
          collectionId: collection.id,
          enteCollectionId: collection.ente_collection_id,
          collectionKey: enteCollection.key,
        });
      }

      // Add file to database
      if (options.dryRun) {
        logger.info(`   [DRY RUN] Would add: ${file.path}`);
      } else {
        try {
          // Calculate hash to check for duplicates
          const hash = await calculateFileHash(file.path);
          const duplicateFile = db.getFileByHash(hash);

          if (duplicateFile) {
            logger.trace(`   ⏭️  Skipping duplicate: ${file.path}`);

            const fileRecord = db.createFile(
              file.path,
              collection.id,
              file.size,
              file.mtime
            );
            db.updateFileStatus(fileRecord.id, "skipped", "Duplicate file");
            db.setFileHash(fileRecord.id, hash);
            if (duplicateFile.ente_file_id) {
              db.setFileEnteID(fileRecord.id, duplicateFile.ente_file_id);
            }

            skippedCount++;
          } else {
            // New file - add to database and enqueue for upload
            const fileRecord = db.createFile(
              file.path,
              collection.id,
              file.size,
              file.mtime
            );
            db.setFileHash(fileRecord.id, hash);

            // Enqueue for upload (with backpressure)
            await coordinator.enqueueFile(fileRecord);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.warn(`   ⚠️  Failed to process file: ${file.path}`);
          logger.warn(`      Error: ${errorMessage}`);

          const fileRecord = db.createFile(
            file.path,
            collection.id,
            file.size,
            file.mtime
          );
          db.updateFileStatus(fileRecord.id, "failed", errorMessage);
        }
      }
    }

    // Mark scan as complete for this path
    if (!options.dryRun) {
      db.markScanComplete(path);
    }
  }

  // Signal that scanning is complete
  coordinator.markScanComplete();
  logger.info("✅ Scanning complete, waiting for uploads to finish...");

  // Wait for all uploads to complete
  if (uploadPromise) {
    await uploadPromise;
  }

  // Get final statistics
  const finalStats = coordinator.getStats();
  const currentDbStats = db.getFileStats();
  const totalCompleted = currentDbStats.byStatus?.completed?.count ?? 0;
  const totalSkipped = currentDbStats.byStatus?.skipped?.count ?? 0;
  const totalFailed = currentDbStats.byStatus?.failed?.count ?? 0;
  const totalPending = currentDbStats.byStatus?.pending?.count ?? 0;

  logger.info("\n📊 Final Statistics:");
  logger.info(`   This run: Scanned ${finalStats.filesScanned} files, uploaded ${finalStats.filesCompleted}`);
  logger.info(`   Database totals:`);
  logger.info(`     - Completed: ${totalCompleted} files`);
  logger.info(`     - Skipped: ${totalSkipped} files`);
  if (totalFailed > 0) {
    logger.info(`     - Failed: ${totalFailed} files`);
  }
  if (totalPending > 0) {
    logger.info(`     - Pending: ${totalPending} files`);
  }
  logger.info(`   Data uploaded this run: ${formatBytes(finalStats.bytesCompleted)}`);

  if (options.dryRun) {
    logger.info("✅ Dry run complete (no files uploaded)");
  } else if (finalStats.filesFailed > 0) {
    logger.warn(
      `⚠️  Upload complete with ${finalStats.filesFailed} failures`
    );
  } else {
    logger.info("✅ Upload complete!");
  }

  // Cleanup resources
  coordinator.cleanup();
  db.close();
}
