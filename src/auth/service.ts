/**
 * Authentication service for Ente API with SRP support
 */

import { APIClient } from "../api/client";
import { deriveKeyEncryptionKey, deriveLoginKey } from "../crypto/keys";
import { decryptAccountSecrets } from "../crypto/decrypt";
import { SRP, SrpClient } from "fast-srp-hap";
import type {
  SRPAttributes,
  CreateSRPSessionResponse,
  LoginResponse,
  Session,
} from "./types";

export class AuthenticationService {
  constructor(private client: APIClient) {}

  /**
   * Login to Ente with email and password using SRP protocol
   * Returns decrypted token, master key, and user ID
   */
  async login(
    email: string,
    password: string
  ): Promise<{ token: string; masterKey: Uint8Array; userId: number }> {
    try {
      // Step 1: Get SRP attributes
      const srpAttr = await this.getSRPAttributes(email);

      // Step 2: Derive key encryption key from password
      const keyEncKey = await deriveKeyEncryptionKey(
        password,
        srpAttr.kekSalt,
        srpAttr.memLimit,
        srpAttr.opsLimit
      );

      // Step 3: Derive login key (16 bytes) for SRP
      const loginKey = deriveLoginKey(keyEncKey);

      // Step 4: Initialize SRP client with 4096-bit group
      const srpSalt = Buffer.from(srpAttr.srpSalt, "base64");
      const identity = Buffer.from(srpAttr.srpUserID);

      // Use SRP.genKey as a callback (matching Ente web implementation)
      const srpClient = await new Promise<SrpClient>((resolve, reject) => {
        SRP.genKey((err, secret) => {
          if (err) reject(err);
          resolve(
            new SrpClient(
              SRP.params["4096"],
              srpSalt,
              identity,
              Buffer.from(loginKey),
              secret!,
              false  // Disable auto-compute (critical!)
            )
          );
        });
      });

      // Step 5: Compute A (client public value)
      const clientA = srpClient.computeA();

      // Step 6: Create SRP session
      const session = await this.createSRPSession(
        srpAttr.srpUserID,
        clientA.toString("base64")
      );

      // Step 7: Set server's B value
      const serverB = Buffer.from(session.srpB, "base64");
      srpClient.setB(serverB);

      // Step 8: Compute M1 (client proof)
      const clientM1 = srpClient.computeM1();

      // Step 9: Verify SRP session
      const response = await this.verifySRPSession(
        srpAttr.srpUserID,
        session.sessionID,
        clientM1.toString("base64")
      );

      // Step 9b: Verify server's M2 proof
      if (response.srpM2) {
        const serverM2 = Buffer.from(response.srpM2, "base64");
        srpClient.checkM2(serverM2);
      }

      // Step 10: Decrypt account secrets or use plaintext token
      let token: string;
      let masterKey: Uint8Array;

      if (response.token) {
        // Rare edge case: plaintext token (user hasn't set up key attributes)
        token = response.token;
        masterKey = new Uint8Array(32); // Placeholder
      } else if (response.encryptedToken && response.keyAttributes) {
        // Normal case: decrypt the token
        const secrets = await decryptAccountSecrets(response, keyEncKey);
        token = secrets.token;
        masterKey = secrets.masterKey;
      } else {
        throw new Error("No token available in login response");
      }

      return {
        token,
        masterKey,
        userId: response.id,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Login failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get SRP attributes for a user
   */
  private async getSRPAttributes(email: string): Promise<SRPAttributes> {
    const response = await this.client.get<{ attributes: SRPAttributes }>(
      "/users/srp/attributes",
      {
        query: { email },
      }
    );
    return response.attributes;
  }

  /**
   * Create SRP session
   */
  private async createSRPSession(
    srpUserID: string,
    srpA: string
  ): Promise<CreateSRPSessionResponse> {
    return await this.client.post<CreateSRPSessionResponse>(
      "/users/srp/create-session",
      {
        srpUserID,
        srpA,
      }
    );
  }

  /**
   * Verify SRP session with M1 proof
   */
  private async verifySRPSession(
    srpUserID: string,
    sessionID: string,
    srpM1: string
  ): Promise<LoginResponse> {
    return await this.client.post<LoginResponse>(
      "/users/srp/verify-session",
      {
        srpUserID,
        sessionID,
        srpM1,
      }
    );
  }

  /**
   * Verify if a token is still valid
   */
  async verifyToken(token: string): Promise<boolean> {
    try {
      await this.client.get("/users/session", {
        headers: {
          "X-Auth-Token": token,
        },
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}

/**
 * Session storage helper
 */
export class SessionStorage {
  private static readonly SESSION_KEY = "ente_session";

  /**
   * Save session to database
   */
  static save(db: any, session: Session): void {
    db.setConfig(this.SESSION_KEY, JSON.stringify(session));
  }

  /**
   * Load session from database
   */
  static load(db: any): Session | null {
    const data = db.getConfig(this.SESSION_KEY);
    if (!data) return null;

    try {
      const session = JSON.parse(data) as Session;

      // Check if session has expired
      if (Date.now() > session.expiresAt) {
        return null;
      }

      return session;
    } catch {
      return null;
    }
  }

  /**
   * Clear session from database
   */
  static clear(db: any): void {
    db.setConfig(this.SESSION_KEY, "");
  }
}
