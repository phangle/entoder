/**
 * Collection management service
 */

import { logger } from "../utils/logger";
import { APIClient } from "../api/client";
import { DatabaseManager } from "../db";
import {
  generateKey,
  encryptBox,
  decryptBox,
  stringToBytes,
  bytesToString,
  toBase64,
  fromBase64,
} from "../crypto/encryption";
import type {
  CreateCollectionRequest,
  EnteCollection,
  DecryptedCollection,
} from "./types";
import { directoryToCollectionName } from "./naming";

export class CollectionService {
  constructor(
    private client: APIClient,
    private db: DatabaseManager,
    private authToken: string,
    private masterKey: Uint8Array
  ) {}

  /**
   * Create a new collection on Ente
   */
  async createCollection(
    name: string,
    type: "album" | "folder" = "album"
  ): Promise<DecryptedCollection> {
    // Generate collection key
    const collectionKey = await generateKey();

    // Encrypt collection key with master key
    const { encryptedData: encryptedKey, nonce: keyDecryptionNonce } =
      await encryptBox(collectionKey, this.masterKey);

    // Encrypt collection name with collection key
    const nameBytes = stringToBytes(name);
    const { encryptedData: encryptedName, nonce: nameDecryptionNonce } =
      await encryptBox(nameBytes, collectionKey);

    const request: CreateCollectionRequest = {
      encryptedKey,
      keyDecryptionNonce,
      encryptedName,
      nameDecryptionNonce,
      type,
    };

    // Make API call
    const response = await this.client.post<{ collection: EnteCollection }>(
      "/collections",
      request,
      {
        headers: {
          "X-Auth-Token": this.authToken,
        },
      }
    );

    return {
      id: response.collection.id,
      name,
      key: await toBase64(collectionKey),
      type: response.collection.type,
      ownerId: response.collection.owner.id,
    };
  }

  /**
   * Fetch all collections from Ente
   */
  async fetchCollections(): Promise<DecryptedCollection[]> {
    const response = await this.client.get<{ collections: EnteCollection[] }>(
      "/collections/v2",
      {
        headers: {
          "X-Auth-Token": this.authToken,
        },
      }
    );

    const decrypted: DecryptedCollection[] = [];

    for (const collection of response.collections) {
      if (collection.isDeleted) continue;

      try {
        // Decrypt collection key
        const collectionKey = await decryptBox(
          collection.encryptedKey,
          collection.keyDecryptionNonce,
          this.masterKey
        );

        // Decrypt collection name
        const nameBytes = await decryptBox(
          collection.encryptedName,
          collection.nameDecryptionNonce,
          collectionKey
        );

        const name = bytesToString(nameBytes);

        decrypted.push({
          id: collection.id,
          name,
          key: await toBase64(collectionKey),
          type: collection.type,
          ownerId: collection.owner.id,
        });
      } catch (error) {
        // Silently skip collections we can't decrypt
        // This can happen with shared collections or collections from other devices
        continue;
      }
    }

    return decrypted;
  }

  /**
   * Get a collection by its Ente ID
   */
  async getCollectionById(id: number): Promise<DecryptedCollection | null> {
    const collections = await this.fetchCollections();
    return collections.find((c) => c.id === id) || null;
  }

  /**
   * Get or create collection for a directory path
   */
  async getOrCreateCollectionForDirectory(
    directoryPath: string
  ): Promise<DecryptedCollection> {
    // Check database cache first
    const cached = this.db.getCollectionByPath(directoryPath);
    if (cached && cached.ente_collection_id !== null) {
      // Fetch remote collections to get the key
      const remoteCollections = await this.fetchCollections();
      const remoteCollection = remoteCollections.find(c => c.id === cached.ente_collection_id);

      if (remoteCollection) {
        return remoteCollection;
      }
    }

    // Get existing collection names to avoid duplicates
    // Only consider collections that already exist on Ente (not local-only or placeholders)
    const allCollections = this.db.getAllCollections();
    const existingNames = new Set(
      allCollections
        .filter((c) => c.ente_collection_id !== null && !c.directory_path.startsWith("<remote:"))
        .map((c) => c.collection_name)
    );

    // Generate collection name
    const collectionName = directoryToCollectionName(
      directoryPath,
      existingNames
    );

    // Check if a collection with this name already exists on Ente
    const remoteCollections = await this.fetchCollections();
    const existingRemote = remoteCollections.find(c => c.name === collectionName);

    if (existingRemote) {
      // Collection already exists on Ente, use it
      logger().info(`   Found existing remote collection: ${collectionName}`);

      // Update database with Ente collection ID
      if (cached) {
        this.db.updateCollectionEnteID(cached.id, existingRemote.id);
      } else {
        this.db.createCollection(
          existingRemote.id,
          directoryPath,
          existingRemote.name
        );
      }

      return existingRemote;
    }

    // Create collection on Ente
    const created = await this.createCollection(collectionName, "album");

    // Update database with Ente collection ID (instead of creating new entry)
    if (cached) {
      // Collection exists in DB, just update the Ente ID
      this.db.updateCollectionEnteID(cached.id, created.id);
    } else {
      // Collection doesn't exist in DB, create it
      this.db.createCollection(
        created.id,
        directoryPath,
        created.name
      );
    }

    return created;
  }

  /**
   * Sync collections from Ente to local database
   */
  async syncCollections(): Promise<void> {
    const remoteCollections = await this.fetchCollections();

    for (const collection of remoteCollections) {
      // Check if already in database
      const existing = this.db.getAllCollections().find(
        (c) => c.ente_collection_id === collection.id
      );

      if (!existing) {
        // Add to database with unknown directory path
        this.db.createCollection(
          collection.id,
          `<remote:${collection.id}>`,
          collection.name
        );
      }
    }
  }
}
