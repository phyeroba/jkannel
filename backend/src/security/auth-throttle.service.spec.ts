import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthThrottledException,
  AuthThrottleService,
  ThrottleRedis,
  authThrottleLimits,
} from './auth-throttle.service';
import { AuthThrottleGuard, ThrottlePolicy } from './auth-throttle.guard';

/**
 * In-memory Redis stand-in with a controllable clock so the window can be
 * expired deliberately. (A near-identical copy lives in auth.service.spec.ts;
 * duplicated rather than exported from a spec file, which jest would re-run.)
 */
class FakeThrottleRedis implements ThrottleRedis {
  counters = new Map<string, number>();
  ttls = new Map<string, number>();
  calls: string[] = [];
  async eval(script: string, numKeys: number, ...args: (string | number)[]) {
    const keys = args.slice(0, numKeys).map(String);
    this.calls.push(script.includes('INCR') ? 'penalize' : 'peek');
    if (script.includes('INCR')) {
      const windows = args.slice(numKeys).map(Number);
      return keys.map((key, index) => {
        const next = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, next);
        if (next === 1) this.ttls.set(key, windows[index]);
        return next;
      });
    }
    const out: number[] = [];
    for (const key of keys) out.push(this.counters.get(key) ?? 0, this.ttls.get(key) ?? -2);
    return out;
  }
  advance(seconds: number) {
    for (const [key, ttl] of [...this.ttls]) {
      const left = ttl - seconds;
      if (left <= 0) {
        this.ttls.delete(key);
        this.counters.delete(key);
      } else this.ttls.set(key, left);
    }
  }
}

/** Redis that is reachable but errors on every command. */
class BrokenRedis implements ThrottleRedis {
  async eval(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica.');
  }
}

function guardContext(request: unknown, handler: (...args: unknown[]) => unknown) {
  const response = {
    headers: {} as Record<string, string>,
    setHeader(n: string, v: string) {
      this.headers[n] = String(v);
    },
  };
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  return { context, response };
}

describe('AuthThrottleService', () => {
  const envKeys = Object.keys(process.env).filter((key) => key.startsWith('AUTH_THROTTLE_'));
  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
    delete process.env.AUTH_THROTTLE_ENABLED;
    delete process.env.AUTH_THROTTLE_MFA_MAX_FAILURES;
    delete process.env.AUTH_THROTTLE_MFA_WINDOW_SECONDS;
    delete process.env.AUTH_THROTTLE_LOGIN_MAX_FAILURES;
    jest.restoreAllMocks();
  });

  describe('limits', () => {
    it('ships defaults that make a 6-digit TOTP unguessable', () => {
      const limits = authThrottleLimits({});
      expect(limits).toMatchObject({
        enabled: true,
        loginMax: 10,
        loginWindow: 900,
        loginIpMax: 50,
        mfaMax: 5,
        mfaWindow: 300,
        resetMax: 5,
        tokenMax: 20,
      });
      // 10^6 codes / 5 per 5 min > 1.9 years.
      const yearsToExhaust = (1e6 / limits.mfaMax) * (limits.mfaWindow / 86400 / 365);
      expect(yearsToExhaust).toBeGreaterThan(1.5);
    });
    it('honours env overrides and ignores nonsense', () => {
      expect(authThrottleLimits({ AUTH_THROTTLE_MFA_MAX_FAILURES: '3' }).mfaMax).toBe(3);
      expect(authThrottleLimits({ AUTH_THROTTLE_MFA_MAX_FAILURES: 'abc' }).mfaMax).toBe(5);
      expect(authThrottleLimits({ AUTH_THROTTLE_ENABLED: 'false' }).enabled).toBe(false);
    });
  });

  describe('peek / penalize', () => {
    let redis: FakeThrottleRedis;
    let throttle: AuthThrottleService;
    beforeEach(() => {
      redis = new FakeThrottleRedis();
      throttle = new AuthThrottleService(redis);
    });

    it('allows while under the ceiling and never consumes budget when inspecting', async () => {
      const buckets = throttle.mfaBuckets('t1', 'u1', '203.0.113.7');
      for (let i = 0; i < 20; i++) await throttle.inspect(buckets);
      expect(redis.counters.size).toBe(0);
      await expect(throttle.inspect(buckets)).resolves.toMatchObject({ allowed: true });
    });

    it('blocks with a Retry-After once the MFA ceiling is reached, then recovers', async () => {
      process.env.AUTH_THROTTLE_MFA_WINDOW_SECONDS = '300';
      const buckets = throttle.mfaBuckets('t1', 'u1', '203.0.113.7');
      for (let i = 0; i < 5; i++) await throttle.penalize(buckets);
      const blocked = await throttle.inspect(buckets);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBe(300);
      await expect(throttle.assertAllowed(buckets)).rejects.toBeInstanceOf(AuthThrottledException);
      // Part of the window elapses — still blocked, with a shorter Retry-After.
      redis.advance(120);
      await expect(throttle.inspect(buckets)).resolves.toMatchObject({
        allowed: false,
        retryAfterSeconds: 180,
      });
      // The window rolls off entirely and the user is allowed again.
      redis.advance(200);
      await expect(throttle.inspect(buckets)).resolves.toMatchObject({ allowed: true });
    });

    it('scopes buckets so one user/IP cannot exhaust another', async () => {
      await throttle.penalize(throttle.mfaBuckets('t1', 'u1', '198.51.100.1'));
      await expect(
        throttle.inspect(throttle.mfaBuckets('t1', 'u2', '198.51.100.9')),
      ).resolves.toMatchObject({ allowed: true });
      expect([...redis.counters.keys()]).toEqual(
        expect.arrayContaining(['auth:mfa:u:t1:u1', 'auth:mfa:ip:198.51.100.1']),
      );
    });

    it('never puts a secret in a key', () => {
      const keys = [
        ...throttle.loginBuckets('acme', 'Operator One', '203.0.113.7'),
        ...throttle.resetBuckets('acme', 'operator', '203.0.113.7'),
        ...throttle.tokenBuckets('refresh', '203.0.113.7'),
      ].map((bucket) => bucket.key);
      expect(keys.every((key) => !/\s/.test(key))).toBe(true);
      expect(keys).toContain('auth:login:u:acme:operator_one:203.0.113.7');
    });

    it('treats a zero limit as disabled', async () => {
      process.env.AUTH_THROTTLE_MFA_MAX_FAILURES = '0';
      process.env.AUTH_THROTTLE_MFA_IP_MAX_FAILURES = '0';
      const buckets = throttle.mfaBuckets('t1', 'u1', '203.0.113.7');
      await throttle.penalize(buckets);
      expect(redis.counters.size).toBe(0);
      await expect(throttle.inspect(buckets)).resolves.toMatchObject({ allowed: true });
    });

    it('is a no-op when disabled by env', async () => {
      process.env.AUTH_THROTTLE_ENABLED = 'false';
      const buckets = throttle.mfaBuckets('t1', 'u1', '203.0.113.7');
      await throttle.penalize(buckets);
      await throttle.penalize(buckets);
      expect(redis.counters.size).toBe(0);
      await expect(throttle.inspect(buckets)).resolves.toMatchObject({ allowed: true });
    });
  });

  // The single most important property: a cache outage must never lock the
  // operator out of their own platform.
  describe('fail open', () => {
    it('allows and warns when there is no Redis client at all', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const throttle = new AuthThrottleService(null);
      const decision = await throttle.inspect(throttle.mfaBuckets('t1', 'u1', '203.0.113.7'));
      expect(decision).toMatchObject({ allowed: true, degraded: true });
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('auth throttle failing open');
    });

    it('allows and warns when Redis errors', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const throttle = new AuthThrottleService(new BrokenRedis());
      await expect(
        throttle.inspect(throttle.loginBuckets('acme', 'operator', '203.0.113.7')),
      ).resolves.toMatchObject({ allowed: true, degraded: true });
      // assertAllowed must not throw either.
      await expect(
        throttle.assertAllowed(throttle.loginBuckets('acme', 'operator', '203.0.113.7')),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });

    it('swallows a failing penalty write rather than turning a 401 into a 500', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const throttle = new AuthThrottleService(new BrokenRedis());
      await expect(
        throttle.penalize(throttle.mfaBuckets('t1', 'u1', '203.0.113.7')),
      ).resolves.toBeUndefined();
    });
  });
});

describe('AuthThrottleGuard', () => {
  class Handlers {
    @ThrottlePolicy('mfa') mfa() {}
    @ThrottlePolicy('login') login() {}
    unthrottled() {}
  }
  const handlers = new Handlers();
  let redis: FakeThrottleRedis;
  let throttle: AuthThrottleService;
  let guard: AuthThrottleGuard;
  beforeEach(() => {
    redis = new FakeThrottleRedis();
    throttle = new AuthThrottleService(redis);
    guard = new AuthThrottleGuard(new Reflector(), throttle);
  });

  it('lets an undecorated handler through without touching Redis', async () => {
    const { context } = guardContext({ clientIp: '203.0.113.7' }, handlers.unthrottled);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.calls).toHaveLength(0);
  });

  it('returns 429 with Retry-After once MFA verification is exhausted, then recovers', async () => {
    const request = { clientIp: '203.0.113.7', principal: { tenantId: 't1', userId: 'u1' } };
    const { context, response } = guardContext(request, handlers.mfa);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Five wrong codes.
    for (let i = 0; i < 5; i++)
      await throttle.penalize(throttle.mfaBuckets('t1', 'u1', '203.0.113.7'));
    const error = await guard.canActivate(context).catch((caught) => caught);
    expect(error).toBeInstanceOf(AuthThrottledException);
    expect(error.getStatus()).toBe(429);
    expect(error.retryAfterSeconds).toBe(300);
    expect(response.headers['Retry-After']).toBe('300');
    expect(error.getResponse()).toMatchObject({ retryAfterSeconds: 300 });
    // No password material or code echoed back.
    expect(JSON.stringify(error.getResponse())).not.toMatch(/\d{6}/);
    // Window elapses -> allowed again.
    redis.advance(301);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('keys login on the derived clientIp, not a spoofable header value', async () => {
    const request = {
      clientIp: '203.0.113.7',
      ip: '172.18.0.3',
      headers: { 'x-forwarded-for': '9.9.9.9' },
      body: { tenant: 'acme', username: 'operator' },
    };
    const { context } = guardContext(request, handlers.login);
    for (let i = 0; i < 10; i++)
      await throttle.penalize(throttle.loginBuckets('acme', 'operator', '203.0.113.7'));
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthThrottledException);
    // Nothing was ever recorded under the forged address.
    expect([...redis.counters.keys()].some((key) => key.includes('9.9.9.9'))).toBe(false);
  });

  it('fails open when Redis is down', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const openGuard = new AuthThrottleGuard(new Reflector(), new AuthThrottleService(null));
    const { context } = guardContext(
      { clientIp: '203.0.113.7', principal: { tenantId: 't1', userId: 'u1' } },
      handlers.mfa,
    );
    await expect(openGuard.canActivate(context)).resolves.toBe(true);
    jest.restoreAllMocks();
  });
});
