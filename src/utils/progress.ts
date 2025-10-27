/**
 * Progress tracking and reporting utility
 */

import { logger } from "./logger";

export interface UploadJobSummary {
  totalFiles: number;
  newFiles: number;
  alreadyUploaded: number;
  totalBytes: number;
  newBytes: number;
}

export interface UploadProgress {
  filesCompleted: number;
  filesTotal: number;
  bytesCompleted: number;
  bytesTotal: number;
  currentFile?: string;
  currentFileProgress?: number; // 0-100
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Calculate upload speed
 */
export function formatSpeed(bytes: number, ms: number): string {
  if (ms === 0) return "0 B/s";
  const bytesPerSecond = (bytes / ms) * 1000;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Progress reporter for upload jobs
 */
export class ProgressReporter {
  private startTime: number;
  private lastReportTime: number;
  private reportInterval: number; // milliseconds
  private logLevel: string;

  constructor(
    private summary: UploadJobSummary,
    options: { reportInterval?: number; logLevel?: string } = {}
  ) {
    this.startTime = Date.now();
    this.lastReportTime = this.startTime;
    this.reportInterval = options.reportInterval ?? 5000; // Default: report every 5 seconds
    this.logLevel = options.logLevel ?? "info";
  }

  /**
   * Report job summary at the start
   */
  reportJobSummary(): void {
    if (this.logLevel === "silent") return;

    const { totalFiles, newFiles, alreadyUploaded, totalBytes, newBytes } = this.summary;

    logger().info("");
    logger().info("📊 Upload Job Summary:");
    logger().info(`   Total files discovered: ${totalFiles}`);
    logger().info(`   Already uploaded: ${alreadyUploaded}`);
    logger().info(`   New files to upload: ${newFiles}`);
    logger().info(`   Total size: ${formatBytes(totalBytes)}`);
    logger().info(`   New data to upload: ${formatBytes(newBytes)}`);
    logger().info("");
  }

  /**
   * Report progress during upload (periodic)
   */
  reportProgress(progress: UploadProgress): void {
    if (this.logLevel === "silent") return;

    const now = Date.now();
    const shouldReport =
      this.logLevel === "debug" ||
      this.logLevel === "trace" ||
      now - this.lastReportTime >= this.reportInterval;

    if (!shouldReport) return;

    this.lastReportTime = now;

    const { filesCompleted, filesTotal, bytesCompleted, bytesTotal } = progress;
    const elapsed = now - this.startTime;
    const percentComplete = filesTotal > 0 ? Math.round((filesCompleted / filesTotal) * 100) : 0;
    const bytesPercentComplete = bytesTotal > 0 ? Math.round((bytesCompleted / bytesTotal) * 100) : 0;

    // Calculate ETA
    let etaStr = "calculating...";
    if (filesCompleted > 0 && filesCompleted < filesTotal) {
      const avgTimePerFile = elapsed / filesCompleted;
      const remainingFiles = filesTotal - filesCompleted;
      const etaMs = avgTimePerFile * remainingFiles;
      etaStr = formatDuration(etaMs);
    } else if (filesCompleted === filesTotal) {
      etaStr = "done";
    }

    // Calculate speed
    const speedStr = formatSpeed(bytesCompleted, elapsed);

    logger().info(
      `📤 Progress: ${filesCompleted}/${filesTotal} files (${percentComplete}%) | ` +
        `${formatBytes(bytesCompleted)}/${formatBytes(bytesTotal)} (${bytesPercentComplete}%) | ` +
        `${speedStr} | ETA: ${etaStr}`
    );
  }

  /**
   * Report individual file upload progress (trace level only)
   */
  reportFileProgress(fileName: string, progress: number, bytesUploaded: number, totalBytes: number): void {
    if (this.logLevel !== "trace") return;

    const percentComplete = Math.round(progress);
    logger().trace(
      `   📄 ${fileName}: ${percentComplete}% (${formatBytes(bytesUploaded)}/${formatBytes(totalBytes)})`
    );
  }

  /**
   * Report completion summary
   */
  reportCompletion(successful: number, failed: number, skipped: number): void {
    if (this.logLevel === "silent") return;

    const elapsed = Date.now() - this.startTime;
    const totalProcessed = successful + failed + skipped;

    logger().info("");
    logger().info("✅ Upload Complete!");
    logger().info(`   Successful: ${successful}`);
    if (skipped > 0) {
      logger().info(`   Skipped (duplicates): ${skipped}`);
    }
    if (failed > 0) {
      logger().info(`   Failed: ${failed}`);
    }
    logger().info(`   Total time: ${formatDuration(elapsed)}`);

    if (successful > 0) {
      const avgTimePerFile = elapsed / totalProcessed;
      logger().info(`   Average: ${formatDuration(avgTimePerFile)} per file`);
    }
  }
}
