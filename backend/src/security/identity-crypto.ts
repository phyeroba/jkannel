import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Small symmetric-encryption helper used to protect TOTP secrets at rest.
 *
 * The encryption key comes from MFA_ENCRYPTION_KEY, falling back to the
 * authentication token keys (AUTH_ACCESS_TOKEN_KEY, then the deprecated
 * AUTH_SIGNING_KEY). The configured value must be at least 32 bytes; it is
 * hashed to a fixed 32-byte AES-256 key so any sufficiently long passphrase is
 * accepted. Values are stored as `v1:<iv>:<tag>:<ciphertext>` (base64 parts).
 */
const MINIMUM_KEY_BYTES = 32;

function resolveKeyMaterial(): string {
  const candidate =
    process.env.MFA_ENCRYPTION_KEY ??
    process.env.AUTH_ACCESS_TOKEN_KEY ??
    process.env.AUTH_SIGNING_KEY;
  if (!candidate || Buffer.byteLength(candidate, 'utf8') < MINIMUM_KEY_BYTES) {
    throw new Error(
      `No valid MFA encryption key configured. Set MFA_ENCRYPTION_KEY ` +
        `(or reuse AUTH_ACCESS_TOKEN_KEY/AUTH_SIGNING_KEY) to at least ${MINIMUM_KEY_BYTES} bytes.`,
    );
  }
  return candidate;
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(resolveKeyMaterial()).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(encoded: string): string {
  const [version, ivText, tagText, dataText] = encoded.split(':');
  if (version !== 'v1' || !ivText || !tagText || !dataText)
    throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Normalise a recovery code before hashing/comparison so display formatting
 * (dashes, spaces, casing) never affects matching.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Constant-time comparison of two hex-encoded digests of equal length. */
export function safeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
