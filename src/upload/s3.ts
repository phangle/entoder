/**
 * S3 upload functionality for Ente
 * Handles both single-part and multipart uploads
 */

import { logger } from "../utils/logger";
import type { APIClient } from "../api/client";
import type { DatabaseManager } from "../db";

export interface ObjectUploadURL {
  objectKey: string;
  url: string;
}

export interface MultipartUploadURLs {
  objectKey: string;
  partURLs: string[];
  completeURL: string;
}

export interface MultipartCompletedPart {
  partNumber: number; // 1-indexed
  eTag: string;
}

const MULTIPART_CHUNK_SIZE = 5 * 4 * 1024 * 1024; // 20MB (5 encryption chunks per part)

/**
 * Fetch pre-signed URLs for uploading files
 */
export async function fetchUploadURLs(
  client: APIClient,
  authToken: string,
  count: number
): Promise<ObjectUploadURL[]> {
  const response = await client.get<{ urls: ObjectUploadURL[] }>(
    "/files/upload-urls",
    {
      query: { count: Math.min(50, count * 2).toString(), ts: Date.now().toString() },
      headers: { "X-Auth-Token": authToken },
    }
  );
  return response.urls;
}

/**
 * Fetch pre-signed URLs for multipart upload
 */
export async function fetchMultipartUploadURLs(
  client: APIClient,
  authToken: string,
  partCount: number
): Promise<MultipartUploadURLs> {
  const response = await client.get<{ urls: MultipartUploadURLs }>(
    "/files/multipart-upload-urls",
    {
      query: { count: partCount.toString(), ts: Date.now().toString() },
      headers: { "X-Auth-Token": authToken },
    }
  );
  return response.urls;
}

/**
 * Upload data to S3 using a pre-signed URL (single-part upload)
 */
export async function putFile(
  uploadURL: string,
  data: Uint8Array
): Promise<void> {
  try {
    const response = await fetch(uploadURL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(data),
    });

    if (!response.ok) {
      const urlHost = new URL(uploadURL).hostname;
      throw new Error(
        `S3 upload failed: ${response.status} ${response.statusText} (host: ${urlHost})`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("S3 upload failed")) {
      throw error; // Already formatted
    }
    // Network/connection error
    const urlHost = new URL(uploadURL).hostname;
    throw new Error(
      `Unable to connect to S3 (host: ${urlHost}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Upload a part of a multipart upload
 * Returns the ETag header from the response
 */
export async function putFilePart(
  partURL: string,
  partData: Uint8Array
): Promise<string | undefined> {
  try {
    const response = await fetch(partURL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(partData),
    });

    if (!response.ok) {
      const urlHost = new URL(partURL).hostname;
      throw new Error(
        `S3 part upload failed: ${response.status} ${response.statusText} (host: ${urlHost})`
      );
    }

    // Get ETag from response headers (needed for multipart completion)
    const etag = response.headers.get("etag");
    return etag || undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes("S3 part upload failed")) {
      throw error; // Already formatted
    }
    // Network/connection error
    const urlHost = new URL(partURL).hostname;
    throw new Error(
      `Unable to connect to S3 for part upload (host: ${urlHost}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Complete a multipart upload by reporting all uploaded parts
 */
export async function completeMultipartUpload(
  completionURL: string,
  completedParts: MultipartCompletedPart[]
): Promise<void> {
  // Build XML body for completion request
  const xmlParts = completedParts
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.eTag}</ETag></Part>`
    )
    .join("\n");

  const xmlBody = `<CompleteMultipartUpload>\n${xmlParts}\n</CompleteMultipartUpload>`;

  try {
    const response = await fetch(completionURL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
      },
      body: xmlBody,
    });

    if (!response.ok) {
      const urlHost = new URL(completionURL).hostname;
      throw new Error(
        `S3 multipart completion failed: ${response.status} ${response.statusText} (host: ${urlHost})`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("S3 multipart completion failed")) {
      throw error; // Already formatted
    }
    // Network/connection error
    const urlHost = new URL(completionURL).hostname;
    throw new Error(
      `Unable to connect to S3 for multipart completion (host: ${urlHost}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Upload encrypted file data to S3
 * Automatically chooses between single-part and multipart upload
 */
export async function uploadToS3(
  client: APIClient,
  authToken: string,
  encryptedData: Uint8Array
): Promise<{ objectKey: string; size: number }> {
  const size = encryptedData.length;

  // Use multipart upload for files larger than 20MB
  if (size > MULTIPART_CHUNK_SIZE) {
    return uploadMultipart(client, authToken, encryptedData);
  } else {
    return uploadSinglePart(client, authToken, encryptedData);
  }
}

/**
 * Upload encrypted file data to S3 with resumable support
 * Tracks progress in database for crash recovery
 */
export async function uploadToS3Resumable(
  client: APIClient,
  authToken: string,
  encryptedData: Uint8Array,
  fileId: number,
  db: DatabaseManager
): Promise<{ objectKey: string; size: number }> {
  const size = encryptedData.length;

  // Use multipart upload for files larger than 20MB
  if (size > MULTIPART_CHUNK_SIZE) {
    return uploadMultipartResumable(client, authToken, encryptedData, fileId, db);
  } else {
    return uploadSinglePart(client, authToken, encryptedData);
  }
}

/**
 * Upload using single-part upload
 */
async function uploadSinglePart(
  client: APIClient,
  authToken: string,
  data: Uint8Array
): Promise<{ objectKey: string; size: number }> {
  // Fetch one upload URL
  const urls = await fetchUploadURLs(client, authToken, 1);
  const uploadURL = urls[0];

  // Upload to S3
  await putFile(uploadURL.url, data);

  return {
    objectKey: uploadURL.objectKey,
    size: data.length,
  };
}

/**
 * Upload using multipart upload
 */
async function uploadMultipart(
  client: APIClient,
  authToken: string,
  data: Uint8Array
): Promise<{ objectKey: string; size: number }> {
  // Calculate number of parts needed
  const partCount = Math.ceil(data.length / MULTIPART_CHUNK_SIZE);

  // Fetch multipart URLs
  const multipartURLs = await fetchMultipartUploadURLs(
    client,
    authToken,
    partCount
  );

  // Upload each part
  const completedParts: MultipartCompletedPart[] = [];

  for (let i = 0; i < partCount; i++) {
    const start = i * MULTIPART_CHUNK_SIZE;
    const end = Math.min(start + MULTIPART_CHUNK_SIZE, data.length);
    const partData = data.slice(start, end);

    const partNumber = i + 1; // Part numbers are 1-indexed
    const partURL = multipartURLs.partURLs[i];

    logger().info(
      `Uploading part ${partNumber}/${partCount} (${partData.length} bytes)`
    );

    const eTag = await putFilePart(partURL, partData);

    if (!eTag) {
      throw new Error(`Failed to get ETag for part ${partNumber}`);
    }

    completedParts.push({ partNumber, eTag });
  }

  // Complete the multipart upload
  logger().info(`Completing multipart upload...`);
  await completeMultipartUpload(multipartURLs.completeURL, completedParts);

  return {
    objectKey: multipartURLs.objectKey,
    size: data.length,
  };
}

/**
 * Upload using multipart upload with resume support
 * Tracks each part's status in database for crash recovery
 */
async function uploadMultipartResumable(
  client: APIClient,
  authToken: string,
  data: Uint8Array,
  fileId: number,
  db: DatabaseManager
): Promise<{ objectKey: string; size: number }> {
  // Calculate number of parts needed
  const partCount = Math.ceil(data.length / MULTIPART_CHUNK_SIZE);

  // Check if we have existing upload parts in database
  const existingParts = db.getUploadPartsByFileId(fileId);

  let multipartURLs: MultipartUploadURLs;
  let completedParts: MultipartCompletedPart[] = [];

  if (existingParts.length > 0) {
    // Resume existing upload
    logger().info(`   Resuming previous upload (${existingParts.length} parts tracked)`);

    // Reconstruct multipart URLs from database
    const firstPart = existingParts[0];
    multipartURLs = {
      objectKey: firstPart.object_key,
      completeURL: firstPart.complete_url,
      partURLs: existingParts.map((p) => p.part_url),
    };

    // Collect already completed parts
    completedParts = existingParts
      .filter((p) => p.status === "completed" && p.part_etag)
      .map((p) => ({
        partNumber: p.part_number,
        eTag: p.part_etag!,
      }));

    logger().info(`   ${completedParts.length} parts already uploaded`);
  } else {
    // Start new upload
    multipartURLs = await fetchMultipartUploadURLs(
      client,
      authToken,
      partCount
    );

    // Create database records for all parts
    db.transaction(() => {
      for (let i = 0; i < partCount; i++) {
        const partNumber = i + 1;
        db.createUploadPart(
          fileId,
          multipartURLs.objectKey,
          multipartURLs.completeURL,
          partNumber,
          multipartURLs.partURLs[i]
        );
      }
    });

    logger().info(`   Starting new multipart upload (${partCount} parts)`);
  }

  // Upload each part (skip already completed ones)
  const partsToUpload = db.getUploadPartsByFileId(fileId);

  for (const part of partsToUpload) {
    if (part.status === "completed" && part.part_etag) {
      // Already uploaded, skip
      continue;
    }

    const start = (part.part_number - 1) * MULTIPART_CHUNK_SIZE;
    const end = Math.min(start + MULTIPART_CHUNK_SIZE, data.length);
    const partData = data.slice(start, end);

    logger().info(
      `   Uploading part ${part.part_number}/${partCount} (${partData.length} bytes)...`
    );

    // Mark as uploading
    db.updateUploadPartStatus(part.id, "uploading", undefined, 0);

    try {
      const eTag = await putFilePart(part.part_url, partData);

      if (!eTag) {
        throw new Error(`Failed to get ETag for part ${part.part_number}`);
      }

      // Mark as completed in database
      db.updateUploadPartStatus(part.id, "completed", eTag, partData.length);

      completedParts.push({ partNumber: part.part_number, eTag });

      // TEST: Simulate crash after first part (for testing resume functionality)
      if (process.env.TEST_CRASH_AFTER_PART_1 === "true" && part.part_number === 1) {
        logger().info(`   [TEST] Simulating crash after part 1...`);
        throw new Error("Simulated crash for testing resume functionality");
      }
    } catch (error) {
      // Only mark as failed if it wasn't already completed
      const currentPart = db.getUploadPartById(part.id);
      if (currentPart && currentPart.status !== "completed") {
        db.updateUploadPartStatus(part.id, "failed");
      }
      throw error;
    }
  }

  // Sort completed parts by part number
  completedParts.sort((a, b) => a.partNumber - b.partNumber);

  // Complete the multipart upload
  logger().info(`   Completing multipart upload...`);
  await completeMultipartUpload(multipartURLs.completeURL, completedParts);

  // Clean up database records after successful completion
  db.deleteUploadPartsByFileId(fileId);

  return {
    objectKey: multipartURLs.objectKey,
    size: data.length,
  };
}
