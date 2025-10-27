/**
 * File encryption for upload to Ente
 * Matches the web client's encryption scheme using libsodium secretstream
 */

import sodium from "libsodium-wrappers";
import type { FileMetadata } from "./metadata";
import { encryptBox } from "../crypto/encryption";
import { toBase64 } from "../crypto/encryption";
import { createPublicMagicMetadata, encryptPublicMagicMetadata, type RemoteMagicMetadata } from "./magic-metadata";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks (matching streamEncryptionChunkSize)

export interface EncryptedFile {
  encryptedData: Uint8Array;
  decryptionHeader: string; // base64
}

export interface EncryptedFileStream {
  chunks: Uint8Array[];
  totalSize: number;
  decryptionHeader: string; // base64
}

/**
 * Async generator that yields encrypted chunks on-the-fly
 * Memory efficient: only keeps ~4MB in memory at a time
 */
export async function* encryptFileStreamGenerator(
  filePath: string,
  fileKey: Uint8Array
): AsyncGenerator<{ chunk: Uint8Array; isLast: boolean; header?: string }> {
  await sodium.ready;

  const file = Bun.file(filePath);
  const fileSize = file.size;

  // Initialize encryption
  const initPushResult =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const pushState = initPushResult.state;
  const header = initPushResult.header;

  // Yield header first
  const headerBase64 = await toBase64(header);

  // Use streaming read
  const stream = file.stream();
  const reader = stream.getReader();

  let bytesRead = 0;
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Encrypt any remaining buffered data as final chunk
        if (buffer.length > 0) {
          const encryptedChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
            pushState,
            buffer,
            null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          );
          yield { chunk: encryptedChunk, isLast: true, header: headerBase64 };
        }
        break;
      }

      // Append new data to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Process complete 4MB chunks
      while (buffer.length >= CHUNK_SIZE) {
        const chunk = buffer.slice(0, CHUNK_SIZE);
        buffer = buffer.slice(CHUNK_SIZE);
        bytesRead += CHUNK_SIZE;

        const isLast = bytesRead >= fileSize;
        const tag = isLast
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;

        const encryptedChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
          pushState,
          chunk,
          null,
          tag
        );

        yield {
          chunk: encryptedChunk,
          isLast,
          header: headerBase64
        };

        if (isLast) {
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface EncryptedFileKey {
  encryptedData: string; // base64
  nonce: string; // base64
}

export interface EncryptedFilePieces {
  file: {
    encryptedData: Uint8Array;
    decryptionHeader: string;
  };
  thumbnail: {
    encryptedData: Uint8Array;
    decryptionHeader: string;
  };
  metadata: {
    encryptedData: string; // base64
    decryptionHeader: string;
  };
  pubMagicMetadata?: RemoteMagicMetadata;
}

/**
 * Generate a new file key for encryption
 * Uses libsodium's crypto_secretstream_xchacha20poly1305_keygen
 */
export async function generateFileKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/**
 * Encrypt file data using streaming encryption with 4MB chunks
 * TRUE STREAMING: Reads and encrypts chunks incrementally without loading entire file
 */
export async function encryptFileStream(
  filePath: string,
  fileKey: Uint8Array
): Promise<EncryptedFile> {
  await sodium.ready;

  // Get file size for progress tracking
  const file = Bun.file(filePath);
  const fileSize = file.size;

  // Initialize encryption
  const initPushResult =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const pushState = initPushResult.state;
  const header = initPushResult.header;

  // Use streaming read instead of loading entire file
  const stream = file.stream();
  const reader = stream.getReader();

  const encryptedChunks: Uint8Array[] = [];
  let bytesRead = 0;
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Encrypt any remaining buffered data as final chunk
        if (buffer.length > 0) {
          const encryptedChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
            pushState,
            buffer,
            null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          );
          encryptedChunks.push(encryptedChunk);
        }
        break;
      }

      // Append new data to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Process complete 4MB chunks
      while (buffer.length >= CHUNK_SIZE) {
        const chunk = buffer.slice(0, CHUNK_SIZE);
        buffer = buffer.slice(CHUNK_SIZE);
        bytesRead += CHUNK_SIZE;

        const tag = bytesRead >= fileSize
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;

        const encryptedChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
          pushState,
          chunk,
          null,
          tag
        );

        encryptedChunks.push(encryptedChunk);

        if (tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Merge all encrypted chunks
  const totalLength = encryptedChunks.reduce(
    (sum, chunk) => sum + chunk.length,
    0
  );
  const encryptedData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of encryptedChunks) {
    encryptedData.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    encryptedData,
    decryptionHeader: await toBase64(header),
  };
}

/**
 * Encrypt thumbnail data (without chunking, using secretstream for consistency)
 * Matches Ente web client's encryptBlobBytes function
 */
export async function encryptThumbnail(
  thumbnailData: Uint8Array,
  fileKey: Uint8Array
): Promise<EncryptedFile> {
  await sodium.ready;

  const initPushResult =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const pushState = initPushResult.state;
  const header = initPushResult.header;

  const encryptedData = sodium.crypto_secretstream_xchacha20poly1305_push(
    pushState,
    thumbnailData,
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
  );

  return {
    encryptedData,
    decryptionHeader: await toBase64(header),
  };
}

/**
 * Encrypt file metadata as JSON
 * Matches Ente web client's encryptMetadataJSON function
 */
export async function encryptMetadata(
  metadata: FileMetadata,
  fileKey: Uint8Array
): Promise<{ encryptedData: string; decryptionHeader: string }> {
  await sodium.ready;

  const metadataJSON = JSON.stringify(metadata);
  const metadataBytes = new TextEncoder().encode(metadataJSON);

  const initPushResult =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const pushState = initPushResult.state;
  const header = initPushResult.header;

  const encryptedData = sodium.crypto_secretstream_xchacha20poly1305_push(
    pushState,
    metadataBytes,
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
  );

  return {
    encryptedData: await toBase64(encryptedData),
    decryptionHeader: await toBase64(header),
  };
}

/**
 * Encrypt the file key with the collection key
 * Uses secretbox (XSalsa20-Poly1305) for key encryption
 * Matches Ente web client's encryptBox function
 */
export async function encryptFileKey(
  fileKey: Uint8Array,
  collectionKey: Uint8Array
): Promise<EncryptedFileKey> {
  await sodium.ready;

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encryptedKey = sodium.crypto_secretbox_easy(
    fileKey,
    nonce,
    collectionKey
  );

  return {
    encryptedData: await toBase64(encryptedKey),
    nonce: await toBase64(nonce),
  };
}

/**
 * Encrypt all file pieces (file, thumbnail, metadata)
 * This is the main entry point for file encryption
 */
export async function encryptFilePieces(
  filePath: string,
  thumbnailData: Uint8Array,
  metadata: FileMetadata,
  collectionKeyBase64: string
): Promise<{
  encryptedPieces: EncryptedFilePieces;
  encryptedFileKey: EncryptedFileKey;
}> {
  await sodium.ready;

  // Generate random file key
  const fileKey = await generateFileKey();

  // Encrypt file data
  const encryptedFile = await encryptFileStream(filePath, fileKey);

  // Encrypt thumbnail
  const encryptedThumbnail = await encryptThumbnail(thumbnailData, fileKey);

  // Encrypt metadata
  const encryptedMetadata = await encryptMetadata(metadata, fileKey);

  // Create and encrypt public magic metadata
  const pubMagicMetadataData = createPublicMagicMetadata(metadata);
  const encryptedPubMagicMetadata = await encryptPublicMagicMetadata(
    pubMagicMetadataData,
    fileKey
  );

  // Encrypt the file key with collection key
  const collectionKey = await fromBase64(collectionKeyBase64);
  const encryptedFileKey = await encryptFileKey(fileKey, collectionKey);

  return {
    encryptedPieces: {
      file: encryptedFile,
      thumbnail: encryptedThumbnail,
      metadata: encryptedMetadata,
      pubMagicMetadata: encryptedPubMagicMetadata,
    },
    encryptedFileKey,
  };
}

/**
 * Helper: Convert base64 to bytes
 */
async function fromBase64(base64: string): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.from_base64(base64, sodium.base64_variants.ORIGINAL);
}
