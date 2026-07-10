import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { AuditSink, AuthRepository } from './auth.ports';
import {
  AuditEvent,
  AuthSession,
  PasswordResetTarget,
  PasswordResetToken,
  PendingInvitation,
  UserCredential,
} from './auth.types';

@Injectable()
export class PostgresAuthRepository implements AuthRepository, AuditSink {
  constructor(private readonly database: DatabaseService) {}
  async findCredential(tenantSlug: string, username: string): Promise<UserCredential | undefined> {
    const result = await this.database.authQuery<{
      id: string;
      tenant_id: string;
      username: string;
      password_hash: string;
      status: UserCredential['status'];
      failed_login_count: number;
      locked_until: Date | null;
      roles: string[];
      permissions: string[];
    }>(
      `SELECT u.id,u.tenant_id,u.username,u.password_hash,u.status,u.failed_login_count,u.locked_until,COALESCE(array_agg(DISTINCT r.name) FILTER(WHERE r.name IS NOT NULL),'{}') roles,COALESCE(array_agg(DISTINCT p.code) FILTER(WHERE p.code IS NOT NULL),'{}') permissions FROM users u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id WHERE t.slug=$1 AND lower(u.username)=lower($2) GROUP BY u.id`,
      [tenantSlug, username],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId: String(row.tenant_id),
      username: row.username,
      passwordHash: row.password_hash,
      status: row.status,
      failedLoginCount: row.failed_login_count,
      lockedUntil: row.locked_until ?? undefined,
      roles: row.roles,
      permissions: row.permissions,
    };
  }
  async recordFailedLogin(userId: string, failedCount: number, lockedUntil?: Date): Promise<void> {
    await this.database.authQuery(
      "UPDATE users SET failed_login_count=$2,locked_until=$3,status=CASE WHEN $3::timestamptz IS NULL THEN status ELSE 'locked' END,updated_at=now() WHERE id=$1",
      [userId, failedCount, lockedUntil ?? null],
    );
  }
  async recordSuccessfulLogin(userId: string): Promise<void> {
    await this.database.authQuery(
      "UPDATE users SET failed_login_count=0,locked_until=NULL,status=CASE WHEN status='locked' THEN 'active' ELSE status END,updated_at=now() WHERE id=$1",
      [userId],
    );
  }
  async saveSession(session: AuthSession): Promise<void> {
    await this.database.authQuery(
      `INSERT INTO auth_sessions(id,tenant_id,user_id,refresh_token_hash,created_at,expires_at,last_seen_at,revoked_at,ip_address,user_agent,family_id,superseded_by,reused_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET refresh_token_hash=EXCLUDED.refresh_token_hash,last_seen_at=EXCLUDED.last_seen_at,expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at,superseded_by=EXCLUDED.superseded_by,reused_at=EXCLUDED.reused_at`,
      [
        session.id,
        session.tenantId,
        session.userId,
        session.refreshTokenHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.revokedAt ?? null,
        session.ipAddress ?? null,
        session.userAgent ?? null,
        session.familyId ?? null,
        session.supersededBy ?? null,
        session.reusedAt ?? null,
      ],
    );
  }
  async findSession(id: string): Promise<AuthSession | undefined> {
    const r = await this.database.authQuery<{
      id: string;
      tenant_id: string;
      user_id: string;
      refresh_token_hash: string;
      created_at: Date;
      expires_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
      ip_address: string | null;
      user_agent: string | null;
      family_id: string | null;
      superseded_by: string | null;
      reused_at: Date | null;
    }>('SELECT * FROM auth_sessions WHERE id=$1', [id]);
    const x = r.rows[0];
    return x
      ? {
          id: x.id,
          tenantId: String(x.tenant_id),
          userId: x.user_id,
          refreshTokenHash: x.refresh_token_hash,
          createdAt: x.created_at,
          expiresAt: x.expires_at,
          lastSeenAt: x.last_seen_at,
          revokedAt: x.revoked_at ?? undefined,
          ipAddress: x.ip_address ?? undefined,
          userAgent: x.user_agent ?? undefined,
          familyId: x.family_id ?? undefined,
          supersededBy: x.superseded_by ?? undefined,
          reusedAt: x.reused_at ?? undefined,
        }
      : undefined;
  }
  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    await this.database.authQuery('UPDATE auth_sessions SET revoked_at=$2 WHERE id=$1', [
      id,
      revokedAt,
    ]);
  }
  async revokeSessionFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.database.authQuery(
      'UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE family_id=$1 AND revoked_at IS NULL',
      [familyId, revokedAt],
    );
  }
  async findResetTarget(
    tenantSlug: string,
    username: string,
  ): Promise<PasswordResetTarget | undefined> {
    const result = await this.database.authQuery<{ id: string; tenant_id: string }>(
      "SELECT u.id,u.tenant_id FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.slug=$1 AND lower(u.username)=lower($2) AND u.status NOT IN ('archived','deleted')",
      [tenantSlug, username],
    );
    const row = result.rows[0];
    return row ? { userId: row.id, tenantId: String(row.tenant_id) } : undefined;
  }
  async createPasswordResetToken(token: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.database.authQuery(
      'INSERT INTO password_reset_tokens(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
      [token.tenantId, token.userId, token.tokenHash, token.expiresAt],
    );
  }
  async findPasswordResetToken(tokenHash: string): Promise<PasswordResetToken | undefined> {
    const result = await this.database.authQuery<{
      id: string;
      tenant_id: string;
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
    }>(
      'SELECT id,tenant_id,user_id,expires_at,used_at FROM password_reset_tokens WHERE token_hash=$1',
      [tokenHash],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          tenantId: String(row.tenant_id),
          userId: row.user_id,
          expiresAt: row.expires_at,
          usedAt: row.used_at ?? undefined,
        }
      : undefined;
  }
  async markPasswordResetTokenUsed(id: string, usedAt: Date): Promise<void> {
    await this.database.authQuery('UPDATE password_reset_tokens SET used_at=$2 WHERE id=$1', [
      id,
      usedAt,
    ]);
  }
  async applyNewPassword(userId: string, passwordHash: string): Promise<void> {
    await this.database.authQuery(
      "UPDATE users SET password_hash=$2,status='active',failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$1",
      [userId, passwordHash],
    );
  }
  async revokeUserSessions(userId: string, revokedAt: Date): Promise<void> {
    await this.database.authQuery(
      'UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL',
      [userId, revokedAt],
    );
  }
  async findPendingInvitation(tokenHash: string): Promise<PendingInvitation | undefined> {
    const result = await this.database.authQuery<{
      id: string;
      tenant_id: string;
      role_id: string | null;
    }>(
      "SELECT id,tenant_id,role_id FROM user_invitations WHERE token_hash=$1 AND status='pending' AND expires_at>now()",
      [tokenHash],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, tenantId: String(row.tenant_id), roleId: row.role_id ?? undefined }
      : undefined;
  }
  async acceptInvitation(input: {
    invitationId: string;
    tenantId: string;
    username: string;
    passwordHash: string;
    roleId?: string;
    acceptedAt: Date;
  }): Promise<{ userId: string }> {
    const user = (
      await this.database.authQuery<{ id: string }>(
        "INSERT INTO users(tenant_id,username,password_hash,status) VALUES($1,$2,$3,'active') RETURNING id",
        [input.tenantId, input.username, input.passwordHash],
      )
    ).rows[0];
    if (input.roleId)
      await this.database.authQuery(
        'INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [input.tenantId, user.id, input.roleId],
      );
    await this.database.authQuery(
      "UPDATE user_invitations SET status='accepted',accepted_at=$2 WHERE id=$1",
      [input.invitationId, input.acceptedAt],
    );
    return { userId: user.id };
  }
  async append(event: AuditEvent): Promise<void> {
    if (!event.tenantId) return;
    await this.database.authQuery(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        event.tenantId,
        event.actorId ?? 'anonymous',
        event.action,
        'authentication',
        event.sessionId ?? null,
        JSON.stringify({
          outcome: event.outcome,
          usernameHash: event.username
            ? createHash('sha256').update(event.username).digest('hex')
            : undefined,
        }),
        event.reason ?? null,
        event.occurredAt,
      ],
    );
  }
}
