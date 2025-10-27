/**
 * Types for syncing files from Ente server
 */

export interface EnteFile {
  id: number;
  collectionID: number;
  ownerID: number;
  file: {
    objectKey: string;
    decryptionHeader: string;
  };
  thumbnail: {
    objectKey: string;
    decryptionHeader: string;
  };
  metadata: {
    encryptedData: string;
    decryptionHeader: string;
  };
  encryptedKey: string;
  keyDecryptionNonce: string;
  isDeleted: boolean;
  updationTime: number;
  magicMetadata?: {
    data: string;
    header: string;
  };
  pubMagicMetadata?: {
    data: string;
    header: string;
  };
}

export interface CollectionDiffResponse {
  diff: EnteFile[];
  hasMore: boolean;
}

export interface DecryptedFileMetadata {
  title: string;
  creationTime: number;
  modificationTime: number;
  latitude?: number;
  longitude?: number;
  fileType: number;
  hash?: string; // SHA256 hash for deduplication
  imageHash?: string; // Legacy: for live photos
  videoHash?: string; // Legacy: for live photos
  fileSize?: number; // File size in bytes
  duration?: number; // Video duration in seconds
}
