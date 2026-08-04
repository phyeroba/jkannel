import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthRepository, AuditSink } from './auth.ports';
import {
  AuthSession,
  AuditEvent,
  PasswordResetTarget,
  PasswordResetToken,
  PendingInvitation,
  UserCredential,
} from './auth.types';
import { AuthService } from './auth.service';
import { IdentityStore, LoginHistoryEntry, MfaLoginDevice } from './identity.repository';
import { encryptSecret, normalizeRecoveryCode, sha256Hex } from './identity-crypto';
import { generateTotp, newTotpSecret } from './identity-totp';
import { PasswordHasher } from './password-hasher';
import { TokenService } from './token.service';
import { AuthThrottleService, ThrottleRedis } from './auth-throttle.service';
import { randomUUID } from 'node:crypto';

class MemoryIdentity implements IdentityStore {
  device?: MfaLoginDevice;
  recovery: Array<{ id: string; codeHash: string; used: boolean }> = [];
  loginHistory: LoginHistoryEntry[] = [];
  passwordHistory: string[] = [];
  currentHash?: string;
  touched = false;
  async findConfirmedMfaDevice() {
    return this.device;
  }
  async touchMfaDevice() {
    this.touched = true;
  }
  async findActiveRecoveryCode(_t: string, _u: string, codeHash: string) {
    const record = this.recovery.find((entry) => entry.codeHash === codeHash && !entry.used);
    return record ? { id: record.id } : undefined;
  }
  async burnRecoveryCode(id: string) {
    const record = this.recovery.find((entry) => entry.id === id);
    if (record) record.used = true;
  }
  async recordLoginHistory(entry: LoginHistoryEntry) {
    this.loginHistory.push(entry);
  }
  async currentPasswordHash() {
    return this.currentHash;
  }
  async recentPasswordHashes(_t: string, _u: string, limit: number) {
    return this.passwordHistory.slice(-limit).reverse();
  }
  async addPasswordHistory(_t: string, _u: string, hash: string) {
    this.passwordHistory.push(hash);
  }
}

/**
 * In-memory stand-in for the Redis behind AuthThrottleService. It distinguishes
 * the two Lua scripts by looking for INCR, and models TTLs well enough to prove
 * the window rolls off. Kept local to the spec (a near-identical copy lives in
 * auth-throttle.service.spec.ts) so no test-only module leaks into src/.
 */
class FakeThrottleRedis implements ThrottleRedis {
  counters = new Map<string, number>();
  ttls = new Map<string, number>();
  async eval(script: string, numKeys: number, ...args: (string | number)[]) {
    const keys = args.slice(0, numKeys).map(String);
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
    for (const key of keys) {
      out.push(this.counters.get(key) ?? 0, this.ttls.get(key) ?? -2);
    }
    return out;
  }
  /** Simulate every window expiring. */
  expireAll() {
    this.counters.clear();
    this.ttls.clear();
  }
}

interface StoredResetToken extends PasswordResetToken {
  tokenHash: string;
}

class MemoryAuth implements AuthRepository, AuditSink {
  credential?: UserCredential;
  session?: AuthSession;
  events: AuditEvent[] = [];
  resetTokens: StoredResetToken[] = [];
  invitations = new Map<string, PendingInvitation>();
  createdUsers: Array<{ username: string; tenantId: string; roleId?: string }> = [];
  takenUsernames = new Set<string>();
  async findCredential(tenant: string, username: string) {
    return tenant === 'acme' && username === 'operator' ? this.credential : undefined;
  }
  // Mirrors the production lookup: same columns, same role/permission
  // aggregation, keyed by id. refresh() reads through this so a token rotation
  // reflects the CURRENT row rather than the claims it was handed.
  async findCredentialById(userId: string) {
    return this.credential?.id === userId ? this.credential : undefined;
  }
  // These two mirror the SQL in postgres-auth.repository.ts exactly. They used to
  // only touch failedLoginCount/lockedUntil, which diverged from production (the
  // real UPDATE also flips status to 'locked', and only a successful login flips
  // it back) — that divergence is what hid the permanent-lockout defect from this
  // suite. Keep them faithful to the queries.
  async recordFailedLogin(_: string, count: number, locked?: Date) {
    if (this.credential) {
      this.credential.failedLoginCount = count;
      this.credential.lockedUntil = locked;
      if (locked) this.credential.status = 'locked';
    }
  }
  async recordSuccessfulLogin() {
    if (this.credential) {
      this.credential.failedLoginCount = 0;
      this.credential.lockedUntil = undefined;
      if (this.credential.status === 'locked') this.credential.status = 'active';
    }
  }
  async saveSession(session: AuthSession) {
    this.session = { ...session };
  }
  async findSession(id: string) {
    return this.session?.id === id ? this.session : undefined;
  }
  async revokeSession(_: string, at: Date) {
    if (this.session) this.session.revokedAt = at;
  }
  async revokeSessionFamily(familyId: string, at: Date) {
    if (this.session && this.session.familyId === familyId && !this.session.revokedAt)
      this.session.revokedAt = at;
  }
  async append(event: AuditEvent) {
    this.events.push(event);
  }
  async findResetTarget(
    tenant: string,
    username: string,
  ): Promise<PasswordResetTarget | undefined> {
    if (tenant === 'acme' && username === 'operator' && this.credential)
      return { userId: this.credential.id, tenantId: this.credential.tenantId };
    return undefined;
  }
  async createPasswordResetToken(token: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }) {
    this.resetTokens.push({
      id: randomUUID(),
      tenantId: token.tenantId,
      userId: token.userId,
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    });
  }
  async findPasswordResetToken(tokenHash: string) {
    return this.resetTokens.find((t) => t.tokenHash === tokenHash);
  }
  async markPasswordResetTokenUsed(id: string, usedAt: Date) {
    const token = this.resetTokens.find((t) => t.id === id);
    if (token) token.usedAt = usedAt;
  }
  async applyNewPassword(userId: string, passwordHash: string) {
    if (this.credential && this.credential.id === userId) {
      this.credential.passwordHash = passwordHash;
      this.credential.status = 'active';
      this.credential.failedLoginCount = 0;
      this.credential.lockedUntil = undefined;
    }
  }
  async revokeUserSessions(userId: string, revokedAt: Date) {
    if (this.session && this.session.userId === userId) this.session.revokedAt = revokedAt;
  }
  async findPendingInvitation(tokenHash: string) {
    return this.invitations.get(tokenHash);
  }
  async acceptInvitation(input: {
    invitationId: string;
    tenantId: string;
    username: string;
    passwordHash: string;
    roleId?: string;
    acceptedAt: Date;
  }) {
    if (this.takenUsernames.has(input.username)) {
      const error = new Error('duplicate') as Error & { code?: string };
      error.code = '23505';
      throw error;
    }
    this.takenUsernames.add(input.username);
    this.createdUsers.push({
      username: input.username,
      tenantId: input.tenantId,
      roleId: input.roleId,
    });
    return { userId: 'new-user-id' };
  }
}

describe('AuthService', () => {
  const key = 'test-authentication-key-with-32-bytes-minimum';
  let store: MemoryAuth;
  let service: AuthService;
  beforeEach(async () => {
    process.env.AUTH_SIGNING_KEY = key;
    delete process.env.NODE_ENV;
    store = new MemoryAuth();
    const hasher = new PasswordHasher();
    store.credential = {
      id: 'u1',
      tenantId: '1',
      username: 'operator',
      passwordHash: await hasher.hash('Correct horse battery staple 1'),
      status: 'active',
      failedLoginCount: 0,
      roles: ['operator'],
      permissions: ['dashboard.view'],
    };
    service = new AuthService(store, store, hasher, new TokenService());
  });
  it('logs in, rotates refresh token, and revokes session', async () => {
    const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
    expect(first.accessToken).toBeTruthy();
    const next = await service.refresh(first.refreshToken);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    await service.logout(next.refreshToken);
    expect(store.session?.revokedAt).toBeInstanceOf(Date);
    expect(store.events.map((e) => e.action)).toEqual([
      'login.succeeded',
      'token.refreshed',
      'logout',
    ]);
  });
  it('locks after five failed attempts without revealing account state', async () => {
    for (let i = 0; i < 5; i++)
      await expect(service.login('acme', 'operator', 'wrong password')).rejects.toThrow(
        'Invalid credentials',
      );
    expect(store.credential?.lockedUntil).toBeInstanceOf(Date);
    expect(store.events).toHaveLength(5);
  });
  it('does not re-extend the lockout window on attempts made while locked', async () => {
    for (let i = 0; i < 5; i++)
      await expect(service.login('acme', 'operator', 'wrong password')).rejects.toThrow(
        'Invalid credentials',
      );
    const lockedUntil = store.credential!.lockedUntil;
    const countAtLock = store.credential!.failedLoginCount;
    const eventsAtLock = store.events.length;
    // A further attempt while locked — even with the CORRECT password — must be
    // rejected without touching the counter or extending the window, otherwise a
    // legitimate user could never recover from a lockout.
    await expect(
      service.login('acme', 'operator', 'Correct horse battery staple 1'),
    ).rejects.toThrow('Invalid credentials');
    expect(store.credential!.lockedUntil).toBe(lockedUntil);
    expect(store.credential!.failedLoginCount).toBe(countAtLock);
    expect(store.events).toHaveLength(eventsAtLock + 1);
    expect(store.events.at(-1)?.reason).toBe('account_locked');
  });
  it('lets the account back in once the lockout window has expired', async () => {
    for (let i = 0; i < 5; i++)
      await expect(service.login('acme', 'operator', 'wrong password')).rejects.toThrow(
        'Invalid credentials',
      );
    // recordFailedLogin sets status='locked' as well as locked_until, but only
    // locked_until expires. Simulate the window elapsing.
    expect(store.credential!.status).toBe('locked');
    store.credential!.lockedUntil = new Date(Date.now() - 60_000);
    // The correct password must now work. Previously the stale 'locked' status
    // failed the "account is not active" check forever, so five bad guesses from
    // an unauthenticated attacker disabled any account permanently.
    const session = await service.login('acme', 'operator', 'Correct horse battery staple 1');
    expect(session.accessToken).toBeTruthy();
    // A successful login clears the lock entirely.
    expect(store.credential!.status).toBe('active');
    expect(store.credential!.lockedUntil).toBeUndefined();
    expect(store.credential!.failedLoginCount).toBe(0);
  });
  it('still rejects a genuinely inactive account', async () => {
    store.credential!.status = 'pending';
    await expect(
      service.login('acme', 'operator', 'Correct horse battery staple 1'),
    ).rejects.toThrow('Account is not active');
  });

  describe('password reset', () => {
    it('issues a dev token for an existing user and audits the request', async () => {
      const result = await service.requestPasswordReset('acme', 'operator');
      expect(result.requested).toBe(true);
      expect(result.devToken).toBeTruthy();
      expect(store.resetTokens).toHaveLength(1);
      expect(store.events.at(-1)?.action).toBe('password.reset.requested');
    });
    it('does not reveal or create anything for an unknown user', async () => {
      const result = await service.requestPasswordReset('acme', 'ghost');
      expect(result).toEqual({ requested: true });
      expect(store.resetTokens).toHaveLength(0);
      expect(store.events).toHaveLength(0);
    });
    it('omits the dev token in production', async () => {
      process.env.NODE_ENV = 'production';
      const result = await service.requestPasswordReset('acme', 'operator');
      expect(result.devToken).toBeUndefined();
    });
    it('resets the password, revokes sessions, and rejects token reuse', async () => {
      store.session = {
        id: 's1',
        tenantId: '1',
        userId: 'u1',
        refreshTokenHash: 'x',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        lastSeenAt: new Date(),
      };
      const { devToken } = await service.requestPasswordReset('acme', 'operator');
      const result = await service.confirmPasswordReset(devToken!, 'Brand new password 1');
      expect(result).toEqual({ reset: true });
      expect(store.session.revokedAt).toBeInstanceOf(Date);
      expect(store.resetTokens[0].usedAt).toBeInstanceOf(Date);
      expect(store.events.at(-1)?.action).toBe('password.reset.completed');
      await expect(
        service.confirmPasswordReset(devToken!, 'Another good password 2'),
      ).rejects.toThrow(BadRequestException);
    });
    it('rejects a short new password', async () => {
      const { devToken } = await service.requestPasswordReset('acme', 'operator');
      await expect(service.confirmPasswordReset(devToken!, 'short')).rejects.toThrow(
        BadRequestException,
      );
    });
    it('rejects an unknown token', async () => {
      await expect(service.confirmPasswordReset('nope', 'Brand new password 1')).rejects.toThrow(
        BadRequestException,
      );
    });
    it('rejects an expired token', async () => {
      store.resetTokens.push({
        id: 't-exp',
        tenantId: '1',
        userId: 'u1',
        tokenHash: require('node:crypto')
          .createHash('sha256')
          .update('expired-token')
          .digest('hex'),
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.confirmPasswordReset('expired-token', 'Brand new password 1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('invitation acceptance', () => {
    const hash = (token: string) =>
      require('node:crypto').createHash('sha256').update(token).digest('hex');
    beforeEach(() => {
      store.invitations.set(hash('invite-1'), { id: 'inv-1', tenantId: '1', roleId: 'role-1' });
    });
    it('creates an active user, assigns the role, and audits acceptance', async () => {
      const result = await service.acceptInvitation('invite-1', 'newoperator', 'Valid password 12');
      expect(result).toEqual({ accepted: true });
      expect(store.createdUsers).toEqual([
        { username: 'newoperator', tenantId: '1', roleId: 'role-1' },
      ]);
      expect(store.events.at(-1)?.action).toBe('user.invitation.accepted');
    });
    it('rejects an invalid or expired invitation', async () => {
      await expect(
        service.acceptInvitation('missing', 'newoperator', 'Valid password 12'),
      ).rejects.toThrow(BadRequestException);
    });
    it('rejects a short password before touching the store', async () => {
      await expect(service.acceptInvitation('invite-1', 'newoperator', 'short')).rejects.toThrow(
        BadRequestException,
      );
      expect(store.createdUsers).toHaveLength(0);
    });
    it('surfaces a duplicate username as a conflict', async () => {
      store.takenUsernames.add('newoperator');
      await expect(
        service.acceptInvitation('invite-1', 'newoperator', 'Valid password 12'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('multi-factor enforcement', () => {
    let identity: MemoryIdentity;
    let secret: string;
    beforeEach(() => {
      identity = new MemoryIdentity();
      secret = newTotpSecret();
      identity.device = { id: 'd1', secretEncrypted: encryptSecret(secret) };
      service = new AuthService(store, store, new PasswordHasher(), new TokenService(), identity);
    });
    it('rejects login without a code and reports mfaRequired', async () => {
      const error = await service
        .login('acme', 'operator', 'Correct horse battery staple 1')
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.getResponse()).toMatchObject({ mfaRequired: true });
      expect(identity.loginHistory.at(-1)?.outcome).toBe('mfa_required');
    });
    it('accepts a valid TOTP code and burns nothing', async () => {
      const token = generateTotp(secret);
      const result = await service.login(
        'acme',
        'operator',
        'Correct horse battery staple 1',
        {},
        { totp: token },
      );
      expect(result.accessToken).toBeTruthy();
      expect(identity.touched).toBe(true);
      expect(identity.loginHistory.at(-1)).toMatchObject({ outcome: 'success', mfaUsed: true });
    });
    it('accepts and burns a single-use recovery code', async () => {
      const code = 'abcde-fghij';
      identity.recovery.push({
        id: 'r1',
        codeHash: sha256Hex(normalizeRecoveryCode(code)),
        used: false,
      });
      const result = await service.login(
        'acme',
        'operator',
        'Correct horse battery staple 1',
        {},
        { recoveryCode: code },
      );
      expect(result.accessToken).toBeTruthy();
      expect(identity.recovery[0].used).toBe(true);
    });
    it('rejects an incorrect TOTP code', async () => {
      await expect(
        service.login('acme', 'operator', 'Correct horse battery staple 1', {}, { totp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    });
    // G12/3 — the MFA-failure branch used to skip recordFailedLogin entirely, so
    // a 6-digit code could be guessed without limit against a known password.
    it('counts a wrong TOTP code towards lockout', async () => {
      for (let i = 0; i < 5; i++)
        await expect(
          service.login(
            'acme',
            'operator',
            'Correct horse battery staple 1',
            {},
            { totp: '000000' },
          ),
        ).rejects.toThrow(UnauthorizedException);
      expect(store.credential!.failedLoginCount).toBe(5);
      expect(store.credential!.lockedUntil).toBeInstanceOf(Date);
      expect(store.events.at(-1)?.reason).toBe('mfa_invalid');
      // Even the correct code is now refused while the window is open.
      await expect(
        service.login(
          'acme',
          'operator',
          'Correct horse battery staple 1',
          {},
          { totp: generateTotp(secret) },
        ),
      ).rejects.toThrow('Invalid credentials');
    });
    it('counts a wrong recovery code towards lockout', async () => {
      await expect(
        service.login(
          'acme',
          'operator',
          'Correct horse battery staple 1',
          {},
          { recoveryCode: 'aaaaa-bbbbb' },
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(store.credential!.failedLoginCount).toBe(1);
    });
    it('does not penalise the first leg of a normal MFA login (no code supplied)', async () => {
      await expect(
        service.login('acme', 'operator', 'Correct horse battery staple 1'),
      ).rejects.toThrow(UnauthorizedException);
      expect(store.credential!.failedLoginCount).toBe(0);
      expect(store.events.at(-1)?.reason).toBe('mfa_required');
    });
  });

  // G12/3 — the service records penalties; AuthThrottleGuard reads them. The
  // key property proven here is that SUCCESS costs nothing, which is what keeps
  // the perf harness (~7 rps of good logins from one host) unaffected.
  describe('throttle penalties', () => {
    let redis: FakeThrottleRedis;
    let throttle: AuthThrottleService;
    beforeEach(() => {
      redis = new FakeThrottleRedis();
      throttle = new AuthThrottleService(redis);
      service = new AuthService(
        store,
        store,
        new PasswordHasher(),
        new TokenService(),
        undefined,
        throttle,
      );
    });
    it('records nothing for a successful login', async () => {
      await service.login('acme', 'operator', 'Correct horse battery staple 1', {
        ipAddress: '203.0.113.7',
      });
      expect(redis.counters.size).toBe(0);
    });
    it('records a penalty on both the account and the IP bucket for a bad password', async () => {
      await expect(
        service.login('acme', 'operator', 'nope nope nope', { ipAddress: '203.0.113.7' }),
      ).rejects.toThrow(UnauthorizedException);
      const keys = [...redis.counters.keys()];
      expect(keys).toEqual(
        expect.arrayContaining([
          'auth:login:u:acme:operator:203.0.113.7',
          'auth:login:ip:203.0.113.7',
        ]),
      );
      expect(redis.counters.get('auth:login:ip:203.0.113.7')).toBe(1);
    });
    it('reaches the ceiling and reports 429-worthy state, then clears with the window', async () => {
      const buckets = throttle.loginBuckets('acme', 'operator', '203.0.113.7');
      for (let i = 0; i < 10; i++)
        await expect(
          service.login('acme', 'operator', 'nope nope nope', { ipAddress: '203.0.113.7' }),
        ).rejects.toThrow(UnauthorizedException);
      const blocked = await throttle.inspect(buckets);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      redis.expireAll();
      await expect(throttle.inspect(buckets)).resolves.toMatchObject({ allowed: true });
    });
    it('penalises a reset request even though the response is deliberately uniform', async () => {
      await service.requestPasswordReset('acme', 'ghost', { ipAddress: '203.0.113.7' });
      expect(redis.counters.get('auth:reset:ip:203.0.113.7')).toBe(1);
    });
    it('penalises an invalid refresh token', async () => {
      await expect(service.refresh('not-a-token', { ipAddress: '203.0.113.7' })).rejects.toThrow();
      expect(redis.counters.get('auth:token:refresh:ip:203.0.113.7')).toBe(1);
    });
  });

  describe('refresh token reuse', () => {
    it('revokes the family when a rotated refresh token is replayed', async () => {
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      const next = await service.refresh(first.refreshToken);
      await expect(service.refresh(first.refreshToken)).rejects.toThrow(
        'Refresh token reuse detected',
      );
      expect(store.session?.revokedAt).toBeInstanceOf(Date);
      expect(store.session?.reusedAt).toBeInstanceOf(Date);
      // The family is burned, so even the current refresh token is dead.
      await expect(service.refresh(next.refreshToken)).rejects.toThrow('Invalid refresh token');
      expect(store.events.map((event) => event.action)).toContain('token.reuse.detected');
    });
  });

  // G12/1 — refresh() used to rebuild the principal from the incoming token's
  // own claims, so a disabled or demoted user kept full access for the whole
  // 7-day refresh lifetime. It must now re-read the user row.
  describe('privilege re-resolution on refresh', () => {
    const claimsOf = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
        roles: string[];
        permissions: string[];
        username: string;
        sub: string;
      };

    it('rejects a refresh once the account has been disabled and kills the family', async () => {
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      store.credential!.status = 'disabled';
      await expect(service.refresh(first.refreshToken)).rejects.toThrow(
        'Account is no longer active',
      );
      expect(store.session?.revokedAt).toBeInstanceOf(Date);
      expect(store.events.at(-1)).toMatchObject({
        action: 'token.refresh.rejected',
        reason: 'user_status_disabled',
      });
      // The refresh token is dead even if the account is re-enabled.
      store.credential!.status = 'active';
      await expect(service.refresh(first.refreshToken)).rejects.toThrow('Invalid refresh token');
    });

    it.each(['archived', 'deleted', 'pending', 'expired'] as const)(
      'rejects a refresh for a %s account',
      async (status) => {
        const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
        store.credential!.status = status;
        await expect(service.refresh(first.refreshToken)).rejects.toThrow(
          'Account is no longer active',
        );
      },
    );

    it('rejects a refresh when the user row has vanished', async () => {
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      store.credential = undefined;
      await expect(service.refresh(first.refreshToken)).rejects.toThrow(
        'Account is no longer active',
      );
      expect(store.events.at(-1)?.reason).toBe('user_not_found');
    });

    it('still allows refresh while the account is merely locked out', async () => {
      // Lockout is attacker-triggerable from an unauthenticated endpoint, so
      // treating it as "no longer a user" would let anyone terminate a victim's
      // sessions with five bad guesses.
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      store.credential!.status = 'locked';
      await expect(service.refresh(first.refreshToken)).resolves.toMatchObject({
        tokenType: 'Bearer',
      });
    });

    it('picks up a revoked permission instead of replaying stale claims', async () => {
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      expect(claimsOf(first.accessToken).permissions).toEqual(['dashboard.view']);
      // An administrator strips the permission and removes the role.
      store.credential!.permissions = [];
      store.credential!.roles = [];
      const next = await service.refresh(first.refreshToken);
      const claims = claimsOf(next.accessToken);
      expect(claims.permissions).toEqual([]);
      expect(claims.roles).toEqual([]);
      // The rotated refresh token carries the reduced set too.
      expect(claimsOf(next.refreshToken).permissions).toEqual([]);
    });

    it('picks up a newly granted permission and a renamed username', async () => {
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      store.credential!.permissions = ['dashboard.view', 'smsc.manage'];
      store.credential!.roles = ['operator', 'admin'];
      store.credential!.username = 'operator2';
      const claims = claimsOf((await service.refresh(first.refreshToken)).accessToken);
      expect(claims.permissions).toEqual(['dashboard.view', 'smsc.manage']);
      expect(claims.roles).toEqual(['operator', 'admin']);
      expect(claims.username).toBe('operator2');
    });

    it('rejects a refresh whose session belongs to another tenant', async () => {
      const first = await service.login('acme', 'operator', 'Correct horse battery staple 1');
      store.credential!.tenantId = '999';
      await expect(service.refresh(first.refreshToken)).rejects.toThrow(
        'Account is no longer active',
      );
    });
  });

  describe('password history', () => {
    let identity: MemoryIdentity;
    beforeEach(() => {
      identity = new MemoryIdentity();
      service = new AuthService(store, store, new PasswordHasher(), new TokenService(), identity);
      identity.currentHash = store.credential!.passwordHash;
    });
    it('rejects reuse of the current password', async () => {
      const { devToken } = await service.requestPasswordReset('acme', 'operator');
      await expect(
        service.confirmPasswordReset(devToken!, 'Correct horse battery staple 1'),
      ).rejects.toThrow('New password must differ');
    });
    it('archives the outgoing hash and accepts a fresh password', async () => {
      const { devToken } = await service.requestPasswordReset('acme', 'operator');
      const result = await service.confirmPasswordReset(devToken!, 'A brand new password 2');
      expect(result).toEqual({ reset: true });
      expect(identity.passwordHistory).toHaveLength(1);
    });
  });
});
