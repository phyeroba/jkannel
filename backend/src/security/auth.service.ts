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
import { AuthThrottleService, ThrottleBucket } from './auth-throttle.service';
import {
  DEFAULT_SECURITY_POLICY,
  SecurityPolicy,
  SecurityPolicyService,
} from './security-policy.service';

export interface MfaChallenge {
  totp?: string;
  recoveryCode?: string;
}

/** Request-derived context carried into the auth paths for audit + throttling. */
export interface AuthContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    private readonly passwords: PasswordHasher,
    private readonly tokens: TokenService,
    @Optional() @Inject(IDENTITY_STORE) private readonly identity?: IdentityStore,
    // Optional so isolated unit tests can construct the service without Redis.
    // Absent throttle == no penalties recorded; the AuthThrottleGuard is what
    // rejects, and it independently fails open. See auth-throttle.service.ts.
    @Optional() private readonly throttle?: AuthThrottleService,
    // Resolves the tenant's System Settings security knobs (password policy,
    // lockout, token lifetime, session idle/max/concurrency). Optional for the
    // same reason as the throttle: an isolated unit test constructs the service
    // without a database. When absent every path uses DEFAULT_SECURITY_POLICY,
    // which is the behaviour JKANNEL hardcoded before the knobs were wired, so
    // the fallback can never be laxer than the status quo.
    @Optional() private readonly policies?: SecurityPolicyService,
  ) {}

  /** Record a throttle penalty; never allowed to affect the caller's outcome. */
  private async penalize(buckets: ThrottleBucket[]): Promise<void> {
    if (!this.throttle) return;
    await this.throttle.penalize(buckets);
  }

  /** The effective security policy for a tenant, or the strict defaults. */
  private async policyFor(tenantId?: string): Promise<SecurityPolicy> {
    if (!this.policies) return { ...DEFAULT_SECURITY_POLICY };
    return this.policies.resolve(tenantId);
  }

  async login(
    tenant: string,
    username: string,
    password: string,
    context: AuthContext = {},
    mfa: MfaChallenge = {},
  ) {
    const user = await this.repository.findCredential(tenant, username);
    const now = new Date();
    // Lockout threshold, lockout window, access-token lifetime and the
    // concurrent-session cap all come from System Settings now. The tenant is
    // only knowable once the user is resolved; an unknown username is never
    // locked out anyway, so the defaults are the right thing for that case.
    const policy = await this.policyFor(user?.tenantId);
    const lockUntil = (count: number) =>
      count >= policy.lockoutThreshold
        ? new Date(now.getTime() + policy.lockoutMinutes * 60_000)
        : undefined;
    // Penalty buckets are read (not consumed) by AuthThrottleGuard before this
    // method runs; here we only record failures. Successful logins cost nothing,
    // so honest traffic — including the perf harness — is never throttled.
    const loginBuckets =
      this.throttle?.loginBuckets(tenant, username, context.ipAddress) ?? ([] as ThrottleBucket[]);
    // Account currently locked: reject WITHOUT re-incrementing the failed counter
    // or extending the window. Folding this into the credential-failure branch
    // (as it was) meant every attempt during the lockout — including one with the
    // correct password — re-extended the 15-minute window, so a locked-out user
    // could never get back in. The response stays a generic "Invalid credentials"
    // so lockout state is not disclosed.
    if (user && user.lockedUntil && user.lockedUntil > now) {
      await this.audit.append({
        tenantId: user.tenantId,
        action: 'login.failed',
        outcome: 'failure',
        actorId: user.id,
        username,
        reason: 'account_locked',
        occurredAt: now,
        ...context,
      });
      await this.recordLogin(user, username, 'failure', false, context);
      await this.penalize(loginBuckets);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (
      !user ||
      user.status === 'disabled' ||
      user.status === 'archived' ||
      user.status === 'deleted' ||
      !(await this.passwords.verify(password, user.passwordHash))
    ) {
      if (user) {
        const count = user.failedLoginCount + 1;
        await this.repository.recordFailedLogin(user.id, count, lockUntil(count));
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
      await this.penalize(loginBuckets);
      throw new UnauthorizedException('Invalid credentials');
    }
    // A 'locked' status outlives its window. recordFailedLogin sets
    // status='locked' alongside locked_until, but only locked_until expires --
    // nothing resets the status except recordSuccessfulLogin, which is below this
    // line and so was unreachable. Treating a stale 'locked' as "not active" made
    // five bad guesses disable any account PERMANENTLY: an unauthenticated denial
    // of service. Reaching this line already guarantees no lock window is active
    // (the branch above returns while one is), so a stale 'locked' must not bar
    // entry; recordSuccessfulLogin then clears it back to 'active'. Every other
    // non-active status (pending, expired, ...) is still rejected.
    if (user.status !== 'active' && user.status !== 'locked')
      throw new UnauthorizedException('Account is not active');
    // Multi-factor enforcement: if this user has a confirmed TOTP device the
    // login body must carry a valid `totp` code or an unused recovery code.
    let mfaUsed = false;
    if (this.identity) {
      const device = await this.identity.findConfirmedMfaDevice(user.tenantId, user.id);
      if (device) {
        if (!(await this.verifyMfaChallenge(user, device, mfa, now))) {
          // A presented-but-wrong second factor is a failed authentication and
          // must count towards lockout. Previously this branch bypassed
          // recordFailedLogin entirely, so a 6-digit TOTP could be guessed an
          // unlimited number of times against a known-good password. An absent
          // code is the browser's first leg of a normal MFA login, so it is not
          // penalised — only an actual wrong code or recovery code is.
          const attempted = Boolean(mfa.totp || mfa.recoveryCode);
          if (attempted) {
            const count = user.failedLoginCount + 1;
            await this.repository.recordFailedLogin(user.id, count, lockUntil(count));
            await this.penalize([
              ...loginBuckets,
              ...(this.throttle?.mfaBuckets(user.tenantId, user.id, context.ipAddress) ?? []),
            ]);
          }
          await this.audit.append({
            tenantId: user.tenantId,
            action: 'mfa.required',
            outcome: 'failure',
            actorId: user.id,
            username,
            reason: attempted ? 'mfa_invalid' : 'mfa_required',
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
    // A session may never outlive the configured absolute session lifetime, so
    // the refresh token and the session row are both cut to it.
    const refreshTtlSeconds =
      policy.sessionMaxLifetimeHours > 0
        ? Math.min(604800, policy.sessionMaxLifetimeHours * 3600)
        : 604800;
    const accessToken = this.tokens.issue(
      'access',
      principal,
      accessTokenKey(),
      policy.accessTokenTtlSeconds,
    );
    const refreshToken = this.tokens.issue(
      'refresh',
      principal,
      refreshTokenKey(),
      refreshTtlSeconds,
    );
    await this.repository.recordSuccessfulLogin(user.id);
    await this.repository.saveSession({
      id: sid,
      tenantId: user.tenantId,
      userId: user.id,
      refreshTokenHash: this.digest(refreshToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + refreshTtlSeconds * 1000),
      lastSeenAt: now,
      familyId,
      ...context,
    });
    // Concurrent-session cap: keep the N most recently active sessions and
    // revoke the rest. Off (0) by default, so this is inert until an operator
    // sets security.max_concurrent_sessions.
    if (policy.maxConcurrentSessions > 0 && this.repository.enforceConcurrentSessionLimit) {
      const revoked = await this.repository.enforceConcurrentSessionLimit(
        user.id,
        policy.maxConcurrentSessions,
        now,
      );
      if (revoked > 0)
        await this.audit.append({
          tenantId: user.tenantId,
          action: 'session.limit.enforced',
          outcome: 'success',
          actorId: user.id,
          sessionId: sid,
          reason: `revoked_${revoked}_over_limit_${policy.maxConcurrentSessions}`,
          occurredAt: now,
        });
    }
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
    return {
      accessToken,
      refreshToken,
      expiresIn: policy.accessTokenTtlSeconds,
      tokenType: 'Bearer',
    };
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
  /**
   * Rotate a refresh token and mint a new access token.
   *
   * The access token is rebuilt from the user's CURRENT database state, not
   * from the claims carried by the incoming refresh token. Replaying the old
   * claims meant a user who had been disabled, archived, demoted or stripped of
   * a permission kept their original privilege set for the whole 7-day refresh
   * lifetime — the refresh token was effectively an un-revocable capability.
   *
   * The family/replay revocation below is unchanged and still runs first.
   */
  async refresh(refreshToken: string, context: AuthContext = {}) {
    const tokenBuckets = this.throttle?.tokenBuckets('refresh', context.ipAddress) ?? [];
    let claims: ReturnType<TokenService['verify']>;
    try {
      claims = this.tokens.verify(refreshToken, 'refresh', refreshTokenKey());
    } catch (error) {
      await this.penalize(tokenBuckets);
      throw error;
    }
    const session = await this.repository.findSession(claims.sid);
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now) {
      await this.penalize(tokenBuckets);
      throw new UnauthorizedException('Invalid refresh token');
    }
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
      await this.penalize(tokenBuckets);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    // Session lifetime policy. `last_seen_at` is stamped on every rotation, so
    // idle time is "time since the last refresh"; with a 15-minute access token
    // an in-use console rotates well inside any sane idle window, and a tab left
    // open overnight does not. Both checks fail closed: the session and, for the
    // idle case, nothing else — the family is left alone because an expiry is
    // not evidence of theft. Setting either knob to 0 disables that check.
    const policy = await this.policyFor(session.tenantId);
    const idleMs = policy.sessionIdleTimeoutMinutes * 60_000;
    const maxMs = policy.sessionMaxLifetimeHours * 3_600_000;
    const expiredReason =
      idleMs > 0 && now.getTime() - new Date(session.lastSeenAt).getTime() > idleMs
        ? 'session_idle_timeout'
        : maxMs > 0 && now.getTime() - new Date(session.createdAt).getTime() > maxMs
          ? 'session_max_lifetime'
          : undefined;
    if (expiredReason) {
      session.revokedAt = now;
      await this.repository.saveSession(session);
      await this.audit.append({
        tenantId: session.tenantId,
        action: 'token.refresh.rejected',
        outcome: 'failure',
        actorId: session.userId,
        sessionId: session.id,
        reason: expiredReason,
        occurredAt: now,
      });
      await this.penalize(tokenBuckets);
      throw new UnauthorizedException('Session expired');
    }
    // Re-resolve the user. Anything other than a live, still-usable account
    // kills the session and the whole token family so the refresh token cannot
    // be used again. 'locked' is accepted alongside 'active' for exactly the
    // reason the login path accepts it: lockout is an unauthenticated,
    // attacker-triggerable state, so treating it as "no longer a user" would
    // let anyone terminate a victim's sessions with five bad password guesses.
    const user = await this.repository.findCredentialById(session.userId);
    const usable = user && (user.status === 'active' || user.status === 'locked');
    if (!usable || user.tenantId !== session.tenantId) {
      session.revokedAt = now;
      await this.repository.saveSession(session);
      if (session.familyId) await this.repository.revokeSessionFamily(session.familyId, now);
      await this.repository.revokeUserSessions(session.userId, now);
      await this.audit.append({
        tenantId: session.tenantId,
        action: 'token.refresh.rejected',
        outcome: 'failure',
        actorId: session.userId,
        sessionId: session.id,
        reason: user ? `user_status_${user.status}` : 'user_not_found',
        occurredAt: now,
      });
      throw new UnauthorizedException('Account is no longer active');
    }
    // Current roles/permissions/username — NOT the incoming token's claims.
    const principal = {
      sub: user.id,
      tid: user.tenantId,
      sid: claims.sid,
      username: user.username,
      roles: user.roles,
      permissions: user.permissions,
    };
    const accessToken = this.tokens.issue(
      'access',
      principal,
      accessTokenKey(),
      policy.accessTokenTtlSeconds,
    );
    // The rotated refresh token may not outlive the session row it belongs to.
    const remainingSeconds = Math.max(
      1,
      Math.floor((new Date(session.expiresAt).getTime() - now.getTime()) / 1000),
    );
    const nextRefresh = this.tokens.issue(
      'refresh',
      principal,
      refreshTokenKey(),
      Math.min(604800, remainingSeconds),
    );
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
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresIn: policy.accessTokenTtlSeconds,
      tokenType: 'Bearer',
    };
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
    context: AuthContext = {},
  ): Promise<{ requested: true; devToken?: string }> {
    // Unlike the login buckets this one counts EVERY call, successful or not:
    // the endpoint is an unauthenticated token-minting / enumeration-probing
    // vector whose "success" is indistinguishable from failure by design.
    await this.penalize(this.throttle?.resetBuckets(tenant, username, context.ipAddress) ?? []);
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

  async confirmPasswordReset(
    token: string,
    newPassword: string,
    context: AuthContext = {},
  ): Promise<{ reset: true }> {
    if (typeof newPassword !== 'string') throw new BadRequestException('newPassword is required');
    if (typeof token !== 'string' || !token)
      throw new BadRequestException('Invalid or expired token');
    const record = await this.repository.findPasswordResetToken(this.digest(token));
    const now = new Date();
    if (!record || record.usedAt || record.expiresAt <= now) {
      // Reset-token guessing: penalise the bad token, not the good one.
      await this.penalize(this.throttle?.tokenBuckets('reset', context.ipAddress) ?? []);
      throw new BadRequestException('Invalid or expired token');
    }
    // Complexity/length is checked against the OWNING tenant's policy, which is
    // only knowable once the token resolves — hence after the lookup, not before.
    const policy = await this.policyFor(record.tenantId);
    SecurityPolicyService.assertPasswordAllowed(newPassword, policy);
    await this.enforcePasswordHistory(
      record.tenantId,
      record.userId,
      newPassword,
      policy.passwordHistoryDepth,
    );
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
    context: AuthContext = {},
  ): Promise<{ accepted: true }> {
    if (typeof username !== 'string' || !username.trim())
      throw new BadRequestException('username is required');
    if (typeof password !== 'string') throw new BadRequestException('password is required');
    if (typeof token !== 'string' || !token)
      throw new BadRequestException('Invalid or expired invitation');
    const invitation = await this.repository.findPendingInvitation(this.digest(token));
    if (!invitation) {
      // Invitation-token guessing.
      await this.penalize(this.throttle?.tokenBuckets('invitation', context.ipAddress) ?? []);
      throw new BadRequestException('Invalid or expired invitation');
    }
    // As in confirmPasswordReset: the invitation names the tenant whose password
    // policy applies, so validation happens after the lookup and before anything
    // is written.
    SecurityPolicyService.assertPasswordAllowed(
      password,
      await this.policyFor(invitation.tenantId),
    );
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
   * `depth` stored hashes, and archive the outgoing hash into password_history.
   * `depth` comes from `security.password_history_depth` (previously the literal
   * 5). No-op when no identity store is wired (e.g. isolated unit tests).
   */
  private async enforcePasswordHistory(
    tenantId: string,
    userId: string,
    newPassword: string,
    depth: number = DEFAULT_SECURITY_POLICY.passwordHistoryDepth,
  ): Promise<void> {
    if (!this.identity) return;
    const current = await this.identity.currentPasswordHash(tenantId, userId);
    const history =
      depth > 0 ? await this.identity.recentPasswordHashes(tenantId, userId, depth) : [];
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
