/**
 * Centralized logging utility
 * Writes to both console (with pretty formatting) and file (JSON format)
 * Implements log rotation at 50MB to prevent disk space issues
 */

import pino from "pino";
import { createStream } from "rotating-file-stream";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { homedir, platform } from "os";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Get the default log directory based on OS
 */
function getDefaultLogDirectory(): string {
  const p = platform();

  if (p === "darwin") {
    // macOS: ~/Library/Logs/entoder
    return join(homedir(), "Library", "Logs", "entoder");
  } else if (p === "win32") {
    // Windows: %LOCALAPPDATA%\entoder\logs
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "entoder", "logs");
  } else {
    // Linux/Unix: ~/.local/share/entoder/logs
    return join(homedir(), ".local", "share", "entoder", "logs");
  }
}

/**
 * Ensure log directory exists
 */
async function ensureLogDirectory(logDir: string): Promise<string> {
  try {
    await mkdir(logDir, { recursive: true });
    return logDir;
  } catch (error) {
    // If we can't create the default log directory, fall back to current directory
    console.warn(`Warning: Could not create log directory at ${logDir}, falling back to current directory`);
    const fallbackDir = join(process.cwd(), "logs");
    await mkdir(fallbackDir, { recursive: true });
    return fallbackDir;
  }
}

/**
 * Create a rotating log stream
 * Rotates at 50MB, keeps max 10 files (500MB total)
 */
function createRotatingStream(logDir: string) {
  return createStream("entoder.log", {
    size: "50M",        // Rotate at 50MB
    maxFiles: 10,       // Keep max 10 files (500MB total)
    interval: "1d",     // Also rotate daily
    compress: "gzip",   // Compress old logs
    path: logDir,
  });
}

/**
 * Create logger instance with both console and file output
 */
export async function createLogger(options: {
  level?: LogLevel;
  logDir?: string;
  enableFileLogging?: boolean;
} = {}): Promise<pino.Logger> {
  const level = options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? "info";
  const enableFileLogging = options.enableFileLogging ?? true;

  // Determine log directory
  let logDir = options.logDir ?? getDefaultLogDirectory();
  let rotatingStream: any = null;

  if (enableFileLogging) {
    try {
      logDir = await ensureLogDirectory(logDir);
      rotatingStream = createRotatingStream(logDir);

      // Only log to console if we successfully created the rotating stream
      // This is the ONE exception where we use console.log
      console.log(`📝 Logs: ${join(logDir, "entoder.log")} (rotates at 50MB, max 10 files)\n`);
    } catch (error) {
      console.warn(`Warning: Could not set up file logging: ${error}`);
    }
  }

  // Create logger with multistream - console (pretty) + file (JSON, rotating)
  const streams: pino.StreamEntry[] = [
    {
      level,
      stream: pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }),
    },
  ];

  // Add rotating file stream if enabled and available
  if (enableFileLogging && rotatingStream) {
    streams.push({
      level,
      stream: rotatingStream,
    });
  }

  return pino(
    {
      level,
    },
    pino.multistream(streams)
  );
}

/**
 * Global logger instance (lazy-initialized)
 */
let globalLogger: pino.Logger | null = null;

/**
 * Get or create the global logger instance
 */
export async function getLogger(): Promise<pino.Logger> {
  if (!globalLogger) {
    globalLogger = await createLogger();
  }
  return globalLogger;
}

/**
 * Set the global logger instance
 */
export function setLogger(logger: pino.Logger): void {
  globalLogger = logger;
}

/**
 * Get the current logger instance (synchronous)
 * Throws if logger hasn't been initialized yet
 */
export function logger(): pino.Logger {
  if (!globalLogger) {
    throw new Error("Logger not initialized. Call createLogger() or setLogger() first.");
  }
  return globalLogger;
}
