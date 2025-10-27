/**
 * Thumbnail generation for images and videos
 * Uses ffmpeg for cross-platform compatibility (no native modules)
 */

import { logger } from "../utils/logger";
import { getFileType } from "../discovery/file-type";

const THUMBNAIL_MAX_DIMENSION = 320; // Ente's thumbnail size
const THUMBNAIL_QUALITY = 80;

/**
 * Generate thumbnail for image using ffmpeg
 * Uses ffmpeg instead of sharp to avoid native module dependencies
 */
export async function generateImageThumbnail(
  filePath: string
): Promise<Uint8Array> {
  try {
    // Use ffmpeg for image resizing (works cross-platform, no native modules)
    const proc = Bun.spawn([
      "ffmpeg",
      "-i", filePath,
      "-vf", `scale='min(${THUMBNAIL_MAX_DIMENSION},iw)':'min(${THUMBNAIL_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "2", // JPEG quality (2-31, lower is better, ~80% quality)
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-"
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).arrayBuffer();
    await proc.exited;

    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logger().warn(`ffmpeg failed for ${filePath}: ${stderr}`);
      return generateFallbackThumbnail();
    }

    const thumbnail = new Uint8Array(stdout);

    // Verify we got valid JPEG data
    if (thumbnail.length < 100 || thumbnail[0] !== 0xff || thumbnail[1] !== 0xd8) {
      logger().warn(`Invalid thumbnail data for ${filePath}`);
      return generateFallbackThumbnail();
    }

    return thumbnail;
  } catch (error) {
    logger().warn({ error }, `Failed to generate thumbnail for ${filePath}:`);
    return generateFallbackThumbnail();
  }
}

/**
 * Generate thumbnail for video using ffmpeg
 * Extracts a frame from 1 second into the video
 */
export async function generateVideoThumbnail(
  filePath: string
): Promise<Uint8Array> {
  try {
    // Use ffmpeg to extract a frame at 1 second
    // Output to stdout as JPEG
    const proc = Bun.spawn([
      "ffmpeg",
      "-i", filePath,
      "-ss", "1", // Seek to 1 second
      "-vframes", "1", // Extract 1 frame
      "-vf", `scale='min(${THUMBNAIL_MAX_DIMENSION},iw)':'min(${THUMBNAIL_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`, // Resize
      "-q:v", "2", // JPEG quality (2-31, lower is better)
      "-f", "image2pipe", // Output to pipe
      "-vcodec", "mjpeg",
      "-"
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).arrayBuffer();

    // Wait for process to complete
    await proc.exited;

    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logger().warn(`ffmpeg failed for ${filePath}: ${stderr}`);
      return generateFallbackThumbnail();
    }

    // Convert stdout to Uint8Array
    const thumbnail = new Uint8Array(stdout);

    // Verify we got valid JPEG data (should start with FF D8)
    if (thumbnail.length < 100 || thumbnail[0] !== 0xff || thumbnail[1] !== 0xd8) {
      logger().warn(`Invalid thumbnail data for ${filePath}`);
      return generateFallbackThumbnail();
    }

    return thumbnail;
  } catch (error) {
    logger().warn({ error }, `Failed to generate video thumbnail for ${filePath}:`);
    return generateFallbackThumbnail();
  }
}

/**
 * Generate thumbnail based on file type
 */
export async function generateThumbnail(filePath: string): Promise<Uint8Array> {
  const fileType = getFileType(filePath);

  if (fileType === "image") {
    return generateImageThumbnail(filePath);
  } else if (fileType === "video") {
    return generateVideoThumbnail(filePath);
  }

  return generateFallbackThumbnail();
}

/**
 * Generate a fallback black thumbnail
 */
export function generateFallbackThumbnail(): Uint8Array {
  // Create a 32x32 black JPEG
  const width = 32;
  const height = 32;

  // Create black image data
  const pixels = Buffer.alloc(width * height * 3);
  pixels.fill(0); // Black

  // Convert to JPEG using sharp
  return new Uint8Array(
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ])
  );
}

/**
 * Get thumbnail dimensions from JPEG data
 * Parses JPEG headers instead of using sharp (avoids native modules)
 */
export async function getThumbnailDimensions(
  thumbnail: Uint8Array
): Promise<{ width: number; height: number }> {
  try {
    // Parse JPEG markers to find SOF (Start of Frame)
    // JPEG format: FF D8 (SOI) ... FF C0/C2 (SOF) ... FF D9 (EOI)
    let offset = 2; // Skip SOI marker (FF D8)

    while (offset < thumbnail.length - 1) {
      // Find next marker (FF XX)
      if (thumbnail[offset] !== 0xff) {
        offset++;
        continue;
      }

      const marker = thumbnail[offset + 1];

      // SOF markers: C0, C1, C2, C3, C5, C6, C7, C9, CA, CB, CD, CE, CF
      if ((marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)) {
        // SOF format: FF CX LL LL P YY YY XX XX
        // Where YY YY is height and XX XX is width (big-endian)
        const height = (thumbnail[offset + 5] << 8) | thumbnail[offset + 6];
        const width = (thumbnail[offset + 7] << 8) | thumbnail[offset + 8];
        return { width, height };
      }

      // Skip to next marker (marker length is in next 2 bytes, big-endian)
      const length = (thumbnail[offset + 2] << 8) | thumbnail[offset + 3];
      offset += 2 + length;
    }

    return { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}
