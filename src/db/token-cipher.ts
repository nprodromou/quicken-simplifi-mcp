import crypto from "node:crypto";

/**
 * Encrypts Simplifi OAuth tokens at rest with a key held outside the SQLite
 * file (in 1Password, injected at runtime via `op run` as SIMPLIFI_TOKEN_ENC_KEY).
 *
 * Only the two secret fields (access + refresh token) are encrypted; expiry
 * timestamps stay plaintext so they remain queryable and debuggable.
 *
 * Format: `enc:v1:<iv>.<authTag>.<ciphertext>` — all parts base64url. AES-256-GCM
 * gives us confidentiality plus tamper detection (the auth tag). Each write uses a
 * fresh random IV. Values without the prefix are treated as plaintext, so a DB
 * written before a key was configured decrypts transparently.
 */
const ENC_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class TokenCipher {
  private readonly key: Buffer;

  public constructor(keyMaterial: string) {
    if (!keyMaterial || keyMaterial.trim() === "") {
      throw new Error("TokenCipher requires a non-empty key");
    }
    // Normalize arbitrary key material (a 1P-generated key or a passphrase) to a
    // fixed 32-byte AES key. A high-entropy generated key is expected in prod.
    this.key = crypto.createHash("sha256").update(keyMaterial, "utf8").digest();
  }

  public encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  /**
   * Decrypts a value produced by {@link encrypt}. A value that is not
   * prefixed is returned unchanged (plaintext passthrough). Throws if a
   * prefixed value is malformed or fails authentication (wrong key / tamper).
   */
  public decrypt(value: string): string {
    if (!TokenCipher.isEncrypted(value)) {
      return value;
    }

    // The ciphertext segment may legitimately be empty (an encrypted empty
    // string), so validate structure and the always-present IV/tag rather than
    // truthiness of all three parts.
    const parts = value.slice(ENC_PREFIX.length).split(".");
    const [ivPart, tagPart, ctPart] = parts;
    if (parts.length !== 3 || !ivPart || !tagPart || ctPart === undefined) {
      throw new Error("Malformed encrypted token payload");
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
  }

  public static isEncrypted(value: string): boolean {
    return value.startsWith(ENC_PREFIX);
  }
}
