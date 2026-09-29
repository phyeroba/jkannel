import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret } from './identity-crypto';

/**
 * WEBHOOK SHARED SECRETS: HOW THEY ARE STORED, AND HOW THEY ARE USED.
 *
 * Two defects are fixed here, and they are separate problems with separate
 * fixes. Conflating them is why the first version of this shipped neither.
 *
 * 1. THE SECRET WAS STORED AND RETURNED IN PLAINTEXT.
 *    `notification_channels.config` and `mo_rule_destinations.config` are JSONB
 *    blobs written straight from the request body, so `config.secret` sat in the
 *    database in the clear AND came back out of every list endpoint. Anyone with
 *    `system.view` could read every receiver's credential.
 *
 *    Fixed by {@link sealSecret} on the way in, {@link openSecret} on the way to
 *    the wire, and {@link redactSecret} on the way to a reader.
 *
 * 2. THE "SIGNATURE" WAS THE SECRET ITSELF.
 *    The sender put the shared secret verbatim in `x-jkannel-signature`. That is
 *    a bearer token wearing a signature's name: it proves nothing about the body,
 *    it is identical on every request, and anyone who ever received one - or read
 *    one out of a log, or out of the list endpoint above - could replay it
 *    forever against that receiver.
 *
 *    Fixed by {@link signBody}, which is an HMAC over the timestamp AND the body,
 *    so a captured header is useless for any other payload and expires.
 *
 * THE SCHEME ON THE WIRE
 * ---------------------------------------------------------------------------
 *   x-jkannel-timestamp: 1759140000            (unix seconds, integer)
 *   x-jkannel-signature: v1=<hex hmac-sha256>
 *
 * The signed string is `${timestamp}.${rawBody}` - the EXACT bytes sent, not a
 * re-serialisation of the parsed object, because two JSON encoders disagree
 * about key order and whitespace and the receiver would compute a different
 * digest for a byte-identical message.
 *
 * A receiver verifies by recomputing the HMAC over the timestamp and the raw
 * body it received, comparing in constant time, and REJECTING A TIMESTAMP
 * OUTSIDE ITS TOLERANCE - without that last step the replay window is unbounded
 * again and this whole change buys nothing. {@link verifySignature} implements
 * exactly that and is exported so a receiver inside this codebase, and the test
 * suite, use the same code the sender does.
 */

/** Header carrying `v1=<hex>`. */
export const SIGNATURE_HEADER = 'x-jkannel-signature';
/** Header carrying the unix-seconds timestamp that is inside the digest. */
export const TIMESTAMP_HEADER = 'x-jkannel-timestamp';
/**
 * What a reader sees instead of a secret.
 *
 * Deliberately the SAME marker `mo-inbound.service.ts` already writes in SQL
 * (`REDACTED_CONFIG`). One codebase with two redaction markers means a caller
 * echoing a read back into a write is safe against one of them and silently
 * overwrites the secret with a literal under the other.
 */
export const REDACTED = '__redacted__';
/** How far a receiver should let a timestamp drift. Five minutes each way. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

type Config = Record<string, unknown> | null | undefined;

/**
 * True when a stored value is one of ours rather than a legacy plaintext secret.
 * `encryptSecret` emits `v1:<iv>:<tag>:<ciphertext>`; a plaintext secret that
 * happened to start with `v1:` would be misread, which is why the check also
 * requires the right number of parts.
 */
function looksEncrypted(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'v1' && parts.every((p, i) => i === 0 || p.length > 0);
}

/**
 * Encrypt `config.secret` for storage, leaving every other key untouched.
 *
 * Idempotent: a value that is already sealed is returned as-is, so an update
 * that echoes back a previously-read config cannot double-encrypt it.
 */
export function sealSecret(config: Config): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const secret = config.secret;
  if (typeof secret !== 'string' || !secret) return { ...config };
  // A caller echoing back a redacted read must not overwrite the real secret
  // with the marker. Drop the key instead and leave the stored value alone.
  if (secret === REDACTED) {
    const { secret: _drop, ...rest } = config;
    return rest;
  }
  if (looksEncrypted(secret)) return { ...config };
  return { ...config, secret: encryptSecret(secret) };
}

/**
 * Recover the usable secret at the point of sending.
 *
 * Tolerates a legacy plaintext value so that rows written before this existed
 * keep working; they are upgraded the next time the record is written. Returns
 * `null` when there is no secret, which is a valid configuration - an
 * unauthenticated webhook is a choice, and the caller sends no headers.
 */
export function openSecret(config: Config): string | null {
  if (!config || typeof config !== 'object') return null;
  const secret = config.secret;
  if (typeof secret !== 'string' || !secret || secret === REDACTED) return null;
  if (!looksEncrypted(secret)) return secret;
  try {
    return decryptSecret(secret);
  } catch {
    // A secret encrypted under a key we no longer hold cannot be recovered.
    // Returning null sends the hook UNSIGNED, which the receiver rejects - that
    // is the correct failure, and far better than throwing and stalling the
    // whole delivery queue on every attempt.
    return null;
  }
}

/** Replace a stored secret with a marker for anything a human or API can read. */
export function redactSecret(config: Config): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const secret = config.secret;
  if (typeof secret !== 'string' || !secret) return { ...config };
  return { ...config, secret: REDACTED };
}

/** True when the config carries a secret, without revealing it. */
export function hasSecret(config: Config): boolean {
  if (!config || typeof config !== 'object') return false;
  const secret = config.secret;
  return typeof secret === 'string' && secret.length > 0 && secret !== REDACTED;
}

/**
 * The headers to send with `rawBody`. Empty when the destination has no secret.
 *
 * `rawBody` must be the exact string handed to `fetch`, for the reason in the
 * header comment.
 */
export function signBody(
  secret: string | null,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> {
  if (!secret) return {};
  const timestamp = String(nowSeconds);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: `v1=${digest}` };
}

/**
 * Verify a received signature. Returns a reason on failure rather than a bare
 * false, because "signature did not match" and "timestamp too old" send a
 * receiver's operator to completely different places.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!signatureHeader) return { ok: false, reason: `missing ${SIGNATURE_HEADER}` };
  if (!timestampHeader) return { ok: false, reason: `missing ${TIMESTAMP_HEADER}` };
  if (!/^\d+$/.test(timestampHeader))
    return { ok: false, reason: `${TIMESTAMP_HEADER} is not unix seconds` };
  if (Math.abs(now - Number(timestampHeader)) > tolerance)
    return { ok: false, reason: `timestamp outside the ${tolerance}s tolerance` };
  if (!signatureHeader.startsWith('v1='))
    return { ok: false, reason: 'unsupported signature version' };

  const expected = createHmac('sha256', secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');
  const got = signatureHeader.slice(3);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: 'signature does not match' };
  return { ok: true };
}

/** A fresh secret, for a UI or a seeder that needs to offer one. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}
