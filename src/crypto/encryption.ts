/**
 * Encryption utilities using libsodium (matching Ente's encryption scheme)
 */

import sodium from "libsodium-wrappers";

// Ensure sodium is ready before use
let sodiumReady = false;

export async function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
}

/**
 * Generate a random encryption key
 */
export async function generateKey(): Promise<Uint8Array> {
  await ensureSodium();
  return sodium.crypto_secretbox_keygen();
}

/**
 * Encrypt data with a key (secretbox - XSalsa20-Poly1305)
 */
export async function encryptBox(
  data: Uint8Array,
  key: Uint8Array
): Promise<{ encryptedData: string; nonce: string }> {
  await ensureSodium();

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(data, nonce, key);

  return {
    encryptedData: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

/**
 * Decrypt data with a key (secretbox)
 */
export async function decryptBox(
  encryptedData: string,
  nonce: string,
  key: Uint8Array
): Promise<Uint8Array> {
  await ensureSodium();

  const encrypted = sodium.from_base64(encryptedData, sodium.base64_variants.ORIGINAL);
  const nonceBytes = sodium.from_base64(nonce, sodium.base64_variants.ORIGINAL);

  const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonceBytes, key);

  if (!decrypted) {
    throw new Error("Decryption failed");
  }

  return decrypted;
}

/**
 * Encrypt with master key (for collection keys)
 */
export async function encryptWithMasterKey(
  data: Uint8Array,
  masterKey: Uint8Array
): Promise<{ encryptedData: string; nonce: string }> {
  return encryptBox(data, masterKey);
}

/**
 * Decrypt with master key
 */
export async function decryptWithMasterKey(
  encryptedData: string,
  nonce: string,
  masterKey: Uint8Array
): Promise<Uint8Array> {
  return decryptBox(encryptedData, nonce, masterKey);
}

/**
 * Convert string to Uint8Array
 */
export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to string
 */
export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Convert Uint8Array to base64
 */
export async function toBase64(bytes: Uint8Array): Promise<string> {
  await ensureSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/**
 * Convert base64 to Uint8Array
 */
export async function fromBase64(base64: string): Promise<Uint8Array> {
  await ensureSodium();
  return sodium.from_base64(base64, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypt streaming encrypted data (secretstream)
 * Used for decrypting file metadata, thumbnails, and file data
 */
export async function decryptStream(
  encryptedData: string,
  decryptionHeader: string,
  key: Uint8Array
): Promise<Uint8Array> {
  await ensureSodium();

  const encrypted = sodium.from_base64(encryptedData, sodium.base64_variants.ORIGINAL);
  const header = sodium.from_base64(decryptionHeader, sodium.base64_variants.ORIGINAL);

  // Initialize decryption
  const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);

  // Pull (decrypt) the data
  const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, encrypted);

  if (!result) {
    throw new Error("Stream decryption failed");
  }

  return result.message;
}
