/**
 * Museum API finalization for uploaded files
 * Creates the EnteFile record on the server after S3 upload completes
 */

import type { APIClient } from "../api/client";
import type { FileMetadata } from "./metadata";
import type { RemoteMagicMetadata } from "./magic-metadata";

export interface UploadedFileObject {
  objectKey: string;
  decryptionHeader: string;
  size: number;
}

export interface PostFileRequest {
  collectionID: number;
  encryptedKey: string;
  keyDecryptionNonce: string;
  file: UploadedFileObject;
  thumbnail: UploadedFileObject;
  metadata: {
    encryptedData: string; // base64
    decryptionHeader: string; // base64
  };
  pubMagicMetadata?: RemoteMagicMetadata;
}

export interface EnteFile {
  id: number;
  collectionID: number;
  file: {
    objectKey: string;
    decryptionHeader: string;
  };
  thumbnail: {
    objectKey: string;
    decryptionHeader: string;
  };
  metadata: {
    encryptedData: string;
    decryptionHeader: string;
  };
  encryptedKey: string;
  keyDecryptionNonce: string;
  creationTime: number;
  updatedAt: number;
}

/**
 * Finalize file upload by creating EnteFile on Museum
 * This tells the server about the uploaded S3 objects
 */
export async function finalizeUpload(
  client: APIClient,
  authToken: string,
  request: PostFileRequest
): Promise<EnteFile> {
  const response = await client.post<EnteFile>("/files", request, {
    headers: { "X-Auth-Token": authToken },
  });

  return response;
}

/**
 * Build the PostFileRequest from upload components
 */
export function buildPostFileRequest(
  collectionID: number,
  encryptedFileKey: { encryptedData: string; nonce: string },
  fileObject: UploadedFileObject,
  thumbnailObject: UploadedFileObject,
  metadataObject: { encryptedData: string; decryptionHeader: string },
  pubMagicMetadata?: RemoteMagicMetadata
): PostFileRequest {
  const request: PostFileRequest = {
    collectionID,
    encryptedKey: encryptedFileKey.encryptedData,
    keyDecryptionNonce: encryptedFileKey.nonce,
    file: fileObject,
    thumbnail: thumbnailObject,
    metadata: metadataObject,
  };

  // Only include pubMagicMetadata if it exists
  if (pubMagicMetadata) {
    request.pubMagicMetadata = pubMagicMetadata;
  }

  return request;
}
