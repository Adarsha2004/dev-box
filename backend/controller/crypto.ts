import { randomBytes } from "node:crypto";
import { gcm } from "@noble/ciphers/aes.js";

const keyHex = process.env.ENCRYPTION_KEY;
if (!keyHex) {
  throw new Error(
    "ENCRYPTION_KEY is missing or invalid — add a 64-char hex string (32 bytes, `openssl rand -hex 32`) to .env",
  );
}
const key = Buffer.from(keyHex, "hex");

export function encryptSecret(plain: string): string {
  const nonce = randomBytes(12);
  const encrypted = gcm(key, nonce).encrypt(new TextEncoder().encode(plain));
  return Buffer.concat([nonce, encrypted]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const nonce = raw.subarray(0, 12);
  const encrypted = raw.subarray(12);
  return new TextDecoder().decode(gcm(key, nonce).decrypt(encrypted));
}
