/**
 * Decryption utilities using libsodium
 */

import sodium from "libsodium-wrappers";

/**
 * Initialize libsodium (must be called before using any crypto functions)
 */
export async function initSodium(): Promise<void> {
  await sodium.ready;
}

/**
 * Decrypt data using XSalsa20-Poly1305 (crypto_secretbox_open)
 * Used for decrypting master key and secret key
 */
export function secretBoxOpen(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): Uint8Array {
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}

/**
 * Decrypt data using sealed box (crypto_box_seal_open)
 * Used for decrypting the auth token
 */
export function sealedBoxOpen(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  secretKey: Uint8Array
): Uint8Array {
  return sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
}

/**
 * Decrypt account secrets from login response
 * Returns master key, secret key, and decrypted auth token
 */
export async function decryptAccountSecrets(
  loginResponse: {
    keyAttributes: {
      encryptedKey: string;
      keyDecryptionNonce: string;
      encryptedSecretKey: string;
      secretKeyDecryptionNonce: string;
      publicKey: string;
    };
    encryptedToken: string;
  },
  keyEncryptionKey: Uint8Array
): Promise<{
  masterKey: Uint8Array;
  secretKey: Uint8Array;
  token: string;
}> {
  await initSodium();

  // Step 1: Decrypt master key using KEK
  const encryptedKey = Buffer.from(loginResponse.keyAttributes.encryptedKey, "base64");
  const keyNonce = Buffer.from(loginResponse.keyAttributes.keyDecryptionNonce, "base64");
  const masterKey = secretBoxOpen(encryptedKey, keyNonce, keyEncryptionKey);

  // Step 2: Decrypt secret key using master key
  const encryptedSecretKey = Buffer.from(
    loginResponse.keyAttributes.encryptedSecretKey,
    "base64"
  );
  const secretKeyNonce = Buffer.from(
    loginResponse.keyAttributes.secretKeyDecryptionNonce,
    "base64"
  );
  const secretKey = secretBoxOpen(encryptedSecretKey, secretKeyNonce, masterKey);

  // Step 3: Decrypt token using public/secret key pair (sealed box)
  const encryptedToken = Buffer.from(loginResponse.encryptedToken, "base64");
  const publicKey = Buffer.from(loginResponse.keyAttributes.publicKey, "base64");

  const tokenBytes = sealedBoxOpen(encryptedToken, publicKey, secretKey);

  // Token is binary data - encode as URL-safe base64 for HTTP header
  // This matches Ente's web implementation (toB64URLSafe)
  const token = sodium.to_base64(tokenBytes, sodium.base64_variants.URLSAFE);

  return {
    masterKey,
    secretKey,
    token,
  };
}
