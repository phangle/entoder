/**
 * Streaming upload pipeline for large files
 * Memory-efficient: only buffers ~20-40MB at a time regardless of file size
 */

import { logger } from "../utils/logger";
import type { APIClient } from "../api/client";
import type { DatabaseManager } from "../db";
import { extractMetadata } from "./metadata";
import { calculateFileHash } from "./hash";
import { generateThumbnail } from "./thumbnail";
import {
  encryptFileStreamGenerator,
  encryptThumbnail,
  encryptMetadata,
  generateFileKey,
  encryptFileKey
} from "./encryption";
import { fromBase64 } from "../crypto/encryption";
import {
  fetchMultipartUploadURLs,
  putFilePart,
  completeMultipartUpload,
  fetchUploadURLs,
  putFile,
  type MultipartCompletedPart
} from "./s3";
import { finalizeUpload, buildPostFileRequest } from "./finalize";
import type { EnteFile } from "./finalize";
import type { FileRecord, UploadResult } from "./pipeline";
import { createPublicMagicMetadata, encryptPublicMagicMetadata } from "./magic-metadata";

const MULTIPART_CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per S3 part

/**
 * Upload large file using streaming encryption + multipart upload
 * Memory usage: ~40MB regardless of file size (2× MULTIPART_CHUNK_SIZE)
 */
export async function uploadFileStreaming(
  fileRecord: FileRecord,
  options: {
    client: APIClient;
    authToken: string;
    collectionID: number;
    collectionKey: string;
  },
  db: DatabaseManager
): Promise<UploadResult> {
  const { client, authToken, collectionID, collectionKey } = options;
  const filePath = fileRecord.file_path;
  const fileSizeMB = Math.round(fileRecord.file_size / 1024 / 1024);

  try {
    logger().info(`📤 Streaming upload: ${filePath} (${fileSizeMB}MB)`);

    // Mark as in progress
    db.updateFileStatus(fileRecord.id, "in_progress", undefined);

    // Step 1: Extract metadata
    logger().debug(`  📝 Extracting metadata...`);
    const metadata = await extractMetadata(filePath, fileRecord.file_mtime);

    // Step 2: Calculate hash
    logger().debug(`  🔢 Calculating hash...`);
    const hash = await calculateFileHash(filePath);
    metadata.hash = hash;

    // Save hash immediately to prevent race conditions with duplicate uploads
    db.setFileHash(fileRecord.id, hash);

    // Step 2.5: Check for duplicates
    const existingFile = db.getFileByHash(hash);
    if (existingFile && existingFile.id !== fileRecord.id) {
      logger().debug(`  ⏭️  Duplicate detected (matches file ${existingFile.id})`);
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
    logger().debug(`  🖼️  Generating thumbnail...`);
    const thumbnailData = await generateThumbnail(filePath);

    // Step 4: Generate file key
    logger().debug(`  🔐 Generating encryption keys...`);
    const fileKey = await generateFileKey();

    // Step 5: Encrypt thumbnail (small, can keep in memory)
    const encryptedThumbnail = await encryptThumbnail(thumbnailData, fileKey);

    // Step 6: Encrypt metadata
    const encryptedMetadata = await encryptMetadata(metadata, fileKey);

    // Step 7: Create and encrypt public magic metadata
    const pubMagicMetadataData = createPublicMagicMetadata(metadata);
    const encryptedPubMagicMetadata = await encryptPublicMagicMetadata(
      pubMagicMetadataData,
      fileKey
    );

    // Step 8: Upload file using streaming encryption
    logger().debug(`  ☁️  Streaming upload to S3...`);
    const fileUploadResult = await uploadFileStreamingToS3(
      filePath,
      fileKey,
      fileRecord.id,
      client,
      authToken,
      db
    );

    // Step 9: Upload thumbnail (small, normal upload)
    logger().debug(`  ☁️  Uploading thumbnail...`);
    const thumbnailURLs = await fetchUploadURLs(client, authToken, 1);
    await putFile(thumbnailURLs[0].url, encryptedThumbnail.encryptedData);

    // Step 10: Encrypt file key with collection key
    const collectionKeyBytes = await fromBase64(collectionKey);
    const encryptedFileKeyData = await encryptFileKey(fileKey, collectionKeyBytes);

    // Step 11: Build finalization request
    const postFileRequest = buildPostFileRequest(
      collectionID,
      encryptedFileKeyData,
      {
        objectKey: fileUploadResult.objectKey,
        decryptionHeader: fileUploadResult.decryptionHeader,
        size: fileUploadResult.size,
      },
      {
        objectKey: thumbnailURLs[0].objectKey,
        decryptionHeader: encryptedThumbnail.decryptionHeader,
        size: encryptedThumbnail.encryptedData.length,
      },
      encryptedMetadata,
      encryptedPubMagicMetadata
    );

    // Step 12: Finalize upload
    logger().debug(`  ✅ Finalizing...`);
    const enteFile = await finalizeUpload(client, authToken, postFileRequest);

    // Update database
    db.updateFileStatus(fileRecord.id, "completed", undefined);
    db.setFileEnteID(fileRecord.id, enteFile.id);
    // Hash already saved earlier (after calculation) to prevent race conditions

    logger().info(`  ✅ Streaming upload complete! (${fileSizeMB}MB)`);

    return {
      success: true,
      enteFile,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger().error(`  ❌ Streaming upload failed: ${errorMessage}`);

    db.updateFileStatus(fileRecord.id, "failed", errorMessage);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Upload file to S3 using streaming encryption + multipart upload
 * Memory efficient: only buffers 2× MULTIPART_CHUNK_SIZE (~40MB)
 */
async function uploadFileStreamingToS3(
  filePath: string,
  fileKey: Uint8Array,
  fileId: number,
  client: APIClient,
  authToken: string,
  db: DatabaseManager
): Promise<{ objectKey: string; size: number; decryptionHeader: string }> {
  // Collect encrypted chunks into S3 parts
  let encryptedChunks: Uint8Array[] = [];
  let totalSize = 0;
  let decryptionHeader = "";
  let currentPartBuffer = new Uint8Array(0);
  const completedParts: MultipartCompletedPart[] = [];

  // Count total chunks for multipart URL fetch
  const file = Bun.file(filePath);
  const fileSize = file.size;

  // Estimate number of S3 parts needed
  // Each encryption chunk is ~4MB, grows slightly with encryption overhead
  // S3 parts are 20MB each
  const estimatedEncryptedSize = Math.ceil(fileSize * 1.05); // ~5% overhead
  const estimatedPartCount = Math.ceil(estimatedEncryptedSize / MULTIPART_CHUNK_SIZE);

  const totalMB = Math.round(estimatedEncryptedSize / 1024 / 1024);
  logger().info(`   🔐 Starting streaming upload: ~${estimatedPartCount} parts (${totalMB}MB encrypted)`);

  // Check if we need multipart (>20MB encrypted)
  const useMultipart = estimatedEncryptedSize > MULTIPART_CHUNK_SIZE;

  let multipartURLs: any = null;
  let singlePartURL: any = null;

  if (useMultipart) {
    // Fetch multipart URLs
    multipartURLs = await fetchMultipartUploadURLs(client, authToken, estimatedPartCount + 1); // +1 for safety
  } else {
    // Fetch single upload URL
    const urls = await fetchUploadURLs(client, authToken, 1);
    singlePartURL = urls[0];
  }

  let partNumber = 1;
  let bytesUploaded = 0;
  let lastProgressLog = Date.now();
  const startTime = Date.now();
  const progressIntervalMs = 5000; // Log progress every 5 seconds

  // Stream encrypt and upload
  for await (let { chunk, isLast, header } of encryptFileStreamGenerator(filePath, fileKey)) {
    // Save header from first chunk
    if (header && !decryptionHeader) {
      decryptionHeader = header;
    }

    totalSize += chunk.length;

    if (!useMultipart) {
      // Single part upload - just collect chunks
      encryptedChunks.push(chunk);
      continue;
    }

    // Multipart upload - accumulate into 20MB parts
    const newBuffer = new Uint8Array(currentPartBuffer.length + chunk.length);
    newBuffer.set(currentPartBuffer);
    newBuffer.set(chunk, currentPartBuffer.length);
    currentPartBuffer = newBuffer;

    // Upload when buffer reaches 20MB or this is the last chunk
    while (currentPartBuffer.length >= MULTIPART_CHUNK_SIZE || (isLast && currentPartBuffer.length > 0)) {
      let partData: Uint8Array;

      if (currentPartBuffer.length >= MULTIPART_CHUNK_SIZE) {
        // Full part
        partData = currentPartBuffer.slice(0, MULTIPART_CHUNK_SIZE);
        currentPartBuffer = currentPartBuffer.slice(MULTIPART_CHUNK_SIZE);
      } else {
        // Last part (remainder)
        partData = currentPartBuffer;
        currentPartBuffer = new Uint8Array(0);
      }

      const partSizeMB = Math.round(partData.length / 1024 / 1024);

      // Upload part
      const eTag = await putFilePart(multipartURLs.partURLs[partNumber - 1], partData);
      if (!eTag) {
        throw new Error(`Failed to get ETag for part ${partNumber}`);
      }

      completedParts.push({ partNumber, eTag });
      bytesUploaded += partData.length;

      // Log progress periodically
      const now = Date.now();
      const shouldLog = (now - lastProgressLog >= progressIntervalMs) || isLast;

      if (shouldLog) {
        const percentComplete = Math.round((bytesUploaded / estimatedEncryptedSize) * 100);
        const uploadedMB = Math.round(bytesUploaded / 1024 / 1024);
        const totalMB = Math.round(estimatedEncryptedSize / 1024 / 1024);

        logger().info(
          `   📤 Uploading part ${partNumber}/${estimatedPartCount + 1}: ` +
          `${uploadedMB}MB / ${totalMB}MB (${percentComplete}%)`
        );
        lastProgressLog = now;
      }

      partNumber++;

      if (currentPartBuffer.length < MULTIPART_CHUNK_SIZE && !isLast) {
        break;
      }
    }
  }

  // Complete upload
  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  const uploadSpeedMBps = bytesUploaded > 0 ? (bytesUploaded / 1024 / 1024 / elapsedSeconds).toFixed(2) : '0';

  if (useMultipart) {
    logger().info(`   ✅ Finalizing multipart upload (${completedParts.length} parts, ${elapsedSeconds}s, ${uploadSpeedMBps} MB/s)...`);
    completedParts.sort((a, b) => a.partNumber - b.partNumber);
    await completeMultipartUpload(multipartURLs.completeURL, completedParts);

    return {
      objectKey: multipartURLs.objectKey,
      size: totalSize,
      decryptionHeader,
    };
  } else {
    // Single part upload - merge chunks and upload
    logger().info(`   📤 Uploading single part (${Math.round(totalSize / 1024 / 1024)}MB)...`);
    const mergedData = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of encryptedChunks) {
      mergedData.set(chunk, offset);
      offset += chunk.length;
    }

    await putFile(singlePartURL.url, mergedData);

    logger().info(`   ✅ Upload complete (${elapsedSeconds}s)`);

    return {
      objectKey: singlePartURL.objectKey,
      size: totalSize,
      decryptionHeader,
    };
  }
}
