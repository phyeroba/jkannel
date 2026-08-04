import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Redis-backed throttling for the authentication surface (`/auth/*`).
 *
 * Why this exists: a 6-digit TOTP has 10^6 possibilities and MFA verification
 * had no limit at all, so it was brute-forceable in minutes. Per-account
 * lockout (5 bad passwords) also does nothing against credential stuffing that
 * spreads one guess across thousands of accounts from one host.
 *
 * ## Failure-counted, not request-counted
 *
 * Every bucket here counts *penalties*, not requests: the guard reads the
 * counters (never mutating them) and the service increments only when an
 * attempt actually fails (or, for password-reset requests, on every call —
 * that endpoint is a resource/enumeration vector regardless of outcome). Two
 * consequences that matter:
 *   - legitimate traffic is never throttled, so the perf harness (~7 rps of
 *     *successful* logins from one host) and the e2e suite are unaffected;
 *   - the limits can be tight enough to be meaningful.
 *
 * ## Fail open
 *
 * If Redis is absent, unreachable or errors, every check ALLOWS and a warning
 * is logged. A cache outage must never lock the operator out.
 *
 * ## Duplication note
 *
 * The atomic INCR+EXPIRE Lua approach is lifted from
 * `api-gateway/gateway-rate-limiter.ts`. That class is not exported from the
 * gateway module and its single-key, request-counted `consume()` shape does not
 * fit the peek/penalize split above, and the gateway module is out of bounds
 * for this change, so the mechanism is replicated here. These two should be
 * consolidated into one shared `platform/` limiter with pluggable policies.
 */

/** Minimal Redis surface used here (mirrors api-gateway/redis.provider). */
export interface ThrottleRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** DI token for the (possibly null) auth-throttle Redis client. */
export const AUTH_THROTTLE_REDIS = 'AUTH_THROTTLE_REDIS';

export interface ThrottleBucket {
  /** Redis key suffix. Never contains a password or token. */
  key: string;
  /** Penalty ceiling for the window. `<= 0` disables the bucket. */
  limit: number;
  /** Seconds the penalty window lasts, measured from the first penalty. */
  windowSeconds: number;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the offending bucket clears (0 when allowed). */
  retryAfterSeconds: number;
  /** True when the verdict was reached without Redis (fail-open). */
  degraded: boolean;
}

/**
 * Read counters + TTLs for N keys in one round trip. Deliberately non-mutating:
 * the guard must not consume budget, only observe it.
 */
const PEEK_SCRIPT = `
local out = {}
for i = 1, #KEYS do
  out[#out + 1] = tonumber(redis.call('GET', KEYS[i]) or '0')
  out[#out + 1] = redis.call('TTL', KEYS[i])
end
return out
`;

/**
 * Increment N keys, setting each key's TTL on its first hit, in one atomic
 * EVAL. The window therefore starts at the first failure and rolls off whole
 * rather than snapping to a wall-clock boundary.
 */
const PENALIZE_SCRIPT = `
local out = {}
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then
    redis.call('EXPIRE', KEYS[i], ARGV[i])
  end
  out[#out + 1] = count
end
return out
`;

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Resolved limits. Every value is env-overridable; the defaults below are
 * chosen so that no honest caller can reach them:
 *
 * | knob                                      | default | effect                                        |
 * |-------------------------------------------|---------|-----------------------------------------------|
 * | AUTH_THROTTLE_ENABLED                     | true    | master switch                                  |
 * | AUTH_THROTTLE_LOGIN_MAX_FAILURES          | 10      | failed logins per tenant+username+IP / window  |
 * | AUTH_THROTTLE_LOGIN_WINDOW_SECONDS        | 900     | 15 min                                         |
 * | AUTH_THROTTLE_LOGIN_IP_MAX_FAILURES       | 50      | failed logins per IP (credential stuffing)     |
 * | AUTH_THROTTLE_LOGIN_IP_WINDOW_SECONDS     | 900     |                                                |
 * | AUTH_THROTTLE_MFA_MAX_FAILURES            | 5       | failed TOTP/recovery per user / window         |
 * | AUTH_THROTTLE_MFA_WINDOW_SECONDS          | 300     | 5 min -> 10^6/5 codes ≈ 1.9 years to exhaust   |
 * | AUTH_THROTTLE_MFA_IP_MAX_FAILURES         | 20      | failed TOTP/recovery per IP / window           |
 * | AUTH_THROTTLE_RESET_MAX_ATTEMPTS          | 5       | password-reset REQUESTS per tenant+user+IP     |
 * | AUTH_THROTTLE_RESET_WINDOW_SECONDS        | 900     |                                                |
 * | AUTH_THROTTLE_RESET_IP_MAX_ATTEMPTS       | 20      | password-reset requests per IP                 |
 * | AUTH_THROTTLE_TOKEN_MAX_FAILURES          | 20      | bad refresh / reset-confirm / invite per IP    |
 * | AUTH_THROTTLE_TOKEN_WINDOW_SECONDS        | 900     |                                                |
 */
export interface AuthThrottleLimits {
  enabled: boolean;
  loginMax: number;
  loginWindow: number;
  loginIpMax: number;
  loginIpWindow: number;
  mfaMax: number;
  mfaWindow: number;
  mfaIpMax: number;
  resetMax: number;
  resetWindow: number;
  resetIpMax: number;
  tokenMax: number;
  tokenWindow: number;
}

export function authThrottleLimits(env: NodeJS.ProcessEnv = process.env): AuthThrottleLimits {
  return {
    enabled: (env.AUTH_THROTTLE_ENABLED ?? 'true').toLowerCase() !== 'false',
    loginMax: intFromEnv('AUTH_THROTTLE_LOGIN_MAX_FAILURES', 10, env),
    loginWindow: intFromEnv('AUTH_THROTTLE_LOGIN_WINDOW_SECONDS', 900, env),
    loginIpMax: intFromEnv('AUTH_THROTTLE_LOGIN_IP_MAX_FAILURES', 50, env),
    loginIpWindow: intFromEnv('AUTH_THROTTLE_LOGIN_IP_WINDOW_SECONDS', 900, env),
    mfaMax: intFromEnv('AUTH_THROTTLE_MFA_MAX_FAILURES', 5, env),
    mfaWindow: intFromEnv('AUTH_THROTTLE_MFA_WINDOW_SECONDS', 300, env),
    mfaIpMax: intFromEnv('AUTH_THROTTLE_MFA_IP_MAX_FAILURES', 20, env),
    resetMax: intFromEnv('AUTH_THROTTLE_RESET_MAX_ATTEMPTS', 5, env),
    resetWindow: intFromEnv('AUTH_THROTTLE_RESET_WINDOW_SECONDS', 900, env),
    resetIpMax: intFromEnv('AUTH_THROTTLE_RESET_IP_MAX_ATTEMPTS', 20, env),
    tokenMax: intFromEnv('AUTH_THROTTLE_TOKEN_MAX_FAILURES', 20, env),
    tokenWindow: intFromEnv('AUTH_THROTTLE_TOKEN_WINDOW_SECONDS', 900, env),
  };
}

/** Lower-case + strip anything that would break a Redis key. */
function slug(value: string | undefined): string {
  if (!value) return '-';
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[{}\r\n]/g, '')
    .slice(0, 96);
}

/**
 * Thrown when a bucket is exhausted. Carries the Retry-After value so the guard
 * can put it on the response.
 */
export class AuthThrottledException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many authentication attempts. Try again later.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class AuthThrottleService {
  constructor(
    @Optional() @Inject(AUTH_THROTTLE_REDIS) private readonly redis: ThrottleRedis | null = null,
  ) {}

  limits(): AuthThrottleLimits {
    return authThrottleLimits();
  }

  // ---- bucket builders (shared by the guard, which peeks, and the services,
  // which penalize, so the two can never disagree on a key) -----------------

  loginBuckets(tenant: string | undefined, username: string | undefined, ip?: string) {
    const l = this.limits();
    return [
      {
        key: `auth:login:u:${slug(tenant)}:${slug(username)}:${slug(ip)}`,
        limit: l.loginMax,
        windowSeconds: l.loginWindow,
      },
      { key: `auth:login:ip:${slug(ip)}`, limit: l.loginIpMax, windowSeconds: l.loginIpWindow },
    ];
  }

  /** Second-factor verification — the tightest bucket in the system. */
  mfaBuckets(tenantId: string | undefined, userId: string | undefined, ip?: string) {
    const l = this.limits();
    return [
      {
        key: `auth:mfa:u:${slug(tenantId)}:${slug(userId)}`,
        limit: l.mfaMax,
        windowSeconds: l.mfaWindow,
      },
      { key: `auth:mfa:ip:${slug(ip)}`, limit: l.mfaIpMax, windowSeconds: l.mfaWindow },
    ];
  }

  resetBuckets(tenant: string | undefined, username: string | undefined, ip?: string) {
    const l = this.limits();
    return [
      {
        key: `auth:reset:u:${slug(tenant)}:${slug(username)}`,
        limit: l.resetMax,
        windowSeconds: l.resetWindow,
      },
      { key: `auth:reset:ip:${slug(ip)}`, limit: l.resetIpMax, windowSeconds: l.resetWindow },
    ];
  }

  /** Guessing a refresh token, reset token or invitation token. */
  tokenBuckets(scope: string, ip?: string) {
    const l = this.limits();
    return [
      {
        key: `auth:token:${slug(scope)}:ip:${slug(ip)}`,
        limit: l.tokenMax,
        windowSeconds: l.tokenWindow,
      },
    ];
  }

  // ---- enforcement ---------------------------------------------------------

  /**
   * Non-mutating check. Returns `allowed: false` plus the longest Retry-After
   * among exhausted buckets. Fails open (allowed) when Redis is unavailable.
   */
  async inspect(buckets: ThrottleBucket[]): Promise<ThrottleDecision> {
    const active = buckets.filter((bucket) => bucket.limit > 0);
    if (!this.limits().enabled || active.length === 0)
      return { allowed: true, retryAfterSeconds: 0, degraded: false };
    if (!this.redis) {
      this.warn('redis client unavailable');
      return { allowed: true, retryAfterSeconds: 0, degraded: true };
    }
    try {
      const raw = (await this.redis.eval(
        PEEK_SCRIPT,
        active.length,
        ...active.map((bucket) => bucket.key),
      )) as Array<number | string>;
      let retryAfterSeconds = 0;
      for (let i = 0; i < active.length; i += 1) {
        const count = Number(raw?.[i * 2] ?? 0);
        const ttlRaw = Number(raw?.[i * 2 + 1] ?? -1);
        if (count >= active[i].limit) {
          const ttl = ttlRaw > 0 ? ttlRaw : active[i].windowSeconds;
          retryAfterSeconds = Math.max(retryAfterSeconds, ttl);
        }
      }
      return { allowed: retryAfterSeconds === 0, retryAfterSeconds, degraded: false };
    } catch (error) {
      this.warn(String((error as Error)?.message ?? error));
      return { allowed: true, retryAfterSeconds: 0, degraded: true };
    }
  }

  /** {@link inspect}, throwing {@link AuthThrottledException} when exhausted. */
  async assertAllowed(buckets: ThrottleBucket[]): Promise<void> {
    const decision = await this.inspect(buckets);
    if (!decision.allowed) throw new AuthThrottledException(decision.retryAfterSeconds);
  }

  /**
   * Record one penalty against each bucket. Never throws — a throttling write
   * failure must not turn a 401 into a 500.
   */
  async penalize(buckets: ThrottleBucket[]): Promise<void> {
    const active = buckets.filter((bucket) => bucket.limit > 0);
    if (!this.limits().enabled || active.length === 0 || !this.redis) return;
    try {
      await this.redis.eval(
        PENALIZE_SCRIPT,
        active.length,
        ...active.map((bucket) => bucket.key),
        ...active.map((bucket) => bucket.windowSeconds),
      );
    } catch (error) {
      this.warn(String((error as Error)?.message ?? error));
    }
  }

  private warn(reason: string): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'auth throttle failing open',
        reason,
      }),
    );
  }
}
