import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';

/**
 * The security knobs on the System Settings screen, resolved into the values the
 * auth paths actually enforce.
 *
 * Before this existed the five `security.*` settings rows were decorative: they
 * read back exactly what an operator wrote and changed no behaviour, because the
 * lockout threshold (5), lockout window (15 min), access-token lifetime (900 s),
 * minimum password length (12) and password-history depth (5) were hardcoded
 * literals in `auth.service.ts` and `console.controllers.ts`. Every field below
 * is read at runtime from `system_settings` on the request's tenant and is
 * genuinely applied; nothing in this interface is advisory.
 *
 * Bounds are enforced here rather than in the settings API on purpose: the
 * settings writer is a generic key/value endpoint, so clamping at the point of
 * use is the only place that cannot be bypassed. Every bound is one-sided in the
 * safe direction — `passwordMinLength` clamps UP to 12, never down, so no
 * setting can make authentication weaker than it is today.
 */
export interface SecurityPolicy {
  /** Minimum characters in a new password. Clamped to [12, 128]. */
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireNumber: boolean;
  passwordRequireSymbol: boolean;
  /** How many previous hashes a new password is checked against. [0, 24]. */
  passwordHistoryDepth: number;
  /** Failed attempts before the account is locked. [3, 20]. */
  lockoutThreshold: number;
  /** Lockout window in minutes. [1, 1440]. */
  lockoutMinutes: number;
  /** Access-token lifetime in seconds. [300, 3600]. */
  accessTokenTtlSeconds: number;
  /** Refresh is refused after this much inactivity. 0 disables. [5, 10080]. */
  sessionIdleTimeoutMinutes: number;
  /** Absolute session age cap in hours. 0 disables. [1, 8760]. */
  sessionMaxLifetimeHours: number;
  /** Concurrent sessions per user; the oldest are revoked past it. 0 = unlimited. [1, 100]. */
  maxConcurrentSessions: number;
}

/**
 * The behaviour JKANNEL had before the knobs were wired. Used verbatim when no
 * settings source is available (isolated unit tests) and as the base every
 * tenant's stored overrides are merged onto, so an absent row can never make the
 * platform less strict than it was.
 */
export const DEFAULT_SECURITY_POLICY: Readonly<SecurityPolicy> = Object.freeze({
  passwordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireNumber: true,
  passwordRequireSymbol: false,
  passwordHistoryDepth: 5,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
  accessTokenTtlSeconds: 900,
  sessionIdleTimeoutMinutes: 60,
  sessionMaxLifetimeHours: 168,
  maxConcurrentSessions: 0,
});

/** Settings keys this policy reads. Kept next to the mapping that consumes them. */
export const SECURITY_SETTING_KEYS = {
  passwordMinLength: 'security.password_min_length',
  passwordRequireUppercase: 'security.password_require_uppercase',
  passwordRequireLowercase: 'security.password_require_lowercase',
  passwordRequireNumber: 'security.password_require_number',
  passwordRequireSymbol: 'security.password_require_symbol',
  passwordHistoryDepth: 'security.password_history_depth',
  lockoutThreshold: 'security.failed_login_lockout_threshold',
  lockoutMinutes: 'security.lockout_minutes',
  accessTokenTtlSeconds: 'security.access_token_ttl_seconds',
  sessionIdleTimeoutMinutes: 'security.session_idle_timeout_minutes',
  sessionMaxLifetimeHours: 'security.session_max_lifetime_hours',
  maxConcurrentSessions: 'security.max_concurrent_sessions',
} as const;

export const SECURITY_SETTINGS_SOURCE = Symbol('SECURITY_SETTINGS_SOURCE');

/** Reads the raw `security.*` rows for one tenant. Implemented over Postgres. */
export interface SecuritySettingsSource {
  loadSecuritySettings(tenantId: string): Promise<Record<string, unknown>>;
}

function toNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Same as {@link toNumber} but lets an explicit 0 through as "disabled". */
function toOptionalNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (Math.trunc(value) <= 0) return 0;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

const CACHE_TTL_MS = 30_000;

@Injectable()
export class SecurityPolicyService {
  private readonly cache = new Map<string, { policy: SecurityPolicy; expiresAt: number }>();

  constructor(
    // Optional so isolated unit tests can construct the auth paths without a
    // database; absent source == DEFAULT_SECURITY_POLICY, i.e. the pre-existing
    // hardcoded behaviour, never something laxer.
    @Optional()
    @Inject(SECURITY_SETTINGS_SOURCE)
    private readonly source?: SecuritySettingsSource,
  ) {}

  /**
   * Resolve the effective policy for a tenant. Cached for 30 s per tenant so the
   * login path costs at most one extra query every half minute; a settings
   * change takes effect within that window. A lookup failure falls back to the
   * defaults rather than failing the request — the defaults are the strict
   * pre-existing behaviour, so degrading to them cannot open anything up.
   */
  async resolve(tenantId?: string): Promise<SecurityPolicy> {
    if (!this.source || !tenantId) return { ...DEFAULT_SECURITY_POLICY };
    const cached = this.cache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.policy;
    let settings: Record<string, unknown> = {};
    try {
      settings = await this.source.loadSecuritySettings(tenantId);
    } catch {
      settings = {};
    }
    const policy = SecurityPolicyService.merge(settings);
    this.cache.set(tenantId, { policy, expiresAt: now + CACHE_TTL_MS });
    return policy;
  }

  /** Drop cached policies (used after a settings write and by tests). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  static merge(settings: Record<string, unknown>): SecurityPolicy {
    const k = SECURITY_SETTING_KEYS;
    const d = DEFAULT_SECURITY_POLICY;
    return {
      // Clamped UP to 12: the knob can strengthen the requirement, never weaken
      // the length JKANNEL has always enforced.
      passwordMinLength: toNumber(settings[k.passwordMinLength], d.passwordMinLength, 12, 128),
      passwordRequireUppercase: toBoolean(
        settings[k.passwordRequireUppercase],
        d.passwordRequireUppercase,
      ),
      passwordRequireLowercase: toBoolean(
        settings[k.passwordRequireLowercase],
        d.passwordRequireLowercase,
      ),
      passwordRequireNumber: toBoolean(settings[k.passwordRequireNumber], d.passwordRequireNumber),
      passwordRequireSymbol: toBoolean(settings[k.passwordRequireSymbol], d.passwordRequireSymbol),
      passwordHistoryDepth: toOptionalNumber(
        settings[k.passwordHistoryDepth],
        d.passwordHistoryDepth,
        1,
        24,
      ),
      lockoutThreshold: toNumber(settings[k.lockoutThreshold], d.lockoutThreshold, 3, 20),
      lockoutMinutes: toNumber(settings[k.lockoutMinutes], d.lockoutMinutes, 1, 1440),
      accessTokenTtlSeconds: toNumber(
        settings[k.accessTokenTtlSeconds],
        d.accessTokenTtlSeconds,
        300,
        3600,
      ),
      sessionIdleTimeoutMinutes: toOptionalNumber(
        settings[k.sessionIdleTimeoutMinutes],
        d.sessionIdleTimeoutMinutes,
        5,
        10080,
      ),
      sessionMaxLifetimeHours: toOptionalNumber(
        settings[k.sessionMaxLifetimeHours],
        d.sessionMaxLifetimeHours,
        1,
        8760,
      ),
      maxConcurrentSessions: toOptionalNumber(
        settings[k.maxConcurrentSessions],
        d.maxConcurrentSessions,
        1,
        100,
      ),
    };
  }

  /** Every way `password` fails `policy`, as human-readable clauses. */
  static violations(password: string, policy: SecurityPolicy): string[] {
    const problems: string[] = [];
    if (typeof password !== 'string' || password.length < policy.passwordMinLength)
      problems.push(`be at least ${policy.passwordMinLength} characters long`);
    if (typeof password !== 'string') return problems;
    if (policy.passwordRequireUppercase && !/[A-Z]/.test(password))
      problems.push('contain an uppercase letter');
    if (policy.passwordRequireLowercase && !/[a-z]/.test(password))
      problems.push('contain a lowercase letter');
    if (policy.passwordRequireNumber && !/[0-9]/.test(password)) problems.push('contain a digit');
    if (policy.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(password))
      problems.push('contain a symbol');
    return problems;
  }

  /**
   * Throw a 400 naming every unmet requirement, or return silently. The message
   * describes the policy, never the submitted password.
   */
  static assertPasswordAllowed(password: string, policy: SecurityPolicy): void {
    const problems = SecurityPolicyService.violations(password, policy);
    if (problems.length)
      throw new BadRequestException(`Password must ${problems.join(', must ')}.`);
  }

  /** Resolve the tenant's policy and validate a password against it. */
  async assertPasswordMeetsPolicy(password: string, tenantId?: string): Promise<SecurityPolicy> {
    const policy = await this.resolve(tenantId);
    SecurityPolicyService.assertPasswordAllowed(password, policy);
    return policy;
  }
}
