/**
 * Streaming upload pipeline with concurrent processing
 * Implements rsync-like strategy: scan and upload in parallel with backpressure
 */

import { logger } from "../utils/logger";
import type { APIClient } from "../api/client";
import type { DatabaseManager } from "../db";
import type { DiscoveredFile } from "../discovery/scanner";
import { uploadFile, type UploadOptions, type FileRecord } from "./pipeline";
import { uploadFileStreaming } from "./pipeline-streaming";

export interface StreamingUploadOptions {
  client: APIClient;
  authToken: string;
  masterKey: Uint8Array; // Master key for collection operations
  db: DatabaseManager;
  concurrency: number; // Number of parallel upload workers
  batchSize: number; // Files to process before checking backpressure
  maxQueueSize: number; // Maximum files in queue before pausing scan
  maxMemoryMB?: number; // Maximum memory budget for concurrent uploads (default: auto-detect)
}

export interface StreamingProgress {
  filesScanned: number;
  filesQueued: number;
  filesProcessing: number;
  filesCompleted: number;
  filesFailed: number;
  filesSkipped: number;
  bytesScanned: number;
  bytesCompleted: number;
}

export interface CollectionContext {
  collectionId: number;
  enteCollectionId: number;
  collectionKey: string;
}

/**
 * Streaming upload coordinator
 * Processes files as they are discovered, with backpressure control
 */
export class StreamingUploadCoordinator {
  private queue: FileRecord[] = [];
  private activeWorkers = 0;
  private scanComplete = false;
  private progress: StreamingProgress = {
    filesScanned: 0,
    filesQueued: 0,
    filesProcessing: 0,
    filesCompleted: 0,
    filesFailed: 0,
    filesSkipped: 0,
    bytesScanned: 0,
    bytesCompleted: 0,
  };

  // Callbacks
  private onProgress?: (progress: StreamingProgress) => void;
  private onFileComplete?: (file: FileRecord) => void;

  // Promise resolvers for coordination
  private queueSpaceAvailable?: () => void;
  private workAvailable?: () => void;

  // Progress reporting state
  private lastProgressReport = 0;
  private progressReportInterval = 1000; // Report at most once per second
  private pendingProgressReport = false;
  private pendingProgressTimer?: NodeJS.Timeout;

  // Memory management
  private maxMemoryBytes: number;
  private currentMemoryUsage = 0; // Estimated bytes in use by active uploads
  private filesInProgress = new Map<number, number>(); // fileId -> estimated memory usage
  private memoryAvailable?: () => void;

  constructor(
    private options: StreamingUploadOptions,
    callbacks?: {
      onProgress?: (progress: StreamingProgress) => void;
      onFileComplete?: (file: FileRecord) => void;
    }
  ) {
    this.onProgress = callbacks?.onProgress;
    this.onFileComplete = callbacks?.onFileComplete;

    // Set memory budget (default: 50% of available system memory, max 4GB)
    const totalMemoryMB = options.maxMemoryMB ?? Math.min(4096, Math.floor((require('os').totalmem() / 1024 / 1024) * 0.5));
    this.maxMemoryBytes = totalMemoryMB * 1024 * 1024;

    logger().info(`💾 Memory budget: ${totalMemoryMB}MB for concurrent uploads`);
  }

  /**
   * Add discovered file to processing queue
   * Blocks if queue is full (backpressure)
   */
  async enqueueFile(file: FileRecord): Promise<void> {
    // Wait if queue is full
    while (this.queue.length >= this.options.maxQueueSize) {
      await new Promise<void>((resolve) => {
        this.queueSpaceAvailable = resolve;
      });
    }

    this.queue.push(file);
    this.progress.filesQueued++;
    this.progress.filesScanned++;
    this.progress.bytesScanned += file.file_size;

    // Wake up waiting workers
    if (this.workAvailable) {
      this.workAvailable();
      this.workAvailable = undefined;
    }

    this.reportProgress();
  }

  /**
   * Signal that scanning is complete
   */
  markScanComplete(): void {
    this.scanComplete = true;

    // Wake up any waiting workers
    if (this.workAvailable) {
      this.workAvailable();
      this.workAvailable = undefined;
    }

    // Force a final progress report when scan completes
    this.forceProgressReport();
  }

  /**
   * Start upload workers
   * Returns when all files are processed
   */
  async processQueue(
    collectionContexts: Map<number, CollectionContext>
  ): Promise<void> {
    // Start worker pool
    const workers = Array.from({ length: this.options.concurrency }, (_, i) =>
      this.worker(i, collectionContexts)
    );

    // Wait for all workers to finish
    await Promise.all(workers);
  }

  /**
   * Worker that processes files from queue
   */
  private async worker(
    workerId: number,
    collectionContexts: Map<number, CollectionContext>
  ): Promise<void> {
    let filesProcessed = 0;

    while (true) {
      // Get next file from queue
      const fileRecord = this.queue.shift();

      if (fileRecord) {
        // Estimate memory needed based on upload strategy
        // Files >100MB use streaming upload (~40MB fixed memory)
        // Files <=100MB use buffered upload (~2.2× file size)
        const useStreaming = fileRecord.file_size > 100 * 1024 * 1024;
        const estimatedMemory = useStreaming
          ? 40 * 1024 * 1024  // Streaming: ~40MB fixed
          : Math.ceil(fileRecord.file_size * 2.2);  // Buffered: ~2.2× file size
        const fileSizeMB = Math.round(fileRecord.file_size / 1024 / 1024);

        // Warn about large files (>50MB)
        if (fileRecord.file_size > 50 * 1024 * 1024) {
          const mode = useStreaming ? "streaming" : "buffered";
          logger().warn(
            `⚠️  Large file detected (${fileSizeMB}MB, ${mode} mode): ${fileRecord.file_path}`
          );
        }

        // Check if file is too large for memory budget (even when empty)
        if (estimatedMemory > this.maxMemoryBytes) {
          const requiredMB = Math.round(estimatedMemory / 1024 / 1024);
          const budgetMB = Math.round(this.maxMemoryBytes / 1024 / 1024);

          logger().error(
            `❌ File too large for memory budget (needs ${requiredMB}MB, budget ${budgetMB}MB): ${fileRecord.file_path}`
          );
          logger().error(
            `   Options: 1) Increase budget with --max-memory-mb ${requiredMB + 500}`
          );
          logger().error(
            `            2) Process this file separately with higher budget`
          );
          logger().error(
            `            3) Skip this file (will be marked as failed)`
          );

          // Mark file as failed to prevent deadlock
          this.options.db.updateFileStatus(
            fileRecord.id,
            "failed",
            `File size (${fileSizeMB}MB) exceeds memory budget (${budgetMB}MB). Increase --max-memory-mb to at least ${requiredMB}MB`
          );
          this.progress.filesFailed++;
          this.reportProgress();

          // Continue to next file
          continue;
        }

        // Wait for memory budget to be available
        let waitCount = 0;
        while (this.currentMemoryUsage + estimatedMemory > this.maxMemoryBytes) {
          if (waitCount === 0) {
            logger().warn(
              `⏸️  Worker ${workerId}: Waiting for memory (need ${Math.round(estimatedMemory / 1024 / 1024)}MB, ` +
              `using ${Math.round(this.currentMemoryUsage / 1024 / 1024)}MB / ${Math.round(this.maxMemoryBytes / 1024 / 1024)}MB)`
            );
          }
          waitCount++;

          // Every 30 seconds, log that we're still waiting
          if (waitCount % 30 === 0) {
            logger().info(
              `   Still waiting for memory... (${waitCount}s elapsed, processing: ${this.filesInProgress.size} files)`
            );
          }

          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1000); // Check every second
            const oldResolve = this.memoryAvailable;
            this.memoryAvailable = () => {
              if (oldResolve) oldResolve();
              resolve();
            };
          });
        }

        // Reserve memory for this file
        this.currentMemoryUsage += estimatedMemory;
        this.filesInProgress.set(fileRecord.id, estimatedMemory);

        // Process file
        this.activeWorkers++;
        this.progress.filesQueued--;
        this.progress.filesProcessing++;
        this.reportProgress();

        // Log large file processing
        if (fileRecord.file_size > 50 * 1024 * 1024) {
          logger().info(
            `📤 Processing large file (${fileSizeMB}MB, ~${Math.round(estimatedMemory / 1024 / 1024)}MB memory): ${fileRecord.file_path}`
          );
        }

        try {
          await this.processFile(fileRecord, collectionContexts);
          filesProcessed++;

          // Log large file completion
          if (fileRecord.file_size > 50 * 1024 * 1024) {
            logger().info(
              `✅ Completed large file (${fileSizeMB}MB): ${fileRecord.file_path}`
            );
          }

          // Suggest garbage collection every 10 files per worker to manage memory
          if (filesProcessed % 10 === 0 && global.gc) {
            global.gc();
          }
        } catch (error) {
          logger().error(
            { error },
            `Worker ${workerId}: Unexpected error processing ${fileRecord.file_path}`
          );
          this.progress.filesFailed++;

          // Log large file failure
          if (fileRecord.file_size > 50 * 1024 * 1024) {
            logger().error(
              `❌ Failed large file (${fileSizeMB}MB): ${fileRecord.file_path}`
            );
          }
        } finally {
          // Release memory reservation
          const memUsed = this.filesInProgress.get(fileRecord.id);
          if (memUsed) {
            this.currentMemoryUsage -= memUsed;
            this.filesInProgress.delete(fileRecord.id);
          }

          // Signal memory available to waiting workers
          if (this.memoryAvailable) {
            this.memoryAvailable();
            this.memoryAvailable = undefined;
          }
        }

        this.activeWorkers--;
        this.progress.filesProcessing--;
        this.reportProgress();

        // Signal queue space available
        if (this.queueSpaceAvailable) {
          this.queueSpaceAvailable();
          this.queueSpaceAvailable = undefined;
        }
      } else if (this.scanComplete) {
        // No more work and scan is done
        break;
      } else {
        // Wait for more work
        await new Promise<void>((resolve) => {
          this.workAvailable = resolve;
        });
      }
    }
  }

  /**
   * Process a single file
   */
  private async processFile(
    fileRecord: FileRecord,
    collectionContexts: Map<number, CollectionContext>
  ): Promise<void> {
    // Get collection context
    let context = collectionContexts.get(fileRecord.collection_id);

    // If context is missing, try to recreate it on-the-fly (fallback for edge cases)
    if (!context) {
      logger().warn(
        `Missing collection context for file ${fileRecord.file_path}, attempting to recreate...`
      );

      try {
        const collection = this.options.db.getCollectionById(fileRecord.collection_id);
        if (!collection) {
          throw new Error(`Collection ${fileRecord.collection_id} not found in database`);
        }

        // Recreate collection context on-the-fly
        const { CollectionService } = await import("../collections/service");
        const collectionService = new CollectionService(
          this.options.client,
          this.options.db,
          this.options.authToken,
          this.options.masterKey
        );

        const enteCollection = await collectionService.getOrCreateCollectionForDirectory(
          collection.directory_path
        );

        // Update database if needed
        if (collection.ente_collection_id === null) {
          this.options.db.updateCollectionEnteID(collection.id, enteCollection.id);
        }

        // Create and cache the context
        context = {
          collectionId: collection.id,
          enteCollectionId: enteCollection.id,
          collectionKey: enteCollection.key,
        };
        collectionContexts.set(collection.id, context);

        logger().info(`✓ Recreated collection context for: ${collection.collection_name}`);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger().error(
          `Failed to recreate collection context: ${errorMessage}`
        );
        this.options.db.updateFileStatus(
          fileRecord.id,
          "failed",
          `Collection context missing: ${errorMessage}`
        );
        this.progress.filesFailed++;
        return;
      }
    }

    // Choose upload strategy based on file size
    // Use streaming upload for files >100MB to reduce memory usage
    const useStreaming = fileRecord.file_size > 100 * 1024 * 1024;

    let result;
    if (useStreaming) {
      logger().debug(`Using streaming upload for large file (${Math.round(fileRecord.file_size / 1024 / 1024)}MB)`);
      result = await uploadFileStreaming(
        fileRecord,
        {
          client: this.options.client,
          authToken: this.options.authToken,
          collectionID: context.enteCollectionId,
          collectionKey: context.collectionKey,
        },
        this.options.db
      );
    } else {
      // Use normal upload for smaller files (faster)
      const uploadOptions: UploadOptions = {
        client: this.options.client,
        authToken: this.options.authToken,
        collectionID: context.enteCollectionId,
        collectionKey: context.collectionKey,
      };
      result = await uploadFile(fileRecord, uploadOptions, this.options.db);
    }

    // Update progress
    if (result.success) {
      const updatedRecord = this.options.db.getFileById(fileRecord.id);
      if (updatedRecord?.status === "skipped") {
        this.progress.filesSkipped++;
      } else {
        this.progress.filesCompleted++;
        this.progress.bytesCompleted += fileRecord.file_size;
      }
    } else {
      this.progress.filesFailed++;
    }

    // Callback
    if (this.onFileComplete) {
      this.onFileComplete(fileRecord);
    }

    this.reportProgress();
  }

  /**
   * Report current progress (debounced to avoid spam)
   */
  private reportProgress(): void {
    if (!this.onProgress) return;

    const now = Date.now();
    const timeSinceLastReport = now - this.lastProgressReport;

    if (timeSinceLastReport >= this.progressReportInterval) {
      // Enough time has passed, report immediately
      this.onProgress({ ...this.progress });
      this.lastProgressReport = now;
      this.pendingProgressReport = false;

      // Clear any pending timer
      if (this.pendingProgressTimer) {
        clearTimeout(this.pendingProgressTimer);
        this.pendingProgressTimer = undefined;
      }
    } else if (!this.pendingProgressReport) {
      // Schedule a delayed report
      this.pendingProgressReport = true;
      const delay = this.progressReportInterval - timeSinceLastReport;

      // Clear any existing timer first
      if (this.pendingProgressTimer) {
        clearTimeout(this.pendingProgressTimer);
      }

      this.pendingProgressTimer = setTimeout(() => {
        if (this.pendingProgressReport) {
          this.onProgress!({ ...this.progress });
          this.lastProgressReport = Date.now();
          this.pendingProgressReport = false;
          this.pendingProgressTimer = undefined;
        }
      }, delay);
    }
    // else: a report is already pending, do nothing
  }

  /**
   * Force an immediate progress report (bypasses debouncing)
   */
  private forceProgressReport(): void {
    if (this.onProgress) {
      this.onProgress({ ...this.progress });
      this.lastProgressReport = Date.now();
      this.pendingProgressReport = false;

      // Clear any pending timer
      if (this.pendingProgressTimer) {
        clearTimeout(this.pendingProgressTimer);
        this.pendingProgressTimer = undefined;
      }
    }
  }

  /**
   * Get final statistics
   */
  getStats(): StreamingProgress {
    return { ...this.progress };
  }

  /**
   * Cleanup resources (clear pending timers)
   */
  cleanup(): void {
    if (this.pendingProgressTimer) {
      clearTimeout(this.pendingProgressTimer);
      this.pendingProgressTimer = undefined;
    }
  }
}
