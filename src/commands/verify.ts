/**
 * Verify command - detect duplicates on Ente server
 * Fetches all files from Ente and checks for duplicate hashes
 */

import { logger } from "../utils/logger";
import { APIClient } from "../api/client";
import { SyncService } from "../sync/service";
import { DatabaseManager, getDefaultDatabasePath } from "../db";
import { AuthenticationService, SessionStorage } from "../auth/service";
import { CollectionService } from "../collections/service";
import type { EnteFile, DecryptedFileMetadata } from "../sync/types";

interface VerifyOptions {
  email?: string;
  password?: string;
  apiServer: string;
  logLevel: string;
  fix?: boolean; // Auto-delete duplicates
  yes?: boolean; // Skip confirmation prompt
}

interface DuplicateGroup {
  hash: string;
  files: Array<{
    id: number;
    collectionID: number;
    collectionName: string;
    title: string;
    size?: number;
  }>;
}

export async function verifyCommand(options: VerifyOptions) {
  const log = logger();

  log.info("🔍 Ente Duplicate Verification");
  log.info("================================");

  // Validate authentication
  if (!options.email || !options.password) {
    log.error("❌ Email and password are required");
    log.error("   Provide via --email and --password, or ENTE_EMAIL and ENTE_PASSWORD env vars");
    process.exit(1);
  }

  try {
    // Initialize API client
    log.debug(`Using API server: ${options.apiServer}`);
    const client = new APIClient({
      baseURL: options.apiServer,
      logger: log,
    });

    // Initialize database
    const dbPath = getDefaultDatabasePath();
    const db = new DatabaseManager(dbPath);

    const authService = new AuthenticationService(client);

    // Try to load existing session
    let session = SessionStorage.load(db);

    // Authenticate if no valid session
    if (!session) {
      if (!options.password) {
        log.error("❌ Password required for first-time authentication");
        process.exit(1);
      }

      log.info(`🔐 Authenticating as ${options.email}...`);
      log.debug(`API server: ${options.apiServer}`);

      try {
        const { token, masterKey, userId } = await authService.login(
          options.email,
          options.password
        );

        session = {
          email: options.email!,
          token,
          userId,
          masterKey: Buffer.from(masterKey).toString("base64"),
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        };

        SessionStorage.save(db, session);
        log.info("✅ Authentication successful");
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`❌ Authentication failed: ${errorMsg}`);

        if (errorMsg.includes("404")) {
          log.error("");
          log.error("💡 Possible issues:");
          log.error("   - API server URL is incorrect");
          log.error("   - Current API server: " + options.apiServer);
          log.error("   - Try: export ENTE_API_SERVER=https://api.ente.io");
          log.error("   - Or use: --api-server https://api.ente.io");
        }

        process.exit(1);
      }
    } else {
      log.info(`✅ Using cached session for ${session.email}`);
    }

    const masterKeyBytes = Buffer.from(session.masterKey, "base64");

    // Initialize services
    const syncService = new SyncService(
      client,
      db,
      session.token,
      masterKeyBytes
    );

    const collectionService = new CollectionService(
      client,
      db,
      session.token,
      masterKeyBytes
    );

    // Fetch all collections
    log.info("📚 Fetching collections...");
    const collections = await collectionService.fetchCollections();

    log.info(`   ✓ Found ${collections.length} collections`);

    // Track files by hash
    const filesByHash = new Map<string, DuplicateGroup["files"]>();
    let totalFiles = 0;
    let filesWithHash = 0;
    let filesWithoutHash = 0;
    let decryptErrors = 0;

    // Fetch and process files from each collection
    log.info("📥 Fetching files from Ente server...");

    for (const collection of collections) {
      // Get collection key from the decrypted collection
      const collectionKey = collection.key;

      log.info(`   Processing: ${collection.name} (ID: ${collection.id})`);

      const files = await syncService.fetchCollectionFiles(
        collection.id,
        collectionKey
      );

      log.info(`      Found ${files.length} files`);

      // Decrypt metadata and extract hashes
      for (const file of files) {
        totalFiles++;

        const metadata = await syncService.decryptFileMetadata(
          file,
          collectionKey
        );

        if (!metadata) {
          decryptErrors++;
          continue;
        }

        // Extract hash (handle legacy formats)
        const hash = extractHash(metadata);

        if (!hash) {
          filesWithoutHash++;
          continue;
        }

        filesWithHash++;

        // Track file by hash
        if (!filesByHash.has(hash)) {
          filesByHash.set(hash, []);
        }

        filesByHash.get(hash)!.push({
          id: file.id,
          collectionID: collection.id,
          collectionName: collection.name,
          title: metadata.title || `file_${file.id}`,
          size: metadata.fileSize,
        });
      }
    }

    // Analyze for duplicates
    log.info("");
    log.info("📊 Analysis Results");
    log.info("===================");
    log.info(`Total files scanned:        ${totalFiles}`);
    log.info(`Files with hash:            ${filesWithHash}`);
    log.info(`Files without hash:         ${filesWithoutHash}`);
    log.info(`Decryption errors:          ${decryptErrors}`);
    log.info(`Unique hashes:              ${filesByHash.size}`);

    // Find duplicates
    const duplicates: DuplicateGroup[] = [];
    let duplicateFileCount = 0;

    for (const [hash, files] of filesByHash.entries()) {
      if (files.length > 1) {
        duplicates.push({ hash, files });
        duplicateFileCount += files.length - 1; // Count extras only
      }
    }

    log.info(`Duplicate hashes found:     ${duplicates.length}`);
    log.info(`Duplicate files (extras):   ${duplicateFileCount}`);

    if (duplicates.length === 0) {
      log.info("");
      log.info("✅ No duplicates found! All files are unique.");
      return;
    }

    // Display duplicates
    log.info("");
    log.info("🔍 Duplicate Files");
    log.info("==================");

    // Sort by number of duplicates (highest first)
    duplicates.sort((a, b) => b.files.length - a.files.length);

    for (let i = 0; i < Math.min(duplicates.length, 50); i++) {
      const dup = duplicates[i];
      log.info("");
      log.info(`Hash: ${dup.hash.substring(0, 16)}... (${dup.files.length} copies)`);

      for (const file of dup.files) {
        const sizeStr = file.size
          ? ` (${Math.round(file.size / 1024 / 1024)}MB)`
          : "";
        log.info(
          `  - ID ${file.id}: ${file.title}${sizeStr} [${file.collectionName}]`
        );
      }
    }

    if (duplicates.length > 50) {
      log.info("");
      log.info(`... and ${duplicates.length - 50} more duplicate groups`);
    }

    // Summary
    log.info("");
    log.info("💡 Summary");
    log.info("==========");

    const totalDuplicateBytes = duplicates.reduce((total, dup) => {
      // Count size of extras only (keep first, delete rest)
      const extras = dup.files.slice(1);
      return (
        total + extras.reduce((sum, f) => sum + (f.size || 0), 0)
      );
    }, 0);

    const totalDuplicateMB = Math.round(totalDuplicateBytes / 1024 / 1024);

    log.info(`Wasted storage: ~${totalDuplicateMB}MB from ${duplicateFileCount} duplicate files`);

    // Handle automatic deletion
    if (options.fix) {
      log.info("");
      log.info("🗑️  Automatic Deletion");
      log.info("====================");
      log.info(`Files to delete: ${duplicateFileCount} (keeping oldest copy of each)`);
      log.info(`Storage to reclaim: ~${totalDuplicateMB}MB`);
      log.info("");

      // Get confirmation unless --yes flag is provided
      if (!options.yes) {
        log.warn("⚠️  This will PERMANENTLY delete duplicate files from Ente!");
        log.warn("⚠️  You cannot undo this operation!");
        log.info("");
        log.info("To proceed, run with --yes flag:");
        log.info(`   bun run src/index.ts verify --fix --yes`);
        log.info("");
        log.info("Or manually review and delete via Ente web UI");
        return;
      }

      // Delete duplicates (keep first/oldest, delete rest)
      log.info("🗑️  Deleting duplicates...");
      let deletedCount = 0;
      let failedCount = 0;

      for (const dup of duplicates) {
        // Keep first file (oldest), delete rest
        const filesToDelete = dup.files.slice(1);

        for (const file of filesToDelete) {
          try {
            log.debug(`   Deleting file ${file.id}: ${file.title}`);

            await client.post(
              `/trash/delete`,
              {
                fileIDs: [file.id],
              },
              {
                headers: {
                  "X-Auth-Token": session.token,
                },
              }
            );

            deletedCount++;

            if (deletedCount % 100 === 0) {
              log.info(`   Deleted ${deletedCount}/${duplicateFileCount} files...`);
            }
          } catch (error) {
            failedCount++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error(`   Failed to delete file ${file.id}: ${errorMsg}`);
          }
        }
      }

      log.info("");
      log.info("✅ Deletion Complete");
      log.info("===================");
      log.info(`Successfully deleted: ${deletedCount} files`);
      if (failedCount > 0) {
        log.warn(`Failed to delete: ${failedCount} files`);
      }
      log.info(`Storage reclaimed: ~${Math.round((deletedCount / duplicateFileCount) * totalDuplicateMB)}MB`);
      log.info("");
      log.info("💡 Note: Deleted files are moved to trash");
      log.info("   Permanently delete from trash via Ente web UI to free storage");
    } else {
      log.info("");
      log.info("⚠️  To remove duplicates:");
      log.info("   1. Run with --fix flag: bun run src/index.ts verify --fix --yes");
      log.info("   2. Or manually delete via Ente web UI");
    }

    // Write detailed report
    const reportPath = `${process.env.HOME}/.entoder/duplicate-report.json`;
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalFiles,
        filesWithHash,
        filesWithoutHash,
        decryptErrors,
        uniqueHashes: filesByHash.size,
        duplicateGroups: duplicates.length,
        duplicateFiles: duplicateFileCount,
        wastedStorageBytes: totalDuplicateBytes,
        wastedStorageMB: totalDuplicateMB,
      },
      duplicates: duplicates.map((dup) => ({
        hash: dup.hash,
        count: dup.files.length,
        files: dup.files,
      })),
    };

    await Bun.write(reportPath, JSON.stringify(report, null, 2));
    log.info("");
    log.info(`📄 Detailed report saved to: ${reportPath}`);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log.error(`❌ Verification failed: ${errorMessage}`);

    if (errorMessage.includes("404")) {
      log.error("");
      log.error("💡 Possible issues:");
      log.error("   - API server URL is incorrect");
      log.error("   - Current API server: " + options.apiServer);
      log.error("   - Try: export ENTE_API_SERVER=https://api.ente.io");
      log.error("   - Or use: --api-server https://api.ente.io");
    }

    if (error instanceof Error && error.stack) {
      log.debug(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Extract hash from file metadata (handles legacy formats)
 */
function extractHash(metadata: DecryptedFileMetadata): string | null {
  // Modern format: single hash field
  if (metadata.hash) {
    return metadata.hash;
  }

  // Legacy format: separate image/video hashes for live photos
  if (metadata.imageHash && metadata.videoHash) {
    return `${metadata.imageHash}:${metadata.videoHash}`;
  }

  // Very old files might not have hash
  return null;
}
