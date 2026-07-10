/**
 * Per-key IP allowlist matching for the API Gateway.
 *
 * An entry may be an exact address (IPv4 or IPv6) or a CIDR block
 * (`10.0.0.0/8`, `2001:db8::/32`). An empty or absent allowlist means "allow
 * all" — the caller has not restricted the key by origin. Matching is
 * defensive: an unparseable entry never matches, and an unparseable caller IP
 * is denied unless the allowlist is empty.
 */

/** Parse an IPv4 dotted-quad into a 32-bit unsigned integer, or null. */
function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

/** Expand an IPv6 address (with optional `::`) into a 128-bit integer, or null. */
function parseIpv6(value: string): bigint | null {
  let text = value;
  // An IPv4-mapped tail (::ffff:1.2.3.4) — convert the tail to two hextets.
  const v4Match = text.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const v4 = parseIpv4(v4Match[2]);
    if (v4 === null) return null;
    const high = (v4 >> 16n) & 0xffffn;
    const low = v4 & 0xffffn;
    text = `${v4Match[1]}${high.toString(16)}:${low.toString(16)}`;
  }
  if (!/^[0-9a-fA-F:]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

interface ParsedIp {
  value: bigint;
  bits: 32 | 128;
}

/** Parse an address as IPv4 or IPv6 into a comparable integer + width. */
export function parseIp(value: string): ParsedIp | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const v6 = parseIpv6(trimmed);
    return v6 === null ? null : { value: v6, bits: 128 };
  }
  const v4 = parseIpv4(trimmed);
  return v4 === null ? null : { value: v4, bits: 32 };
}

/** True when `ip` falls inside the single allowlist `entry` (exact or CIDR). */
function matchesEntry(ip: ParsedIp, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    const exact = parseIp(trimmed);
    return exact !== null && exact.bits === ip.bits && exact.value === ip.value;
  }
  const network = parseIp(trimmed.slice(0, slash));
  const prefixText = trimmed.slice(slash + 1);
  if (network === null || network.bits !== ip.bits || !/^\d{1,3}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (prefix > ip.bits) return false;
  if (prefix === 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(ip.bits - prefix);
  return (ip.value & mask) === (network.value & mask);
}

/**
 * Enforce a per-key IP allowlist. An empty/absent list allows all callers.
 * A non-empty list allows only callers whose IP matches at least one entry.
 */
export function isIpAllowed(
  ip: string | undefined | null,
  allowlist: string[] | undefined | null,
): boolean {
  const entries = (allowlist ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return true;
  if (!ip) return false;
  const parsed = parseIp(ip);
  if (parsed === null) return false;
  return entries.some((entry) => matchesEntry(parsed, entry));
}
