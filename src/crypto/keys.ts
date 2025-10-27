/**
 * Cryptographic key derivation matching Ente's scheme
 */

import { argon2id } from "@noble/hashes/argon2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

const LOGIN_SUB_KEY_LENGTH = 32;
const LOGIN_SUB_KEY_ID = 1;
const LOGIN_SUB_KEY_CONTEXT = "loginctx";

/**
 * Derive key encryption key (KEK) from password using Argon2
 * Matches Go's argon2.IDKey(password, salt, opsLimit, memLimit/1024, 1, 32)
 */
export async function deriveKeyEncryptionKey(
  password: string,
  kekSalt: string,
  memLimit: number,
  opsLimit: number
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const saltBytes = Buffer.from(kekSalt, "base64");

  // Use @noble/hashes argon2id (pure JS, works with compiled binaries)
  // Matches Go's argon2.IDKey(password, salt, opsLimit, memLimit/1024, 1, 32)
  const hash = argon2id(passwordBytes, saltBytes, {
    t: opsLimit,           // time cost (iterations)
    m: memLimit / 1024,    // memory cost in KiB
    p: 1,                  // parallelism
    dkLen: 32,             // output length in bytes
  });

  return hash;
}

/**
 * Derive login key from key encryption key using BLAKE2b subkey derivation
 * This matches Ente's crypto_kdf_derive_from_key implementation
 */
export function deriveLoginKey(keyEncKey: Uint8Array): Uint8Array {
  const subKey = deriveSubKey(
    keyEncKey,
    LOGIN_SUB_KEY_CONTEXT,
    LOGIN_SUB_KEY_ID,
    LOGIN_SUB_KEY_LENGTH
  );
  // Return the first 16 bytes of the derived key
  return subKey.slice(0, 16);
}

/**
 * Derive a subkey using BLAKE2b with personalization and salt
 * This matches libsodium's crypto_kdf_derive_from_key
 */
function deriveSubKey(
  masterKey: Uint8Array,
  context: string,
  subKeyId: number,
  subKeyLength: number
): Uint8Array {
  // Pad context to 16 bytes (BLAKE2b personalization size)
  const contextBytes = new Uint8Array(16);
  const contextEncoded = new TextEncoder().encode(context);
  contextBytes.set(contextEncoded.slice(0, 16));

  // Create salt with subKeyId (16 bytes for BLAKE2b)
  const salt = new Uint8Array(16);
  const view = new DataView(salt.buffer);
  view.setBigUint64(0, BigInt(subKeyId), true); // Little-endian

  // BLAKE2b with key, salt, and personalization
  const hash = blake2b.create({
    dkLen: subKeyLength,
    key: masterKey,
    salt: salt,
    personalization: contextBytes,
  });

  return hash.digest();
}

/**
 * Derive master encryption key from password and key attributes
 * This follows Ente's key derivation scheme using Argon2 or PBKDF2
 */
export async function deriveMasterKey(
  password: string,
  kekSalt: string,
  memLimit: number,
  opsLimit: number
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const saltBytes = Buffer.from(kekSalt, "base64");

  // Ente uses either Argon2 or PBKDF2 depending on memLimit/opsLimit
  // For now, implement PBKDF2 version (more compatible)
  // In production, you'd want to match Ente's exact Argon2 parameters

  const iterations = opsLimit;
  const keyLength = 32; // 256 bits

  const derivedKey = pbkdf2(sha256, passwordBytes, saltBytes, {
    c: iterations,
    dkLen: keyLength,
  });

  return derivedKey;
}

/**
 * Decrypt the master key using the KEK (Key Encryption Key)
 */
export async function decryptMasterKey(
  kek: Uint8Array,
  encryptedKey: string,
  nonce: string
): Promise<string> {
  // This requires libsodium for XSalsa20-Poly1305 decryption
  // For now, return a placeholder
  // TODO: Implement with proper crypto library
  throw new Error("Master key decryption not yet implemented - requires libsodium");
}

/**
 * Generate a random key
 */
export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Hash a file for deduplication
 */
export async function hashFile(data: Uint8Array): Promise<string> {
  const hash = sha256(data);
  return Buffer.from(hash).toString("base64");
}
