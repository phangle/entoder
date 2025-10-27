/**
 * Collection types matching Ente API
 */

export interface CollectionKey {
  encryptedData: string; // Base64
  nonce: string; // Base64
}

export interface CreateCollectionRequest {
  encryptedKey: string; // Collection key encrypted with master key
  keyDecryptionNonce: string;
  encryptedName: string; // Collection name encrypted with collection key
  nameDecryptionNonce: string;
  type: "album" | "folder" | "favorites" | "uncategorized";
}

export interface EnteCollection {
  id: number;
  owner: {
    id: number;
    email: string;
  };
  encryptedKey: string;
  keyDecryptionNonce: string;
  encryptedName: string;
  nameDecryptionNonce: string;
  type: string;
  attributes: Record<string, any>;
  sharees: any[];
  updationTime: number;
  isDeleted: boolean;
}

export interface DecryptedCollection {
  id: number;
  name: string;
  key: string; // Decrypted collection key (base64)
  type: string;
  ownerId: number;
}
