// Yahoo tokens at rest: AES-256-GCM with a key from YAHOO_TOKEN_KEY. Pure
// (apart from reading the env), tested. The stored form is
// "v1.<iv>.<tag>.<ciphertext>", each part base64url.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * The 32-byte key: YAHOO_TOKEN_KEY as base64 when it decodes to 32 bytes (make
 * one with `openssl rand -base64 32`), else the SHA-256 of the string.
 */
export function tokenKey(secret = process.env.YAHOO_TOKEN_KEY): Buffer {
  if (!secret || secret.length < 16) throw new Error("YAHOO_TOKEN_KEY must be set (openssl rand -base64 32)");
  const raw = Buffer.from(secret, "base64");
  return raw.length === 32 ? raw : createHash("sha256").update(secret).digest();
}

export function encryptToken(plain: string, key: Buffer = tokenKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptToken(stored: string, key: Buffer = tokenKey()): string {
  const [v, iv, tag, data] = stored.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Stored Yahoo token is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Can't decrypt the stored Yahoo token: YAHOO_TOKEN_KEY changed? Reconnect Yahoo.");
  }
}
