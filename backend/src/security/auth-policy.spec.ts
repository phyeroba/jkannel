import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthRepository, AuditSink } from './auth.ports';
import { AuditEvent, AuthSession, UserCredential } from './auth.types';
import { PasswordHasher } from './password-hasher';
import { TokenService } from './token.service';
import {
  SECURITY_SETTING_KEYS,
  SecurityPolicyService,
  SecuritySettingsSource,
} from './security-policy.service';

/**
 * Proves the System Settings security knobs are load-bearing rather than
 * decorative: the lockout threshold/window, the access-token lifetime, the
 * session idle timeout, the absolute session lifetime and the concurrent-session
 * cap were all hardcoded literals in auth.service.ts before this.
 *
 * Deliberately a separate file from auth.service.spec.ts, which pins the
 * behaviour with NO policy service injected (i.e. the defaults). Both must hold.
 */
const PASSWORD = 'Correct horse battery staple 1';

class PolicyStore implements AuthRepository, AuditSink {
  credential!: UserCredential;
  session?: AuthSession;
  events: AuditEvent[] = [];
  concurrentCalls: Array<{ userId: string; keep: number }> = [];
  async findCredential(tenant: string, username: string) {
    return tenant === 'acme' && username === 'operator' ? this.credential : undefined;
  }
  async findCredentialById(userId: string) {
    return this.credential.id === userId ? this.credential : undefined;
  }
  async recordFailedLogin(_id: string, count: number, locked?: Date) {
    this.credential.failedLoginCount = count;
    this.credential.lockedUntil = locked;
    if (locked) this.credential.status = 'locked';
  }
  async recordSuccessfulLogin() {
    this.credential.failedLoginCount = 0;
    this.credential.lockedUntil = undefined;
    if (this.credential.status === 'locked') this.credential.status = 'active';
  }
  async saveSession(session: AuthSession) {
    this.session = { ...session };
  }
  async findSession(id: string) {
    return this.session?.id === id ? this.session : undefined;
  }
  async revokeSession(_id: string, at: Date) {
    if (this.session) this.session.revokedAt = at;
  }
  async revokeSessionFamily(_familyId: string, at: Date) {
    if (this.session) this.session.revokedAt = at;
  }
  async enforceConcurrentSessionLimit(userId: string, keep: number) {
    this.concurrentCalls.push({ userId, keep });
    return 2;
  }
  async findResetTarget() {
    return undefined;
  }
  async createPasswordResetToken() {}
  async findPasswordResetToken() {
    return undefined;
  }
  async markPasswordResetTokenUsed() {}
  async applyNewPassword() {}
  async revokeUserSessions() {}
  async findPendingInvitation() {
    return undefined;
  }
  async acceptInvitation() {
    return { userId: 'new' };
  }
  async append(event: AuditEvent) {
    this.events.push(event);
  }
}

class FixedSettings implements SecuritySettingsSource {
  constructor(private readonly rows: Record<string, unknown>) {}
  async loadSecuritySettings() {
    return this.rows;
  }
}

const build = async (rows: Record<string, unknown>) => {
  process.env.AUTH_SIGNING_KEY = 'test-authentication-key-with-32-bytes-minimum';
  const hasher = new PasswordHasher();
  const store = new PolicyStore();
  store.credential = {
    id: 'u1',
    tenantId: '1',
    username: 'operator',
    passwordHash: await hasher.hash(PASSWORD),
    status: 'active',
    failedLoginCount: 0,
    roles: ['operator'],
    permissions: ['dashboard.view'],
  };
  const policies = new SecurityPolicyService(new FixedSettings(rows));
  return {
    store,
    policies,
    service: new AuthService(
      store,
      store,
      hasher,
      new TokenService(),
      undefined,
      undefined,
      policies,
    ),
  };
};

describe('AuthService security-policy enforcement', () => {
  it('locks the account at the configured threshold, not the hardcoded 5', async () => {
    const { store, service } = await build({
      [SECURITY_SETTING_KEYS.lockoutThreshold]: 3,
      [SECURITY_SETTING_KEYS.lockoutMinutes]: 45,
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(service.login('acme', 'operator', 'wrong')).rejects.toThrow(
        UnauthorizedException,
      );
    expect(store.credential.lockedUntil).toBeUndefined();
    await expect(service.login('acme', 'operator', 'wrong')).rejects.toThrow(UnauthorizedException);
    expect(store.credential.lockedUntil).toBeInstanceOf(Date);
    expect(store.credential.status).toBe('locked');
    // 45 minutes, not the previously hardcoded 15.
    const windowMinutes = Math.round(
      (store.credential.lockedUntil!.getTime() - Date.now()) / 60_000,
    );
    expect(windowMinutes).toBeGreaterThanOrEqual(44);
    expect(windowMinutes).toBeLessThanOrEqual(45);
  });

  it('issues an access token with the configured lifetime', async () => {
    const { service } = await build({ [SECURITY_SETTING_KEYS.accessTokenTtlSeconds]: 1800 });
    const session = await service.login('acme', 'operator', PASSWORD);
    expect(session.expiresIn).toBe(1800);
    expect((await service.refresh(session.refreshToken)).expiresIn).toBe(1800);
  });

  it('refuses a refresh once the idle timeout has elapsed, and revokes the session', async () => {
    const { store, service } = await build({
      [SECURITY_SETTING_KEYS.sessionIdleTimeoutMinutes]: 30,
    });
    const session = await service.login('acme', 'operator', PASSWORD);
    // Backdate the last rotation past the idle window.
    store.session!.lastSeenAt = new Date(Date.now() - 31 * 60_000);
    await expect(service.refresh(session.refreshToken)).rejects.toThrow('Session expired');
    expect(store.session!.revokedAt).toBeInstanceOf(Date);
    const rejection = store.events.at(-1);
    expect(rejection?.action).toBe('token.refresh.rejected');
    expect(rejection?.reason).toBe('session_idle_timeout');
  });

  it('allows a refresh inside the idle window', async () => {
    const { store, service } = await build({
      [SECURITY_SETTING_KEYS.sessionIdleTimeoutMinutes]: 30,
    });
    const session = await service.login('acme', 'operator', PASSWORD);
    store.session!.lastSeenAt = new Date(Date.now() - 10 * 60_000);
    await expect(service.refresh(session.refreshToken)).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
    expect(store.session!.revokedAt).toBeUndefined();
  });

  it('refuses a refresh past the absolute session lifetime even when active', async () => {
    const { store, service } = await build({
      [SECURITY_SETTING_KEYS.sessionIdleTimeoutMinutes]: 0,
      [SECURITY_SETTING_KEYS.sessionMaxLifetimeHours]: 8,
    });
    const session = await service.login('acme', 'operator', PASSWORD);
    store.session!.createdAt = new Date(Date.now() - 9 * 3_600_000);
    store.session!.lastSeenAt = new Date();
    await expect(service.refresh(session.refreshToken)).rejects.toThrow('Session expired');
    expect(store.events.at(-1)?.reason).toBe('session_max_lifetime');
  });

  it('caps the session row to the configured absolute lifetime at login', async () => {
    const { store, service } = await build({
      [SECURITY_SETTING_KEYS.sessionMaxLifetimeHours]: 8,
    });
    await service.login('acme', 'operator', PASSWORD);
    const lifetimeHours =
      (store.session!.expiresAt.getTime() - store.session!.createdAt.getTime()) / 3_600_000;
    expect(Math.round(lifetimeHours)).toBe(8);
  });

  it('never expires a session when both session knobs are 0', async () => {
    const { store, service } = await build({
      [SECURITY_SETTING_KEYS.sessionIdleTimeoutMinutes]: 0,
      [SECURITY_SETTING_KEYS.sessionMaxLifetimeHours]: 0,
    });
    const session = await service.login('acme', 'operator', PASSWORD);
    store.session!.lastSeenAt = new Date(Date.now() - 400 * 3_600_000);
    store.session!.createdAt = new Date(Date.now() - 400 * 3_600_000);
    await expect(service.refresh(session.refreshToken)).resolves.toBeDefined();
  });

  it('trims the user down to the concurrent-session cap on login', async () => {
    const { store, service } = await build({ [SECURITY_SETTING_KEYS.maxConcurrentSessions]: 2 });
    await service.login('acme', 'operator', PASSWORD);
    expect(store.concurrentCalls).toEqual([{ userId: 'u1', keep: 2 }]);
    expect(store.events.map((event) => event.action)).toContain('session.limit.enforced');
  });

  it('leaves concurrent sessions alone when the cap is unset', async () => {
    const { store, service } = await build({ [SECURITY_SETTING_KEYS.maxConcurrentSessions]: 0 });
    await service.login('acme', 'operator', PASSWORD);
    expect(store.concurrentCalls).toEqual([]);
  });
});
