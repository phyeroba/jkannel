import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export const IDENTITY_STORE = Symbol('IDENTITY_STORE');

export interface MfaLoginDevice {
  id: string;
  secretEncrypted: string;
}

export interface LoginHistoryEntry {
  tenantId: string;
  userId?: string;
  username?: string;
  outcome: 'success' | 'failure' | 'mfa_required';
  ipAddress?: string;
  userAgent?: string;
  mfaUsed: boolean;
}

/**
 * Pre-authentication identity operations invoked from the login and
 * password-reset flows. Like the rest of {@link PostgresAuthRepository} these
 * run through the jkannel_auth role (which bypasses RLS but is granted narrowly
 * — see migration 017), so every statement filters explicitly by tenant_id and
 * user_id. Authenticated management of the same tables lives in the dedicated
 * identity services, which run under jkannel_app with row level security.
 */
export interface IdentityStore {
  findConfirmedMfaDevice(tenantId: string, userId: string): Promise<MfaLoginDevice | undefined>;
  touchMfaDevice(id: string, usedAt: Date): Promise<void>;
  findActiveRecoveryCode(
    tenantId: string,
    userId: string,
    codeHash: string,
  ): Promise<{ id: string } | undefined>;
  burnRecoveryCode(id: string, usedAt: Date): Promise<void>;
  recordLoginHistory(entry: LoginHistoryEntry): Promise<void>;
  currentPasswordHash(tenantId: string, userId: string): Promise<string | undefined>;
  recentPasswordHashes(tenantId: string, userId: string, limit: number): Promise<string[]>;
  addPasswordHistory(tenantId: string, userId: string, passwordHash: string): Promise<void>;
}

@Injectable()
export class PostgresIdentityRepository implements IdentityStore {
  constructor(private readonly database: DatabaseService) {}

  async findConfirmedMfaDevice(
    tenantId: string,
    userId: string,
  ): Promise<MfaLoginDevice | undefined> {
    const result = await this.database.authQuery<{ id: string; secret_encrypted: string }>(
      'SELECT id, secret_encrypted FROM mfa_devices WHERE tenant_id=$1 AND user_id=$2 AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT 1',
      [tenantId, userId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, secretEncrypted: row.secret_encrypted } : undefined;
  }

  async touchMfaDevice(id: string, usedAt: Date): Promise<void> {
    await this.database.authQuery('UPDATE mfa_devices SET last_used_at=$2 WHERE id=$1', [
      id,
      usedAt,
    ]);
  }

  async findActiveRecoveryCode(
    tenantId: string,
    userId: string,
    codeHash: string,
  ): Promise<{ id: string } | undefined> {
    const result = await this.database.authQuery<{ id: string }>(
      'SELECT id FROM mfa_recovery_codes WHERE tenant_id=$1 AND user_id=$2 AND code_hash=$3 AND used_at IS NULL LIMIT 1',
      [tenantId, userId, codeHash],
    );
    return result.rows[0];
  }

  async burnRecoveryCode(id: string, usedAt: Date): Promise<void> {
    await this.database.authQuery(
      'UPDATE mfa_recovery_codes SET used_at=$2 WHERE id=$1 AND used_at IS NULL',
      [id, usedAt],
    );
  }

  async recordLoginHistory(entry: LoginHistoryEntry): Promise<void> {
    await this.database.authQuery(
      'INSERT INTO login_history(tenant_id,user_id,username,outcome,ip_address,user_agent,mfa_used) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        entry.tenantId,
        entry.userId ?? null,
        entry.username ?? null,
        entry.outcome,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
        entry.mfaUsed,
      ],
    );
  }

  async currentPasswordHash(tenantId: string, userId: string): Promise<string | undefined> {
    const result = await this.database.authQuery<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2',
      [tenantId, userId],
    );
    return result.rows[0]?.password_hash;
  }

  async recentPasswordHashes(tenantId: string, userId: string, limit: number): Promise<string[]> {
    const result = await this.database.authQuery<{ password_hash: string }>(
      'SELECT password_hash FROM password_history WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3',
      [tenantId, userId, limit],
    );
    return result.rows.map((row) => row.password_hash);
  }

  async addPasswordHistory(tenantId: string, userId: string, passwordHash: string): Promise<void> {
    await this.database.authQuery(
      'INSERT INTO password_history(tenant_id,user_id,password_hash) VALUES($1,$2,$3)',
      [tenantId, userId, passwordHash],
    );
  }
}
