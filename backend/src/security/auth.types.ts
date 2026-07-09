export type UserStatus =
  'pending' | 'active' | 'disabled' | 'locked' | 'expired' | 'archived' | 'deleted';

export interface AuthenticatedPrincipal {
  tenantId: string;
  userId: string;
  sessionId: string;
  username: string;
  roles: string[];
  permissions: string[];
}

export interface UserCredential {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  status: UserStatus;
  failedLoginCount: number;
  lockedUntil?: Date;
  roles: string[];
  permissions: string[];
}

export interface AuthSession {
  id: string;
  tenantId: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt?: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditEvent {
  tenantId?: string;
  action:
    | 'login.succeeded'
    | 'login.failed'
    | 'account.locked'
    | 'token.refreshed'
    | 'logout'
    | 'password.reset.requested'
    | 'password.reset.completed'
    | 'user.invitation.accepted';
  outcome: 'success' | 'failure';
  actorId?: string;
  username?: string;
  sessionId?: string;
  reason?: string;
  occurredAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface PasswordResetTarget {
  userId: string;
  tenantId: string;
}

export interface PasswordResetToken {
  id: string;
  tenantId: string;
  userId: string;
  expiresAt: Date;
  usedAt?: Date;
}

export interface PendingInvitation {
  id: string;
  tenantId: string;
  roleId?: string;
}
