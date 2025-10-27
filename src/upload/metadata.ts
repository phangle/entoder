/**
 * File metadata extraction (EXIF, video metadata, etc.)
 */

import ExifReader from "exifreader";
import { getFileType } from "../discovery/file-type";
import { logger } from "../utils/logger";

export interface FileMetadata {
  title: string;
  creationTime: number; // Epoch microseconds
  modificationTime: number; // Epoch microseconds
  latitude?: number;
  longitude?: number;
  width?: number;
  height?: number;
  duration?: number; // For videos, in seconds
  fileType: 0 | 1; // 0 = image, 1 = video (matches Ente FileType enum)
  hash?: string; // File hash (added during upload pipeline)
}

/**
 * Extract metadata from image file
 */
export async function extractImageMetadata(
  filePath: string,
  fileMtime: number
): Promise<FileMetadata> {
  const metadata: FileMetadata = {
    title: filePath.split("/").pop() || "untitled",
    creationTime: fileMtime * 1000, // Convert ms to µs
    modificationTime: fileMtime * 1000,
    fileType: 0, // 0 = image
  };

  try {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();
    // Suppress DOMParser warning by explicitly excluding XMP tags
    // XMP parsing requires DOMParser (not available in Bun CLI runtime)
    // Standard EXIF, GPS, and file metadata still works fine
    const tags = ExifReader.load(buffer as any, {
      expanded: true,
      includeUnknown: false,
      async: false,
    });

    // Extract creation date
    if (tags.exif?.DateTimeOriginal) {
      const dateStr = tags.exif.DateTimeOriginal.description;
      const date = parseExifDate(dateStr);
      if (date) {
        metadata.creationTime = date.getTime() * 1000; // Convert ms to µs
      }
    } else if (tags.exif?.DateTime) {
      const dateStr = tags.exif.DateTime.description;
      const date = parseExifDate(dateStr);
      if (date) {
        metadata.creationTime = date.getTime() * 1000;
      }
    }

    // Extract GPS coordinates
    if (tags.gps?.Latitude && tags.gps?.Longitude) {
      const gpsAny = tags.gps as any;
      metadata.latitude = convertGPSToDecimal(
        tags.gps.Latitude,
        (gpsAny.LatitudeRef?.value?.[0] as string | undefined) ?? "N"
      );
      metadata.longitude = convertGPSToDecimal(
        tags.gps.Longitude,
        (gpsAny.LongitudeRef?.value?.[0] as string | undefined) ?? "E"
      );
    }

    // Extract dimensions
    if (tags.file?.["Image Width"]) {
      metadata.width = tags.file["Image Width"].value;
    }
    if (tags.file?.["Image Height"]) {
      metadata.height = tags.file["Image Height"].value;
    }
  } catch (error) {
    logger().warn({ error }, `Failed to extract EXIF from ${filePath}:`);
  }

  return metadata;
}

/**
 * Extract metadata from video file
 * Note: This is a basic implementation. For production, use ffmpeg or similar
 */
export async function extractVideoMetadata(
  filePath: string,
  fileMtime: number
): Promise<FileMetadata> {
  const metadata: FileMetadata = {
    title: filePath.split("/").pop() || "untitled",
    creationTime: fileMtime * 1000,
    modificationTime: fileMtime * 1000,
    fileType: 1, // 1 = video
  };

  // TODO: Implement proper video metadata extraction
  // Would require ffmpeg or similar tool
  // For now, just use file modification time

  return metadata;
}

/**
 * Extract metadata based on file type
 */
export async function extractMetadata(
  filePath: string,
  fileMtime: number
): Promise<FileMetadata> {
  const fileType = getFileType(filePath);

  if (fileType === "image") {
    return extractImageMetadata(filePath, fileMtime);
  } else if (fileType === "video") {
    return extractVideoMetadata(filePath, fileMtime);
  }

  throw new Error(`Unsupported file type for ${filePath}`);
}

/**
 * Parse EXIF date string (format: "YYYY:MM:DD HH:MM:SS")
 */
function parseExifDate(dateStr: string): Date | null {
  try {
    const [datePart, timePart] = dateStr.split(" ");
    const [year, month, day] = datePart.split(":").map(Number);
    const [hour, minute, second] = timePart.split(":").map(Number);

    return new Date(year, month - 1, day, hour, minute, second);
  } catch {
    return null;
  }
}

/**
 * Convert GPS coordinates from degrees/minutes/seconds to decimal
 */
function convertGPSToDecimal(
  coordinate: any,
  direction: string
): number | undefined {
  try {
    const degrees = coordinate.description;
    let decimal = parseFloat(degrees);

    if (direction === "S" || direction === "W") {
      decimal = -decimal;
    }

    return decimal;
  } catch {
    return undefined;
  }
}
