/**
 * File hashing for deduplication
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { calculateFileHashOptimized } from "./hash-optimized.js";
import { isNativeIOAvailable } from "../utils/native-io.js";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks (matching Ente's streamEncryptionChunkSize)

// Check if optimizations are available at module load time
const useOptimizations = isNativeIOAvailable();

/**
 * Calculate hash of file using streaming approach
 * Automatically uses optimized I/O when available (mmap, fadvise)
 * Matches Ente's chunked hashing strategy
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  // Use optimized version if available
  if (useOptimizations) {
    return calculateFileHashOptimized(filePath);
  }

  // Fallback to regular streaming
  return calculateFileHashFallback(filePath);
}

/**
 * Fallback streaming hash (no optimizations)
 */
async function calculateFileHashFallback(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const stream = file.stream();
  const reader = stream.getReader();

  // Use incremental hashing
  let hash = new Uint8Array(32); // SHA256 produces 32 bytes
  let isFirst = true;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (isFirst) {
        // First chunk
        hash = sha256(value) as Uint8Array<ArrayBuffer>;
        isFirst = false;
      } else {
        // Subsequent chunks: hash(previous_hash + new_chunk)
        const combined = new Uint8Array(hash.length + value.length);
        combined.set(hash);
        combined.set(value, hash.length);
        hash = sha256(combined) as Uint8Array<ArrayBuffer>;
      }
    }

    return Buffer.from(hash).toString("base64");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Quick hash for small files (loads entire file into memory)
 */
export async function quickHash(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hash = sha256(new Uint8Array(buffer));
  return Buffer.from(hash).toString("base64");
}

/**
 * Calculate hash with progress callback
 * Uses optimized I/O when available
 */
export async function calculateFileHashWithProgress(
  filePath: string,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<string> {
  // Use optimized version if available
  if (useOptimizations) {
    const { calculateFileHashWithProgressOptimized } = await import("./hash-optimized");
    return calculateFileHashWithProgressOptimized(filePath, onProgress);
  }

  // Fallback to regular streaming
  return calculateFileHashWithProgressFallback(filePath, onProgress);
}

/**
 * Fallback hash with progress (no optimizations)
 */
async function calculateFileHashWithProgressFallback(
  filePath: string,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<string> {
  const file = Bun.file(filePath);
  const totalSize = file.size;
  const stream = file.stream();
  const reader = stream.getReader();

  let hash = new Uint8Array(32);
  let isFirst = true;
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      bytesRead += value.length;

      if (isFirst) {
        hash = sha256(value) as Uint8Array<ArrayBuffer>;
        isFirst = false;
      } else {
        const combined = new Uint8Array(hash.length + value.length);
        combined.set(hash);
        combined.set(value, hash.length);
        hash = sha256(combined) as Uint8Array<ArrayBuffer>;
      }

      if (onProgress) {
        onProgress(bytesRead, totalSize);
      }
    }

    return Buffer.from(hash).toString("base64");
  } finally {
    reader.releaseLock();
  }
}
