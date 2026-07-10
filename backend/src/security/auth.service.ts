import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_SINK, AUTH_REPOSITORY, AuditSink, AuthRepository } from './auth.ports';
import { IDENTITY_STORE, IdentityStore, MfaLoginDevice } from './identity.repository';
import { decryptSecret, normalizeRecoveryCode, sha256Hex } from './identity-crypto';
import { verifyTotp } from './identity-totp';
import { PasswordHasher } from './password-hasher';
import { accessTokenKey, refreshTokenKey } from './signing-keys';
import { TokenService } from './token.service';
import { UserCredential } from './auth.types';

export interface MfaChallenge {
  totp?: string;
  recoveryCode?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    private readonly passwords: PasswordHasher,
    private readonly tokens: TokenService,
    @Optional() @Inject(IDENTITY_STORE) private readonly identity?: IdentityStore,
  ) {}
  async login(
    tenant: string,
    username: string,
    password: string,
    context: { ipAddress?: string; userAgent?: string } = {},
    mfa: MfaChallenge = {},
  ) {
    const user = await this.repository.findCredential(tenant, username);
    const now = new Date();
    if (
      !user ||
      user.status === 'disabled' ||
      user.status === 'archived' ||
      user.status === 'deleted' ||
      (user.lockedUntil && user.lockedUntil > now) ||
      !(await this.passwords.verify(password, user.passwordHash))
    ) {
      if (user) {
        const count = user.failedLoginCount + 1;
        await this.repository.recordFailedLogin(
          user.id,
          count,
          count >= 5 ? new Date(now.getTime() + 15 * 60_000) : undefined,
        );
      }
      await this.audit.append({
        tenantId: user?.tenantId,
        action: 'login.failed',
        outcome: 'failure',
        actorId: user?.id,
        username,
        reason: 'invalid_credentials',
        occurredAt: now,
        ...context,
      });
      if (user) await this.recordLogin(user, username, 'failure', false, context);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.status !== 'active') throw new UnauthorizedException('Account is not active');
    // Multi-factor enforcement: if this user has a confirmed TOTP device the
    // login body must carry a valid `totp` code or an unused recovery code.
    let mfaUsed = false;
    if (this.identity) {
      const device = await this.identity.findConfirmedMfaDevice(user.tenantId, user.id);
      if (device) {
        if (!(await this.verifyMfaChallenge(user, device, mfa, now))) {
          await this.audit.append({
            tenantId: user.tenantId,
            action: 'mfa.required',
            outcome: 'failure',
            actorId: user.id,
            username,
            reason: 'mfa_required',
            occurredAt: now,
            ...context,
          });
          await this.recordLogin(user, username, 'mfa_required', false, context);
          throw new UnauthorizedException({
            mfaRequired: true,
            message: 'Multi-factor authentication required',
          });
        }
        mfaUsed = true;
      }
    }
    const sid = randomUUID();
    const familyId = randomUUID();
    const principal = {
      sub: user.id,
      tid: user.tenantId,
      sid,
      username: user.username,
      roles: user.roles,
      permissions: user.permissions,
    };
    const accessToken = this.tokens.issue('access', principal, accessTokenKey(), 900);
    const refreshToken = this.tokens.issue('refresh', principal, refreshTokenKey(), 604800);
    await this.repository.recordSuccessfulLogin(user.id);
    await this.repository.saveSession({
      id: sid,
      tenantId: user.tenantId,
      userId: user.id,
      refreshTokenHash: this.digest(refreshToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 604800000),
      lastSeenAt: now,
      familyId,
      ...context,
    });
    await this.audit.append({
      tenantId: user.tenantId,
      action: 'login.succeeded',
      outcome: 'success',
      actorId: user.id,
      sessionId: sid,
      occurredAt: now,
      ...context,
    });
    await this.recordLogin(user, username, 'success', mfaUsed, context);
    return { accessToken, refreshToken, expiresIn: 900, tokenType: 'Bearer' };
  }

  private async verifyMfaChallenge(
    user: UserCredential,
    device: MfaLoginDevice,
    mfa: MfaChallenge,
    now: Date,
  ): Promise<boolean> {
    if (mfa.totp) {
      const secret = decryptSecret(device.secretEncrypted);
      if (await verifyTotp(secret, mfa.totp)) {
        await this.identity!.touchMfaDevice(device.id, now);
        return true;
      }
      return false;
    }
    if (mfa.recoveryCode) {
      const codeHash = sha256Hex(normalizeRecoveryCode(mfa.recoveryCode));
      const record = await this.identity!.findActiveRecoveryCode(user.tenantId, user.id, codeHash);
      if (record) {
        await this.identity!.burnRecoveryCode(record.id, now);
        return true;
      }
      return false;
    }
    return false;
  }

  private async recordLogin(
    user: UserCredential,
    username: string,
    outcome: 'success' | 'failure' | 'mfa_required',
    mfaUsed: boolean,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    if (!this.identity) return;
    await this.identity.recordLoginHistory({
      tenantId: user.tenantId,
      userId: user.id,
      username,
      outcome,
      mfaUsed,
      ...context,
    });
  }
  async refresh(refreshToken: string) {
    const claims = this.tokens.verify(refreshToken, 'refresh', refreshTokenKey());
    const session = await this.repository.findSession(claims.sid);
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now)
      throw new UnauthorizedException('Invalid refresh token');
    if (session.refreshTokenHash !== this.digest(refreshToken)) {
      // The signature is valid but the hash no longer matches: this is a
      // previously-rotated (superseded) refresh token being replayed. Burn the
      // whole family so a stolen-then-rotated token cannot be used.
      session.reusedAt = now;
      session.revokedAt = now;
      await this.repository.saveSession(session);
      if (session.familyId) await this.repository.revokeSessionFamily(session.familyId, now);
      await this.audit.append({
        tenantId: session.tenantId,
        action: 'token.reuse.detected',
        outcome: 'failure',
        actorId: session.userId,
        sessionId: session.id,
        reason: 'refresh_token_reuse',
        occurredAt: now,
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    const principal = {
      sub: claims.sub,
      tid: claims.tid,
      sid: claims.sid,
      username: claims.username,
      roles: claims.roles,
      permissions: claims.permissions,
    };
    const accessToken = this.tokens.issue('access', principal, accessTokenKey(), 900);
    const nextRefresh = this.tokens.issue('refresh', principal, refreshTokenKey(), 604800);
    session.refreshTokenHash = this.digest(nextRefresh);
    session.lastSeenAt = new Date();
    await this.repository.saveSession(session);
    await this.audit.append({
      tenantId: session.tenantId,
      action: 'token.refreshed',
      outcome: 'success',
      actorId: claims.sub,
      sessionId: claims.sid,
      occurredAt: new Date(),
    });
    return { accessToken, refreshToken: nextRefresh, expiresIn: 900, tokenType: 'Bearer' };
  }
  async logout(refreshToken: string) {
    const claims = this.tokens.verify(refreshToken, 'refresh', refreshTokenKey());
    const session = await this.repository.findSession(claims.sid);
    if (session) {
      await this.repository.revokeSession(claims.sid, new Date());
      await this.audit.append({
        tenantId: session.tenantId,
        action: 'logout',
        outcome: 'success',
        actorId: claims.sub,
        sessionId: claims.sid,
        occurredAt: new Date(),
      });
    }
  }
  /**
   * Starts a password reset. Always resolves to { requested: true } so the
   * response never reveals whether the account exists (no user enumeration).
   * When the user does exist a single-use token (~1h) is stored; the token is
   * only echoed back as devToken outside production, since no email transport
   * is wired here.
   */
  async requestPasswordReset(
    tenant: string,
    username: string,
  ): Promise<{ requested: true; devToken?: string }> {
    const target = await this.repository.findResetTarget(tenant, username);
    if (!target) return { requested: true };
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    await this.repository.createPasswordResetToken({
      tenantId: target.tenantId,
      userId: target.userId,
      tokenHash: this.digest(token),
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    await this.audit.append({
      tenantId: target.tenantId,
      action: 'password.reset.requested',
      outcome: 'success',
      actorId: target.userId,
      username,
      occurredAt: now,
    });
    return {
      requested: true,
      ...(process.env.NODE_ENV !== 'production' ? { devToken: token } : {}),
    };
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<{ reset: true }> {
    if (typeof newPassword !== 'string' || newPassword.length < 12)
      throw new BadRequestException('newPassword must contain at least 12 characters');
    if (typeof token !== 'string' || !token)
      throw new BadRequestException('Invalid or expired token');
    const record = await this.repository.findPasswordResetToken(this.digest(token));
    const now = new Date();
    if (!record || record.usedAt || record.expiresAt <= now)
      throw new BadRequestException('Invalid or expired token');
    await this.enforcePasswordHistory(record.tenantId, record.userId, newPassword);
    const passwordHash = await this.passwords.hash(newPassword);
    await this.repository.applyNewPassword(record.userId, passwordHash);
    await this.repository.markPasswordResetTokenUsed(record.id, now);
    await this.repository.revokeUserSessions(record.userId, now);
    await this.audit.append({
      tenantId: record.tenantId,
      action: 'password.reset.completed',
      outcome: 'success',
      actorId: record.userId,
      occurredAt: now,
    });
    return { reset: true };
  }

  async acceptInvitation(
    token: string,
    username: string,
    password: string,
  ): Promise<{ accepted: true }> {
    if (typeof username !== 'string' || !username.trim())
      throw new BadRequestException('username is required');
    if (typeof password !== 'string' || password.length < 12)
      throw new BadRequestException('password must contain at least 12 characters');
    if (typeof token !== 'string' || !token)
      throw new BadRequestException('Invalid or expired invitation');
    const invitation = await this.repository.findPendingInvitation(this.digest(token));
    if (!invitation) throw new BadRequestException('Invalid or expired invitation');
    const passwordHash = await this.passwords.hash(password);
    const now = new Date();
    let created: { userId: string };
    try {
      created = await this.repository.acceptInvitation({
        invitationId: invitation.id,
        tenantId: invitation.tenantId,
        username: username.trim(),
        passwordHash,
        roleId: invitation.roleId,
        acceptedAt: now,
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('That username is already taken');
      throw error;
    }
    await this.audit.append({
      tenantId: invitation.tenantId,
      action: 'user.invitation.accepted',
      outcome: 'success',
      actorId: created.userId,
      username: username.trim(),
      occurredAt: now,
    });
    return { accepted: true };
  }

  /**
   * Reject a new password that matches the current password or any of the last
   * five stored hashes, and archive the outgoing hash into password_history.
   * No-op when no identity store is wired (e.g. isolated unit tests).
   */
  private async enforcePasswordHistory(
    tenantId: string,
    userId: string,
    newPassword: string,
  ): Promise<void> {
    if (!this.identity) return;
    const current = await this.identity.currentPasswordHash(tenantId, userId);
    const history = await this.identity.recentPasswordHashes(tenantId, userId, 5);
    const priors = [current, ...history].filter((hash): hash is string => Boolean(hash));
    for (const prior of priors) {
      if (await this.passwords.verify(newPassword, prior))
        throw new BadRequestException('New password must differ from your recent passwords');
    }
    if (current) await this.identity.addPasswordHistory(tenantId, userId, current);
  }

  private digest(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
