#!/usr/bin/env bun

import { Command } from "commander";
import { uploadCommand } from "./commands/upload";
import { uploadCommandStreaming } from "./commands/upload-streaming";
import { verifyCommand } from "./commands/verify";
import { createLogger, setLogger, type LogLevel } from "./utils/logger";
import { getNativeIOStats } from "./utils/native-io";
import packageJson from "../package.json";

const program = new Command();

/**
 * Get option value with environment variable fallback
 */
function getOptionWithEnv(
  cliValue: any,
  envVar: string,
  defaultValue?: any
): any {
  if (cliValue !== undefined) return cliValue;
  const envValue = process.env[envVar];
  if (envValue !== undefined) return envValue;
  return defaultValue;
}

program
  .name("entoder")
  .description("CLI tool to upload photos to Ente Photos server")
  .version(packageJson.version);

program
  .command("upload")
  .description("Upload photos from local directories")
  .argument("<paths...>", "Directory paths to upload")
  .option(
    "--email <email>",
    "Ente account email (env: ENTE_EMAIL)"
  )
  .option(
    "--password <password>",
    "Ente account password (env: ENTE_PASSWORD)"
  )
  .option(
    "--api-server <url>",
    "Ente API server URL (env: ENTE_API_SERVER)"
  )
  .option(
    "--concurrency <number>",
    "Number of parallel uploads (env: ENTE_CONCURRENCY)",
    "3"
  )
  .option(
    "--dry-run",
    "Simulate upload without actually uploading (env: ENTE_DRY_RUN)",
    false
  )
  .option(
    "--log-level <level>",
    "Log level: trace, debug, info, warn, error, fatal, silent (env: LOG_LEVEL)",
    "info"
  )
  .option(
    "--no-streaming",
    "Disable streaming mode (buffered mode: scan all files before uploading)"
  )
  .option(
    "--skip-sync",
    "Skip syncing existing files from Ente server (faster startup, but may miss server-side changes)",
    false
  )
  .option(
    "--batch-size <number>",
    "Files to buffer before processing (streaming mode only)",
    "50"
  )
  .option(
    "--max-queue-size <number>",
    "Maximum pending files in memory (streaming mode only)",
    "200"
  )
  .option(
    "--max-memory-mb <number>",
    "Maximum memory budget in MB for concurrent uploads (streaming mode only, default: 50% of system RAM, max 4GB)",
    undefined
  )
  .action(async (paths: string[], options: any) => {
    try {
      // Resolve options with environment variable fallbacks
      const email = getOptionWithEnv(options.email, "ENTE_EMAIL");
      const password = getOptionWithEnv(options.password, "ENTE_PASSWORD");
      let apiServer = getOptionWithEnv(
        options.apiServer,
        "ENTE_API_SERVER",
        "https://api.ente.io"
      );
      // Add https:// prefix if missing
      if (apiServer && !apiServer.startsWith("http://") && !apiServer.startsWith("https://")) {
        apiServer = `https://${apiServer}`;
      }
      const concurrency = parseInt(
        getOptionWithEnv(options.concurrency, "ENTE_CONCURRENCY", "3")
      );
      const dryRun =
        options.dryRun || process.env.ENTE_DRY_RUN === "true" || process.env.ENTE_DRY_RUN === "1";
      const logLevel = getOptionWithEnv(options.logLevel, "LOG_LEVEL", "info");
      const streaming = options.streaming !== false; // Default to true (streaming mode)
      const skipSync = options.skipSync || false;
      const batchSize = parseInt(options.batchSize || "50");
      const maxQueueSize = parseInt(options.maxQueueSize || "200");
      const maxMemoryMB = options.maxMemoryMb ? parseInt(options.maxMemoryMb) : undefined;

      // Validate required options (before logger initialization)
      if (!email) {
        console.error(
          "❌ Error: Email is required. Provide via --email or ENTE_EMAIL environment variable."
        );
        process.exit(1);
      }

      // Validate log level
      const validLogLevels: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
      if (!validLogLevels.includes(logLevel as LogLevel)) {
        // This error occurs before logger is initialized, so we can use console.error
        console.error(
          `❌ Error: Invalid log level "${logLevel}". Must be one of: ${validLogLevels.join(", ")}`
        );
        process.exit(1);
      }

      // Initialize logger (this will print the log file path to console)
      const logger = await createLogger({
        level: logLevel as LogLevel,
      });

      // Set as global logger for all modules to use
      setLogger(logger);

      // Log native I/O optimization status (debug level)
      const ioStats = getNativeIOStats();
      if (ioStats.available) {
        logger.debug(ioStats.features, "Native I/O optimizations enabled:");
      } else {
        logger.debug("Native I/O optimizations not available (using fallback)");
      }

      // Choose upload strategy based on mode
      if (streaming) {
        await uploadCommandStreaming(paths, {
          email,
          password,
          apiServer,
          concurrency,
          dryRun,
          skipSync,
          logger,
          batchSize,
          maxQueueSize,
          maxMemoryMB,
        });
      } else {
        await uploadCommand(paths, {
          email,
          password,
          apiServer,
          concurrency,
          dryRun,
          logger,
        });
      }
    } catch (error) {
      // If we have a logger at this point, use it; otherwise fall back to console
      if (error instanceof Error) {
        console.error("\n❌ Error:", error.message);
      } else {
        console.error("\n❌ Error:", error);
      }
      process.exit(1);
    }
  });

program
  .command("verify")
  .description("Verify and detect duplicate files on Ente server")
  .option(
    "--email <email>",
    "Ente account email (env: ENTE_EMAIL)"
  )
  .option(
    "--password <password>",
    "Ente account password (env: ENTE_PASSWORD)"
  )
  .option(
    "--api-server <url>",
    "Ente API server URL (env: ENTE_API_SERVER)"
  )
  .option(
    "--log-level <level>",
    "Log level: trace, debug, info, warn, error, fatal, silent (env: LOG_LEVEL)",
    "info"
  )
  .option(
    "--fix",
    "Automatically delete duplicate files (moves to trash)",
    false
  )
  .option(
    "--yes",
    "Skip confirmation prompt (use with --fix for automatic deletion)",
    false
  )
  .action(async (options: any) => {
    try {
      // Resolve options with environment variable fallbacks
      const email = getOptionWithEnv(options.email, "ENTE_EMAIL");
      const password = getOptionWithEnv(options.password, "ENTE_PASSWORD");
      let apiServer = getOptionWithEnv(
        options.apiServer,
        "ENTE_API_SERVER",
        "https://api.ente.io"
      );
      // Add https:// prefix if missing
      if (apiServer && !apiServer.startsWith("http://") && !apiServer.startsWith("https://")) {
        apiServer = `https://${apiServer}`;
      }
      const logLevel = getOptionWithEnv(
        options.logLevel,
        "LOG_LEVEL",
        "info"
      ) as LogLevel;

      // Initialize logger
      const logger = await createLogger({ level: logLevel });
      setLogger(logger);

      // Run verify command
      await verifyCommand({
        email,
        password,
        apiServer,
        logLevel,
        fix: options.fix,
        yes: options.yes,
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error("\n❌ Error:", error.message);
      } else {
        console.error("\n❌ Error:", error);
      }
      process.exit(1);
    }
  });

program.parse();
