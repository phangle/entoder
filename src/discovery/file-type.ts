/**
 * File type detection based on extensions and magic bytes
 */

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".tif",
]);

export const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".m4v",
  ".webm",
  ".3gp",
]);

export type FileType = "image" | "video" | "unsupported";

/**
 * Determine file type from extension
 */
export function getFileType(filePath: string): FileType {
  const ext = getExtension(filePath);

  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }

  if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }

  return "unsupported";
}

/**
 * Check if file is supported for upload
 */
export function isSupported(filePath: string): boolean {
  return getFileType(filePath) !== "unsupported";
}

/**
 * Get file extension (lowercase, with dot)
 */
export function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot).toLowerCase();
}

/**
 * Detect MIME type from magic bytes (optional, for verification)
 */
export async function detectMimeFromBytes(
  filePath: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const buffer = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // JPEG magic bytes
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }

    // PNG magic bytes
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }

    // GIF magic bytes
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif";
    }

    // WebP magic bytes
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }

    // MP4/M4V magic bytes (ftyp)
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return "video/mp4";
    }

    return null;
  } catch (error) {
    return null;
  }
}
