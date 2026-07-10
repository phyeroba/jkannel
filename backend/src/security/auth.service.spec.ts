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
  async recordFailedLogin(_: string, count: number, locked?: Date) {
    if (this.credential) {
      this.credential.failedLoginCount = count;
      this.credential.lockedUntil = locked;
    }
  }
  async recordSuccessfulLogin() {
    if (this.credential) this.credential.failedLoginCount = 0;
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
      passwordHash: await hasher.hash('correct horse battery staple'),
      status: 'active',
      failedLoginCount: 0,
      roles: ['operator'],
      permissions: ['dashboard.view'],
    };
    service = new AuthService(store, store, hasher, new TokenService());
  });
  it('logs in, rotates refresh token, and revokes session', async () => {
    const first = await service.login('acme', 'operator', 'correct horse battery staple');
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
      const result = await service.confirmPasswordReset(devToken!, 'brand new password 1');
      expect(result).toEqual({ reset: true });
      expect(store.session.revokedAt).toBeInstanceOf(Date);
      expect(store.resetTokens[0].usedAt).toBeInstanceOf(Date);
      expect(store.events.at(-1)?.action).toBe('password.reset.completed');
      await expect(
        service.confirmPasswordReset(devToken!, 'another good password'),
      ).rejects.toThrow(BadRequestException);
    });
    it('rejects a short new password', async () => {
      const { devToken } = await service.requestPasswordReset('acme', 'operator');
      await expect(service.confirmPasswordReset(devToken!, 'short')).rejects.toThrow(
        BadRequestException,
      );
    });
    it('rejects an unknown token', async () => {
      await expect(service.confirmPasswordReset('nope', 'brand new password 1')).rejects.toThrow(
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
        service.confirmPasswordReset('expired-token', 'brand new password 1'),
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
      const result = await service.acceptInvitation('invite-1', 'newoperator', 'valid password 12');
      expect(result).toEqual({ accepted: true });
      expect(store.createdUsers).toEqual([
        { username: 'newoperator', tenantId: '1', roleId: 'role-1' },
      ]);
      expect(store.events.at(-1)?.action).toBe('user.invitation.accepted');
    });
    it('rejects an invalid or expired invitation', async () => {
      await expect(
        service.acceptInvitation('missing', 'newoperator', 'valid password 12'),
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
        service.acceptInvitation('invite-1', 'newoperator', 'valid password 12'),
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
        .login('acme', 'operator', 'correct horse battery staple')
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
        'correct horse battery staple',
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
        'correct horse battery staple',
        {},
        { recoveryCode: code },
      );
      expect(result.accessToken).toBeTruthy();
      expect(identity.recovery[0].used).toBe(true);
    });
    it('rejects an incorrect TOTP code', async () => {
      await expect(
        service.login('acme', 'operator', 'correct horse battery staple', {}, { totp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refresh token reuse', () => {
    it('revokes the family when a rotated refresh token is replayed', async () => {
      const first = await service.login('acme', 'operator', 'correct horse battery staple');
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
        service.confirmPasswordReset(devToken!, 'correct horse battery staple'),
      ).rejects.toThrow('New password must differ');
    });
    it('archives the outgoing hash and accepts a fresh password', async () => {
      const { devToken } = await service.requestPasswordReset('acme', 'operator');
      const result = await service.confirmPasswordReset(devToken!, 'a brand new password');
      expect(result).toEqual({ reset: true });
      expect(identity.passwordHistory).toHaveLength(1);
    });
  });
});
