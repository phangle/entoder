/**
 * Low-level I/O optimizations using FFI
 * Provides platform-specific syscall access for better performance
 */

import { dlopen, FFIType, suffix, ptr } from "bun:ffi";
import { logger } from "./logger";

// Platform detection
const isLinux = process.platform === "linux";
const isMacOS = process.platform === "darwin";
const isSupported = isLinux || isMacOS;

// FFI bindings
let libc: any = null;
let ffiAvailable = false;

// Constants
const PROT_READ = 1;
const MAP_PRIVATE = 2;
const MAP_FAILED = -1;

// posix_fadvise constants
const POSIX_FADV_NORMAL = 0;
const POSIX_FADV_SEQUENTIAL = 2;
const POSIX_FADV_WILLNEED = 3;
const POSIX_FADV_NOREUSE = 5;

/**
 * Initialize FFI bindings
 */
function initFFI(): boolean {
  if (libc !== null) return ffiAvailable;

  try {
    // Try to load libc
    // macOS: Try multiple paths (Big Sur+ moved libraries)
    const libcPaths = isLinux
      ? ["libc.so.6"]
      : isMacOS
      ? [
          "/usr/lib/libSystem.B.dylib",           // macOS 10.15 and earlier
          "/usr/lib/system/libsystem_c.dylib",    // macOS 11+
          "libsystem_c.dylib",                    // Try without path
        ]
      : [];

    if (libcPaths.length === 0) {
      ffiAvailable = false;
      return false;
    }

    // Try each path until one works
    let lastError: any = null;
    for (const libcPath of libcPaths) {
      try {
        libc = dlopen(libcPath, {
      // posix_fadvise: hint to kernel about I/O patterns
      posix_fadvise: {
        args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32],
        returns: FFIType.i32,
      },
      // mmap: memory-map files
      mmap: {
        args: [
          FFIType.ptr,    // addr
          FFIType.u64,    // length
          FFIType.i32,    // prot
          FFIType.i32,    // flags
          FFIType.i32,    // fd
          FFIType.i64,    // offset
        ],
        returns: FFIType.ptr,
      },
      // munmap: unmap memory
      munmap: {
        args: [FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
      // open: get file descriptor
      open: {
        args: [FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
      // close: close file descriptor
      close: {
        args: [FFIType.i32],
        returns: FFIType.i32,
      },
        });

        // If we got here, dlopen succeeded
        ffiAvailable = true;
        return true;
      } catch (error) {
        lastError = error;
        // Try next path
      }
    }

    // All paths failed
    ffiAvailable = false;
    return false;
  } catch (error) {
    ffiAvailable = false;
    return false;
  }
}

/**
 * Hint to kernel that we'll read a file sequentially
 * This enables aggressive read-ahead
 */
export function adviseSequentialRead(fd: number, size: number): boolean {
  if (!initFFI() || !libc?.symbols?.posix_fadvise) {
    return false;
  }

  try {
    // Tell kernel: we'll read sequentially (aggressive read-ahead)
    libc.symbols.posix_fadvise(fd, 0, size, POSIX_FADV_SEQUENTIAL);

    // Tell kernel: start reading ahead now
    libc.symbols.posix_fadvise(fd, 0, size, POSIX_FADV_WILLNEED);

    return true;
  } catch (error) {
    // Silently fail - not critical
    return false;
  }
}

/**
 * Hint to kernel that we won't reuse this data
 * Prevents polluting page cache with upload data
 */
export function adviseNoReuse(fd: number, size: number): boolean {
  if (!initFFI() || !libc?.symbols?.posix_fadvise) {
    return false;
  }

  try {
    libc.symbols.posix_fadvise(fd, 0, size, POSIX_FADV_NOREUSE);
    return true;
  } catch (error) {
    // Silently fail - not critical
    return false;
  }
}

/**
 * Memory-map a file for reading
 * Returns Uint8Array view of the file, or null on failure
 */
export function mmapFile(filePath: string, size: number): Uint8Array | null {
  if (!initFFI() || !libc?.symbols?.mmap || !libc?.symbols?.open || !libc?.symbols?.close) {
    return null;
  }

  let fd = -1;
  let mapped: any = null;

  try {
    // Open file (O_RDONLY = 0)
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(filePath + '\0');
    fd = libc.symbols.open(ptr(pathBytes), 0);

    if (fd < 0) {
      // Silently fail
      return null;
    }

    // Memory-map the file
    mapped = libc.symbols.mmap(
      null,           // Let kernel choose address
      size,           // Length
      PROT_READ,      // Read-only
      MAP_PRIVATE,    // Private mapping
      fd,             // File descriptor
      0               // Offset
    );

    if (!mapped || mapped === MAP_FAILED) {
      // Silently fail
      return null;
    }

    // Create Uint8Array view of mapped memory
    const view = ptr(mapped) as unknown as Uint8Array;

    // Store fd and mapped address for cleanup
    // We'll need to munmap this later
    (view as any).__mmapFd = fd;
    (view as any).__mmapAddr = mapped;
    (view as any).__mmapSize = size;

    return view;
  } catch (error) {
    // Silently fail - cleanup and return null

    // Cleanup on error
    if (mapped && mapped !== MAP_FAILED) {
      try {
        libc.symbols.munmap(mapped, size);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (fd >= 0) {
      try {
        libc.symbols.close(fd);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    return null;
  }
}

/**
 * Unmap a memory-mapped file
 */
export function munmapFile(view: Uint8Array): boolean {
  if (!initFFI() || !libc?.symbols?.munmap || !libc?.symbols?.close) {
    return false;
  }

  try {
    const mapped = (view as any).__mmapAddr;
    const size = (view as any).__mmapSize;
    const fd = (view as any).__mmapFd;

    if (!mapped || !size) {
      return false;
    }

    // Unmap memory
    libc.symbols.munmap(mapped, size);

    // Close file descriptor
    if (fd >= 0) {
      libc.symbols.close(fd);
    }

    // Clear references
    delete (view as any).__mmapAddr;
    delete (view as any).__mmapSize;
    delete (view as any).__mmapFd;

    return true;
  } catch (error) {
    // Silently fail
    return false;
  }
}

/**
 * Check if native I/O optimizations are available
 */
export function isNativeIOAvailable(): boolean {
  return initFFI();
}

/**
 * Get statistics about native I/O usage
 */
export function getNativeIOStats() {
  return {
    available: ffiAvailable,
    platform: process.platform,
    supported: isSupported,
    features: {
      fadvise: ffiAvailable && !!libc?.symbols?.posix_fadvise,
      mmap: ffiAvailable && !!libc?.symbols?.mmap,
    },
  };
}
