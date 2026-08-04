/**
 * Trustworthy client-IP derivation.
 *
 * `X-Forwarded-For` is a client-supplied header. nginx *appends* to it
 * (`proxy_add_x_forwarded_for`), so whatever the caller sent stays in the
 * left-most position — which is precisely the position the old gateway code
 * read. Anyone could therefore send `X-Forwarded-For: <allowlisted-ip>` and
 * defeat the per-API-key IP allowlist (and poison `gateway_request_log`).
 *
 * The only values in the chain we may trust are the ones *our own* infrastructure
 * appended. So we walk the chain from the right (closest to us, most
 * trustworthy) and skip exactly as many hops as we know we operate. The first
 * hop we did not put there is the client.
 *
 * Two configuration styles, both env-driven:
 *
 *   TRUSTED_PROXIES        Comma-separated IPs and/or CIDRs of reverse proxies we
 *                          operate (e.g. "172.18.0.0/16,10.0.0.0/8"). Preferred:
 *                          address matching cannot be fooled by a caller that
 *                          reaches the app directly. Takes precedence when set.
 *   TRUSTED_PROXY_COUNT    Number of reverse-proxy hops in front of the app.
 *                          Default 1 — the shipped topology is
 *                          browser -> nginx (infrastructure/nginx) -> backend.
 *                          Set to 0 when the app is exposed directly (then XFF is
 *                          ignored entirely and the socket peer is used).
 *
 * NOTE on the default: docker-compose also publishes the backend on
 * ${BACKEND_PORT:-3000} alongside the proxy, so with hop *counting* a caller who
 * bypasses nginx and talks to :3000 directly can still forge one hop. Set
 * TRUSTED_PROXIES to the proxy's address range (or stop publishing :3000) to
 * close that. This is documented rather than defaulted-away because changing
 * the count to 0 would break the real nginx path.
 */
import { isIpAllowed } from '../api-gateway/ip-allowlist';

export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Express-populated remote address (already `trust proxy`-aware in prod). */
  ip?: string;
  socket?: { remoteAddress?: string };
  /** Populated by RequestContextMiddleware — the value consumers should read. */
  clientIp?: string;
}

export interface TrustedProxyConfig {
  /** Explicit proxy addresses/CIDRs. Non-empty means address matching is used. */
  addresses: string[];
  /** Hop count fallback used when `addresses` is empty. */
  count: number;
}

/** Strip an IPv4-mapped IPv6 prefix and any `:port` suffix from a bare IPv4. */
export function normalizeIp(value: string): string {
  let text = value.trim();
  if (!text) return '';
  // Bracketed IPv6 with port: [::1]:1234
  const bracket = text.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket) text = bracket[1];
  // IPv4-mapped IPv6 (::ffff:203.0.113.9) -> 203.0.113.9 so that IPv4 CIDR
  // entries in an allowlist match a request that arrived over a dual-stack
  // socket.
  const mapped = text.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) text = mapped[1];
  // Bare IPv4 with a port (some proxies emit 203.0.113.9:52344).
  const withPort = text.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  if (withPort) text = withPort[1];
  return text;
}

/** Read the trusted-proxy configuration from the environment. */
export function trustedProxyConfig(env: NodeJS.ProcessEnv = process.env): TrustedProxyConfig {
  const addresses = (env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const rawCount = env.TRUSTED_PROXY_COUNT;
  const parsed = rawCount === undefined || rawCount.trim() === '' ? 1 : Number(rawCount);
  const count = Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
  return { addresses, count };
}

/**
 * The value to hand to Express `app.set('trust proxy', …)` so that `req.ip`
 * agrees with {@link resolveClientIp}. Express applies the same right-to-left
 * semantics for both a hop count and a list of trusted addresses.
 */
export function expressTrustProxySetting(
  config: TrustedProxyConfig = trustedProxyConfig(),
): string[] | number {
  return config.addresses.length > 0 ? config.addresses : config.count;
}

/**
 * Build the full hop chain, client-first: every `X-Forwarded-For` entry in
 * order, then the socket peer (the only entry nobody but our own network could
 * have set).
 */
function hopChain(request: ClientIpRequest): string[] {
  const header = request.headers?.['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const forwarded = typeof raw === 'string' ? raw.split(',').map(normalizeIp).filter(Boolean) : [];
  const peer = normalizeIp(request.socket?.remoteAddress ?? request.ip ?? '');
  return peer ? [...forwarded, peer] : forwarded;
}

/**
 * Resolve the client IP as the right-most hop we did **not** put in the chain.
 *
 * Examples with the default single-nginx topology (count = 1):
 *   XFF absent, peer=203.0.113.9              -> 203.0.113.9
 *   XFF "203.0.113.9", peer=172.18.0.3        -> 203.0.113.9
 *   XFF "9.9.9.9, 203.0.113.9" (spoof + nginx append), peer=172.18.0.3
 *                                             -> 203.0.113.9   (spoof ignored)
 * With count = 0 the header is ignored entirely and the socket peer wins.
 */
export function resolveClientIp(
  request: ClientIpRequest,
  config: TrustedProxyConfig = trustedProxyConfig(),
): string | undefined {
  const chain = hopChain(request);
  if (chain.length === 0) return undefined;
  if (config.addresses.length > 0) {
    let index = chain.length - 1;
    // Skip every right-hand hop that is one of our own proxies.
    while (index > 0 && isIpAllowed(chain[index], config.addresses)) index -= 1;
    return chain[index];
  }
  const index = Math.max(0, chain.length - 1 - config.count);
  return chain[index];
}
