/**
 * Sync service for fetching existing files from Ente server
 * This enables duplicate detection even when local database is empty
 */

import { logger } from "../utils/logger";
import type { APIClient } from "../api/client";
import type { DatabaseManager } from "../db";
import type { DecryptedCollection } from "../collections/types";
import { decryptBox, decryptStream, fromBase64 } from "../crypto/encryption";
import type {
  EnteFile,
  CollectionDiffResponse,
  DecryptedFileMetadata,
} from "./types";

export class SyncService {
  constructor(
    private client: APIClient,
    private db: DatabaseManager,
    private authToken: string,
    private masterKey: Uint8Array
  ) {}

  /**
   * Fetch all files from a collection
   */
  async fetchCollectionFiles(
    collectionID: number,
    collectionKey: string
  ): Promise<EnteFile[]> {
    const allFiles: EnteFile[] = [];
    let sinceTime = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.get<CollectionDiffResponse>(
        `/collections/v2/diff`,
        {
          headers: {
            "X-Auth-Token": this.authToken,
          },
          query: {
            collectionID: collectionID.toString(),
            sinceTime: sinceTime.toString(),
          },
        }
      );

      allFiles.push(...response.diff.filter((f) => !f.isDeleted));
      hasMore = response.hasMore;

      if (hasMore && response.diff.length > 0) {
        // Update sinceTime to the last file's updationTime
        sinceTime = Math.max(...response.diff.map((f) => f.updationTime));
      }
    }

    return allFiles;
  }

  /**
   * Decrypt file metadata to extract hash
   */
  async decryptFileMetadata(
    file: EnteFile,
    collectionKey: string
  ): Promise<DecryptedFileMetadata | null> {
    try {
      // Step 1: Decrypt file key using collection key
      const collectionKeyBytes = await fromBase64(collectionKey);
      const fileKey = await decryptBox(
        file.encryptedKey,
        file.keyDecryptionNonce,
        collectionKeyBytes
      );

      // Step 2: Decrypt metadata using file key (streaming encryption)
      const metadataBytes = await decryptStream(
        file.metadata.encryptedData,
        file.metadata.decryptionHeader,
        fileKey
      );

      // Step 3: Parse JSON metadata
      const metadataString = new TextDecoder().decode(metadataBytes);
      const metadata = JSON.parse(metadataString) as DecryptedFileMetadata;

      return metadata;
    } catch (error) {
      // Log the error for debugging
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger().info(`   Metadata decrypt error for file ${file.id}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Sync all files from Ente server to local database
   * This populates the hash cache for duplicate detection
   */
  async syncAllFiles(
    collections: DecryptedCollection[]
  ): Promise<{ synced: number; errors: number }> {
    let synced = 0;
    let errors = 0;

    logger().info(`📥 Syncing existing files from Ente server...`);

    for (const collection of collections) {
      try {
        logger().info(`   Fetching files from "${collection.name}"...`);

        // Ensure collection exists in local database
        let localCollection = this.db
          .getAllCollections()
          .find((c) => c.ente_collection_id === collection.id);

        if (!localCollection) {
          // Create local collection record for this remote collection
          localCollection = this.db.createCollection(
            collection.id,
            `<remote:${collection.id}>`, // Placeholder directory path
            collection.name
          );
        }

        // Fetch all files in this collection
        const files = await this.fetchCollectionFiles(
          collection.id,
          collection.key
        );

        if (files.length === 0) {
          logger().info(`   No files found in "${collection.name}"`);
          continue;
        }

        logger().info(`   Processing ${files.length} files...`);

        // Process each file
        for (const file of files) {
          try {
            // Decrypt metadata to get hash
            const metadata = await this.decryptFileMetadata(
              file,
              collection.key
            );

            if (!metadata) {
              logger().info(`   Skipping file ${file.id}: metadata decryption failed`);
              continue;
            }

            if (!metadata.hash) {
              logger().info(`   Skipping file ${file.id}: no hash in metadata`);
              continue;
            }

            // Check if file already in database
            const existingFile = this.db.getFileByEnteID(file.id);

            if (existingFile) {
              // Update hash if missing
              if (!existingFile.file_hash) {
                this.db.setFileHash(existingFile.id, metadata.hash);
                synced++;
              }
            } else {
              // Create a synthetic file record for server-side files
              // This allows duplicate detection to work
              const fileRecord = this.db.createFile(
                `<remote:${file.id}>`, // Placeholder path
                localCollection.id,
                0, // Size unknown
                metadata.creationTime || 0
              );

              // Mark as completed and set Ente file ID
              this.db.updateFileStatus(fileRecord.id, "completed", undefined);
              this.db.setFileEnteID(fileRecord.id, file.id);
              this.db.setFileHash(fileRecord.id, metadata.hash);

              synced++;
            }
          } catch (error) {
            logger().warn({ error }, `   Failed to process file ${file.id}:`);
            errors++;
          }
        }

        logger().info(`   ✓ Synced ${files.length} files from "${collection.name}"`);
      } catch (error) {
        logger().error({ error }, `   ✗ Failed to sync collection "${collection.name}":`);
        errors++;
      }
    }

    return { synced, errors };
  }
}
