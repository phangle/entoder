/**
 * Authentication types matching Ente API
 */

// SRP Authentication Types
export interface SRPAttributes {
  srpUserID: string;
  srpSalt: string;
  memLimit: number;
  opsLimit: number;
  kekSalt: string;
  isEmailMFAEnabled: boolean;
}

export interface CreateSRPSessionRequest {
  srpUserID: string;
  srpA: string; // Base64 encoded
}

export interface CreateSRPSessionResponse {
  sessionID: string;
  srpB: string; // Base64 encoded
}

export interface VerifySRPSessionRequest {
  srpUserID: string;
  sessionID: string;
  srpM1: string; // Base64 encoded
}

export interface LoginResponse {
  id: number;
  keyAttributes: KeyAttributes;
  encryptedToken: string;
  token: string;
  twoFactorSessionID?: string;
  srpM2?: string; // SRP server proof
}

export interface KeyAttributes {
  kekSalt: string;
  encryptedKey: string;
  keyDecryptionNonce: string;
  publicKey: string;
  encryptedSecretKey: string;
  secretKeyDecryptionNonce: string;
  memLimit: number;
  opsLimit: number;
}

export interface Session {
  email: string;
  token: string;
  userId: number;
  masterKey: string; // Base64 encoded
  expiresAt: number;
}
