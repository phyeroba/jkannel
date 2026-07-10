import { createHmac, randomBytes } from 'node:crypto';

/**
 * Self-contained RFC 6238 TOTP (Google Authenticator compatible, SHA-1 /
 * 6 digits / 30s). Implemented on Node's crypto rather than a third-party
 * package so the whole identity subsystem stays pure CommonJS — otplib v13 is
 * ESM-only and pulls in ESM-only transitive dependencies (@scure, @noble) that
 * the project's ts-jest (CommonJS) test runner cannot load.
 */
const ISSUER = process.env.MFA_ISSUER ?? 'JKANNEL';
const PERIOD = 30;
const DIGITS = 6;
const DRIFT_WINDOWS = 1; // accept +/- one 30s step of clock drift
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** Generate a fresh base32 TOTP secret (Google Authenticator compatible). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Build the otpauth:// URI embedded in the enrollment QR code. */
export function totpUri(label: string, secret: string): string {
  const path = encodeURIComponent(`${ISSUER}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${path}?${params.toString()}`;
}

/** Compute the current TOTP code for a secret (primarily for tests). */
export function generateTotp(
  secret: string,
  epochSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return hotp(secret, Math.floor(epochSeconds / PERIOD));
}

/** Verify a user-supplied 6-digit TOTP code against a base32 secret. */
export async function verifyTotp(secret: string, token: string): Promise<boolean> {
  const candidate = typeof token === 'string' ? token.trim() : '';
  if (!/^\d{6}$/.test(candidate)) return false;
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  for (let window = -DRIFT_WINDOWS; window <= DRIFT_WINDOWS; window++) {
    if (hotp(secret, counter + window) === candidate) return true;
  }
  return false;
}
