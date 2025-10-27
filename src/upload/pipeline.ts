/**
 * Upload pipeline orchestration
 * Coordinates the entire upload flow from local file to Ente server
 */

import { logger } from "../utils/logger";
import type { APIClient } from "../api/client";
import type { DatabaseManager } from "../db";
import { extractMetadata } from "./metadata";
import { calculateFileHash } from "./hash";
import { generateThumbnail } from "./thumbnail";
import { encryptFilePieces } from "./encryption";
import { uploadToS3, uploadToS3Resumable, fetchUploadURLs } from "./s3";
import { finalizeUpload, buildPostFileRequest } from "./finalize";
import type { EnteFile } from "./finalize";

export interface UploadOptions {
  client: APIClient;
  authToken: string;
  collectionID: number;
  collectionKey: string; // base64
}

export interface FileRecord {
  id: number;
  file_path: string;
  collection_id: number;
  file_size: number;
  file_mtime: number;
  status: string;
}

export interface UploadResult {
  success: boolean;
  enteFile?: EnteFile;
  error?: string;
}

/**
 * Upload a single file through the entire pipeline
 */
export async function uploadFile(
  fileRecord: FileRecord,
  options: UploadOptions,
  db: DatabaseManager
): Promise<UploadResult> {
  const { client, authToken, collectionID, collectionKey } = options;
  const filePath = fileRecord.file_path;
  let currentStep = "initialization";

  try {
    logger().debug(`📤 Uploading: ${filePath}`);

    // Mark as in progress
    db.updateFileStatus(fileRecord.id, "in_progress", undefined);

    // Step 1: Extract metadata
    currentStep = "extracting metadata";
    logger().debug(`  📝 Extracting metadata...`);
    const metadata = await extractMetadata(filePath, fileRecord.file_mtime);

    // Step 2: Calculate hash
    currentStep = "calculating hash";
    logger().debug(`  🔢 Calculating hash...`);
    const hash = await calculateFileHash(filePath);
    metadata.hash = hash;

    // Save hash immediately to prevent race conditions with duplicate uploads
    db.setFileHash(fileRecord.id, hash);

    // Step 2.5: Check for duplicates
    const existingFile = db.getFileByHash(hash);
    if (existingFile && existingFile.id !== fileRecord.id) {
      logger().debug(`  ⏭️  Duplicate detected (matches file ID: ${existingFile.ente_file_id})`);
      logger().debug(`  ℹ️  Original: ${existingFile.file_path}`);

      // Mark this file as skipped and link to existing Ente file
      db.updateFileStatus(fileRecord.id, "skipped", "Duplicate file");
      if (existingFile.ente_file_id) {
        db.setFileEnteID(fileRecord.id, existingFile.ente_file_id);
      }

      return {
        success: true,
        enteFile: undefined, // Duplicate - no new EnteFile created
      };
    }

    // Step 3: Generate thumbnail
    currentStep = "generating thumbnail";
    logger().debug(`  🖼️  Generating thumbnail...`);
    const thumbnailData = await generateThumbnail(filePath);

    // Step 4: Encrypt file, thumbnail, and metadata
    currentStep = "encrypting file data";
    logger().debug(`  🔐 Encrypting...`);
    const { encryptedPieces, encryptedFileKey } = await encryptFilePieces(
      filePath,
      thumbnailData,
      metadata,
      collectionKey
    );

    // Step 5: Upload file to S3 (with resume support for large files)
    currentStep = "uploading file to S3";
    logger().debug(`  ☁️  Uploading file to S3...`);
    const fileUploadResult = await uploadToS3Resumable(
      client,
      authToken,
      encryptedPieces.file.encryptedData,
      fileRecord.id,
      db
    );

    // Step 6: Upload thumbnail to S3 (thumbnails are small, no resume needed)
    currentStep = "uploading thumbnail to S3";
    logger().debug(`  ☁️  Uploading thumbnail to S3...`);
    const thumbnailUploadResult = await uploadToS3(
      client,
      authToken,
      encryptedPieces.thumbnail.encryptedData
    );

    // Step 7: Build finalization request
    currentStep = "finalizing upload";
    const postFileRequest = buildPostFileRequest(
      collectionID,
      encryptedFileKey,
      {
        objectKey: fileUploadResult.objectKey,
        decryptionHeader: encryptedPieces.file.decryptionHeader,
        size: fileUploadResult.size,
      },
      {
        objectKey: thumbnailUploadResult.objectKey,
        decryptionHeader: encryptedPieces.thumbnail.decryptionHeader,
        size: thumbnailUploadResult.size,
      },
      encryptedPieces.metadata,
      encryptedPieces.pubMagicMetadata
    );

    // Step 8: Finalize upload on Museum
    logger().debug(`  ✅ Finalizing upload...`);
    const enteFile = await finalizeUpload(client, authToken, postFileRequest);

    // Update database
    db.updateFileStatus(fileRecord.id, "completed", undefined);
    db.setFileEnteID(fileRecord.id, enteFile.id);
    // Hash already saved earlier (after calculation) to prevent race conditions

    logger().debug(`  ✅ Upload complete! Ente file ID: ${enteFile.id}`);

    return {
      success: true,
      enteFile,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger().error(`  ❌ Upload failed while ${currentStep}: ${errorMessage}`);

    // Update database with error (but keep upload parts for resume)
    const fullErrorMessage = `Failed while ${currentStep}: ${errorMessage}`;
    db.updateFileStatus(fileRecord.id, "failed", fullErrorMessage);

    // Note: We intentionally keep upload_parts records so the upload can be resumed
    // They will be automatically cleaned up after 24 hours by cleanupStaleUploadParts()

    return {
      success: false,
      error: fullErrorMessage,
    };
  }
}

/**
 * Upload multiple files sequentially
 */
export async function uploadFiles(
  fileRecords: FileRecord[],
  options: UploadOptions,
  db: DatabaseManager,
  onFileComplete?: (file: FileRecord) => void
): Promise<{
  successful: number;
  failed: number;
  skipped: number;
  results: UploadResult[];
}> {
  let successful = 0;
  let failed = 0;
  let skipped = 0;
  const results: UploadResult[] = [];

  for (const fileRecord of fileRecords) {
    const result = await uploadFile(fileRecord, options, db);
    results.push(result);

    if (result.success) {
      // Check if it was skipped (duplicate)
      const updatedRecord = db.getFileById(fileRecord.id);
      if (updatedRecord?.status === "skipped") {
        skipped++;
      } else {
        successful++;
      }
    } else {
      failed++;
    }

    // Call progress callback after each file
    if (onFileComplete) {
      onFileComplete(fileRecord);
    }
  }

  return { successful, failed, skipped, results };
}
