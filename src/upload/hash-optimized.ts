/**
 * Optimized file hashing with native I/O
 * Uses mmap for large files, fadvise for read-ahead
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { adviseSequentialRead, mmapFile, munmapFile, isNativeIOAvailable } from "../utils/native-io.js";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
const MMAP_THRESHOLD = 10 * 1024 * 1024; // Use mmap for files >10MB

/**
 * Calculate file hash using optimized I/O
 * - Uses mmap for large files (>10MB)
 * - Uses fadvise for read-ahead hints
 * - Falls back to streaming for small files or when optimizations unavailable
 */
export async function calculateFileHashOptimized(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const size = file.size;

  // For large files, try memory-mapped I/O
  if (size >= MMAP_THRESHOLD && isNativeIOAvailable()) {
    const hash = await tryMmapHash(filePath, size);
    if (hash !== null) {
      return hash;
    }
    // Fall through to streaming if mmap fails
  }

  // For medium files, use fadvise hints with streaming
  if (size > 1024 * 1024 && isNativeIOAvailable()) {
    return await streamHashWithFadvise(filePath, size);
  }

  // For small files or when optimizations unavailable, use regular streaming
  return await streamHash(filePath);
}

/**
 * Hash using memory-mapped I/O (zero-copy)
 */
async function tryMmapHash(filePath: string, size: number): Promise<string | null> {
  const mapped = mmapFile(filePath, size);

  if (!mapped) {
    // Silently fall back to streaming
    return null;
  }

  try {
    // Hash the entire mapped file
    // For very large files, we still chunk to avoid overwhelming the hasher
    let hash = new Uint8Array(32);
    let isFirst = true;

    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, size);
      const chunk = mapped.subarray(offset, end);

      if (isFirst) {
        hash = sha256(chunk) as Uint8Array<ArrayBuffer>;
        isFirst = false;
      } else {
        const combined = new Uint8Array(hash.length + chunk.length);
        combined.set(hash);
        combined.set(chunk, hash.length);
        hash = sha256(combined) as Uint8Array<ArrayBuffer>;
      }
    }

    return Buffer.from(hash).toString("base64");
  } finally {
    // Always unmap
    munmapFile(mapped);
  }
}

/**
 * Hash using streaming with fadvise hints
 */
async function streamHashWithFadvise(filePath: string, size: number): Promise<string> {
  const file = Bun.file(filePath);

  // Try to get file descriptor for fadvise
  try {
    // Bun.file().fd is available in recent Bun versions
    const fd = (file as any).fd;
    if (typeof fd === 'number' && fd >= 0) {
      // Give kernel hints
      adviseSequentialRead(fd, size);
    }
  } catch (error) {
    // fd not available or fadvise failed, continue with regular streaming
    // Silently continue
  }

  // Stream and hash
  return await streamHash(filePath);
}

/**
 * Regular streaming hash (fallback)
 */
async function streamHash(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const stream = file.stream();
  const reader = stream.getReader();

  let hash = new Uint8Array(32);
  let isFirst = true;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (isFirst) {
        hash = sha256(value) as Uint8Array<ArrayBuffer>;
        isFirst = false;
      } else {
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
 * Calculate hash with progress callback (optimized version)
 */
export async function calculateFileHashWithProgressOptimized(
  filePath: string,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<string> {
  const file = Bun.file(filePath);
  const size = file.size;

  // mmap doesn't provide progress easily, so use streaming with fadvise
  const stream = file.stream();
  const reader = stream.getReader();

  // Try fadvise hint
  try {
    const fd = (file as any).fd;
    if (typeof fd === 'number' && fd >= 0 && isNativeIOAvailable()) {
      adviseSequentialRead(fd, size);
    }
  } catch (error) {
    // Ignore fadvise errors
  }

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
        onProgress(bytesRead, size);
      }
    }

    return Buffer.from(hash).toString("base64");
  } finally {
    reader.releaseLock();
  }
}
