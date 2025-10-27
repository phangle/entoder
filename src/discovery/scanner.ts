/**
 * Recursive directory scanner with async generators
 */

import { stat, readdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger";

export interface DiscoveredFile {
  path: string;
  size: number;
  mtime: number; // Epoch milliseconds
  directory: string;
}

export interface ScanProgress {
  filesScanned: number;
  directoriesScanned: number;
  bytesFound: number;
  currentPath: string;
  elapsedMs: number;
}

export interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void;
  progressIntervalMs?: number; // How often to report progress (default: 1000ms)
}

const HIDDEN_PREFIXES = [".", "_"];
const SYSTEM_DIRS = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

/**
 * Recursively scan directory for files
 */
export async function* scanDirectory(
  rootPath: string,
  options: ScanOptions = {}
): AsyncGenerator<DiscoveredFile> {
  const visited = new Set<string>(); // Track visited paths to avoid circular symlinks
  const startTime = Date.now();
  const progressIntervalMs = options.progressIntervalMs ?? 1000;

  let filesScanned = 0;
  let directoriesScanned = 0;
  let bytesFound = 0;
  let lastProgressReport = 0;

  const reportProgress = (currentPath: string) => {
    const now = Date.now();
    if (options.onProgress && now - lastProgressReport >= progressIntervalMs) {
      options.onProgress({
        filesScanned,
        directoriesScanned,
        bytesFound,
        currentPath,
        elapsedMs: now - startTime,
      });
      lastProgressReport = now;
    }
  };

  async function* scan(dirPath: string): AsyncGenerator<DiscoveredFile> {
    // Check if directory exists
    try {
      const stats = await stat(dirPath);
      if (!stats.isDirectory()) {
        return;
      }
    } catch (error) {
      logger().warn(`Path does not exist or is not accessible: ${dirPath}`);
      return;
    }

    // Detect circular symlinks
    if (visited.has(dirPath)) {
      logger().warn(`Circular symlink detected: ${dirPath}`);
      return;
    }
    visited.add(dirPath);

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      directoriesScanned++;

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        // Skip hidden files and system directories
        if (shouldSkip(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          // Report progress before entering subdirectory
          reportProgress(fullPath);
          // Recursively scan subdirectory
          yield* scan(fullPath);
        } else if (entry.isFile()) {
          try {
            // Optimization: Get metadata without redundant stat() call
            // readdir with withFileTypes already called stat internally
            // Try to use that data first, fallback to explicit stat if needed
            let size: number;
            let mtime: number;

            // Check if entry has extended metadata (Bun/Node 18.3+)
            if ('size' in entry && typeof (entry as any).size === 'number') {
              size = (entry as any).size;
              // Try to get mtime if available
              if ('mtimeMs' in entry && typeof (entry as any).mtimeMs === 'number') {
                mtime = (entry as any).mtimeMs;
              } else {
                // Need explicit stat for mtime only
                const stats = await stat(fullPath);
                mtime = stats.mtimeMs;
              }
            } else {
              // Extended metadata not available - need explicit stat
              const stats = await stat(fullPath);
              size = stats.size;
              mtime = stats.mtimeMs;
            }

            filesScanned++;
            bytesFound += size;

            // Report progress periodically during file scanning
            reportProgress(fullPath);

            yield {
              path: fullPath,
              size,
              mtime,
              directory: dirPath,
            };
          } catch (error) {
            logger().warn({ error }, `Failed to stat file ${fullPath}`);
          }
        }
        // Skip symlinks, sockets, etc.
      }
    } catch (error) {
      logger().error({ error }, `Failed to scan directory ${dirPath}`);
    }
  }

  yield* scan(rootPath);

  // Final progress report
  if (options.onProgress) {
    options.onProgress({
      filesScanned,
      directoriesScanned,
      bytesFound,
      currentPath: rootPath,
      elapsedMs: Date.now() - startTime,
    });
  }
}

/**
 * Check if file/directory should be skipped
 */
function shouldSkip(name: string): boolean {
  // Skip hidden files
  if (HIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }

  // Skip system directories
  if (SYSTEM_DIRS.has(name)) {
    return true;
  }

  return false;
}

/**
 * Get total count of files in directories (for progress tracking)
 */
export async function countFiles(paths: string[]): Promise<number> {
  let count = 0;

  for (const path of paths) {
    for await (const _file of scanDirectory(path)) {
      count++;
    }
  }

  return count;
}
