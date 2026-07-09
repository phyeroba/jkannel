import { BadRequestException, ConflictException } from '@nestjs/common';
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
import { PasswordHasher } from './password-hasher';
import { TokenService } from './token.service';
import { randomUUID } from 'node:crypto';

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
});
