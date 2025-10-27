/**
 * Public magic metadata for Ente files
 * Contains publicly visible metadata like dimensions, timestamps, etc.
 */

import sodium from "libsodium-wrappers";
import type { FileMetadata } from "./metadata";

export interface FilePublicMagicMetadataData {
  dateTime?: string;      // ISO 8601 local time (e.g., "2022-01-26T13:08:20")
  offsetTime?: string;    // UTC offset (e.g., "+02:00")
  editedTime?: number;    // Modified creation time (epoch microseconds)
  editedName?: string;    // Modified file name
  w?: number;             // Image width in pixels
  h?: number;             // Image height in pixels
  caption?: string;       // User-added caption/description
  uploaderName?: string;  // Name from public link upload
  lat?: number;           // Edited latitude
  long?: number;          // Edited longitude
  sv?: number;            // Video streaming flag (1 = skip HLS processing)
}

export interface RemoteMagicMetadata {
  version: number;        // Monotonically increasing iteration (starts at 1)
  count: number;          // Number of keys with non-nullish values in data
  data: string;           // Base64-encoded encrypted JSON object
  header: string;         // Base64-encoded decryption header
}

/**
 * Create public magic metadata from file metadata
 */
export function createPublicMagicMetadata(
  metadata: FileMetadata
): FilePublicMagicMetadataData {
  const pubMetadata: FilePublicMagicMetadataData = {};

  // Add image dimensions if available
  if (metadata.width) {
    pubMetadata.w = metadata.width;
  }
  if (metadata.height) {
    pubMetadata.h = metadata.height;
  }

  // Add creation time in ISO 8601 format
  if (metadata.creationTime) {
    const date = new Date(metadata.creationTime / 1000); // Convert µs to ms
    // Format as ISO 8601 local time without timezone (Ente format)
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');

    pubMetadata.dateTime = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

    // Add timezone offset
    const offsetMinutes = -date.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
    const offsetMins = Math.abs(offsetMinutes) % 60;
    const offsetSign = offsetMinutes >= 0 ? '+' : '-';
    pubMetadata.offsetTime = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;
  }

  // Add GPS coordinates if available
  if (metadata.latitude !== undefined) {
    pubMetadata.lat = metadata.latitude;
  }
  if (metadata.longitude !== undefined) {
    pubMetadata.long = metadata.longitude;
  }

  return pubMetadata;
}

/**
 * Strip nullish values from metadata object
 */
function stripNullish(data: FilePublicMagicMetadataData): FilePublicMagicMetadataData {
  const stripped: FilePublicMagicMetadataData = {};

  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) {
      (stripped as any)[key] = value;
    }
  }

  return stripped;
}

/**
 * Count non-nullish keys in metadata object
 */
function countKeys(data: FilePublicMagicMetadataData): number {
  let count = 0;
  for (const value of Object.values(data)) {
    if (value !== null && value !== undefined) {
      count++;
    }
  }
  return count;
}

/**
 * Encrypt public magic metadata
 * Uses the file's key (not collection key) for encryption
 */
export async function encryptPublicMagicMetadata(
  data: FilePublicMagicMetadataData,
  fileKey: Uint8Array
): Promise<RemoteMagicMetadata | undefined> {
  await sodium.ready;

  // Strip nullish values
  const strippedData = stripNullish(data);
  const count = countKeys(strippedData);

  // If no data, don't include pubMagicMetadata
  if (count === 0) {
    return undefined;
  }

  // Serialize to JSON
  const jsonStr = JSON.stringify(strippedData);
  const jsonBytes = new TextEncoder().encode(jsonStr);

  // Encrypt using secretstream (matching Ente's encryptMetadataJSON)
  const initPushResult = sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const pushState = initPushResult.state;
  const header = initPushResult.header;

  const encryptedData = sodium.crypto_secretstream_xchacha20poly1305_push(
    pushState,
    jsonBytes,
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
  );

  return {
    version: 1, // Always start at version 1 for new files
    count,
    data: sodium.to_base64(encryptedData, sodium.base64_variants.ORIGINAL),
    header: sodium.to_base64(header, sodium.base64_variants.ORIGINAL),
  };
}
