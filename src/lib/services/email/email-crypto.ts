import "server-only";

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.EMAIL_CREDENTIALS_KEY?.trim();
  if (!raw) {
    throw new Error("EMAIL_CREDENTIALS_KEY is not configured; cannot encrypt SMTP credentials.");
  }
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("EMAIL_CREDENTIALS_KEY must be 32 bytes (64 hex chars or base64).");
  }
  return key;
}

/** Encrypts a secret for storage. Format: iv.tag.ciphertext (base64url). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64url")).join(".");
}

/** Decrypts a stored secret. Never log the result or the input. */
export function decryptSecret(encrypted: string): string {
  const [ivB64, tagB64, dataB64] = encrypted.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored SMTP credential is malformed.");
  }
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hasEmailEncryptionKey(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
