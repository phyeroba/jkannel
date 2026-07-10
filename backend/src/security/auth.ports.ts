import {
  AuditEvent,
  AuthSession,
  PasswordResetTarget,
  PasswordResetToken,
  PendingInvitation,
  UserCredential,
} from './auth.types';

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');
export const AUDIT_SINK = Symbol('AUDIT_SINK');

export interface AuthRepository {
  findCredential(tenantSlug: string, username: string): Promise<UserCredential | undefined>;
  recordFailedLogin(userId: string, failedCount: number, lockedUntil?: Date): Promise<void>;
  recordSuccessfulLogin(userId: string): Promise<void>;
  saveSession(session: AuthSession): Promise<void>;
  findSession(sessionId: string): Promise<AuthSession | undefined>;
  revokeSession(sessionId: string, revokedAt: Date): Promise<void>;
  /** Revoke every session sharing a refresh-token family (rotation replay defence). */
  revokeSessionFamily(familyId: string, revokedAt: Date): Promise<void>;

  // Password reset (unauthenticated; run through the pre-tenant auth role).
  findResetTarget(tenantSlug: string, username: string): Promise<PasswordResetTarget | undefined>;
  createPasswordResetToken(token: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findPasswordResetToken(tokenHash: string): Promise<PasswordResetToken | undefined>;
  markPasswordResetTokenUsed(id: string, usedAt: Date): Promise<void>;
  applyNewPassword(userId: string, passwordHash: string): Promise<void>;
  revokeUserSessions(userId: string, revokedAt: Date): Promise<void>;

  // Invitation acceptance (unauthenticated; run through the pre-tenant auth role).
  findPendingInvitation(tokenHash: string): Promise<PendingInvitation | undefined>;
  acceptInvitation(input: {
    invitationId: string;
    tenantId: string;
    username: string;
    passwordHash: string;
    roleId?: string;
    acceptedAt: Date;
  }): Promise<{ userId: string }>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}
