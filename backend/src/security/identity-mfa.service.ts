import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { toDataURL } from 'qrcode';
import { DatabaseService } from '../database/database.service';
import { encryptSecret, decryptSecret, normalizeRecoveryCode, sha256Hex } from './identity-crypto';
import { newTotpSecret, totpUri, verifyTotp } from './identity-totp';
import { AuthThrottleService } from './auth-throttle.service';

export interface MfaActor {
  tenantId: string;
  userId: string;
  username: string;
  /** Right-most untrusted hop; used only as a throttle bucket key. */
  ipAddress?: string;
}

const RECOVERY_CODE_COUNT = 10;

function newRecoveryCode(): string {
  const raw = randomBytes(5).toString('hex'); // 10 hex chars
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Authenticated TOTP multi-factor enrollment lifecycle. Every statement runs
 * inside a tenant transaction so PostgreSQL row level security confines it to
 * the caller's tenant (migration 017). Secrets are stored AES-256-GCM encrypted
 * and only the plaintext recovery codes are ever returned — once, at enrollment.
 */
@Injectable()
export class IdentityMfaService {
  constructor(
    private readonly database: DatabaseService,
    // Optional so the isolated unit spec can construct the service with only a
    // fake database. Absent throttle == no penalties recorded.
    @Optional() private readonly throttle?: AuthThrottleService,
  ) {}

  /**
   * Count one wrong verification code. `AuthThrottleGuard` (policy 'mfa') reads
   * these counters before the handler runs and returns 429 + Retry-After once
   * the ceiling is hit — without it a 6-digit TOTP is exhaustible in minutes.
   */
  private async penalizeCode(actor: MfaActor): Promise<void> {
    if (!this.throttle) return;
    await this.throttle.penalize(
      this.throttle.mfaBuckets(actor.tenantId, actor.userId, actor.ipAddress),
    );
  }

  async enroll(
    actor: MfaActor,
  ): Promise<{ otpauthUri: string; qrDataUrl: string; recoveryCodes: string[] }> {
    const secret = newTotpSecret();
    const uri = totpUri(actor.username, secret);
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const confirmed = await client.query(
        'SELECT 1 FROM mfa_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL',
        [actor.userId],
      );
      if (confirmed.rowCount)
        throw new ConflictException(
          'Multi-factor authentication is already enabled; disable it first',
        );
      // Replace any half-finished enrollment.
      await client.query('DELETE FROM mfa_devices WHERE user_id=$1', [actor.userId]);
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [actor.userId]);
      await client.query(
        'INSERT INTO mfa_devices(tenant_id,user_id,label,secret_encrypted) VALUES($1,$2,$3,$4)',
        [actor.tenantId, actor.userId, 'Authenticator', encryptSecret(secret)],
      );
      for (const code of recoveryCodes) {
        await client.query(
          'INSERT INTO mfa_recovery_codes(tenant_id,user_id,code_hash) VALUES($1,$2,$3)',
          [actor.tenantId, actor.userId, sha256Hex(normalizeRecoveryCode(code))],
        );
      }
      await this.audit(client, actor, 'mfa.enrolled', null);
    });
    const qrDataUrl = await toDataURL(uri);
    return { otpauthUri: uri, qrDataUrl, recoveryCodes };
  }

  async confirm(actor: MfaActor, code: string): Promise<{ confirmed: true }> {
    return this.withCodePenalty(actor, () => this.confirmInTransaction(actor, code));
  }

  /**
   * Run a code-verifying operation and record a throttle penalty when the code
   * was rejected. Done outside the database transaction so the Redis round trip
   * never happens while a tenant transaction is open.
   */
  private async withCodePenalty<T>(actor: MfaActor, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof UnauthorizedException) await this.penalizeCode(actor);
      throw error;
    }
  }

  private confirmInTransaction(actor: MfaActor, code: string): Promise<{ confirmed: true }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const device = (
        await client.query<{ id: string; secret_encrypted: string }>(
          'SELECT id, secret_encrypted FROM mfa_devices WHERE user_id=$1 AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1',
          [actor.userId],
        )
      ).rows[0];
      if (!device) throw new BadRequestException('No pending multi-factor enrollment');
      if (!(await verifyTotp(decryptSecret(device.secret_encrypted), code)))
        throw new UnauthorizedException('Invalid verification code');
      await client.query(
        'UPDATE mfa_devices SET confirmed_at=now(), last_used_at=now() WHERE id=$1',
        [device.id],
      );
      await this.audit(client, actor, 'mfa.confirmed', device.id);
      return { confirmed: true };
    });
  }

  async disable(actor: MfaActor, code: string): Promise<{ disabled: true }> {
    return this.withCodePenalty(actor, () => this.disableInTransaction(actor, code));
  }

  private disableInTransaction(actor: MfaActor, code: string): Promise<{ disabled: true }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const device = (
        await client.query<{ id: string; secret_encrypted: string }>(
          'SELECT id, secret_encrypted FROM mfa_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT 1',
          [actor.userId],
        )
      ).rows[0];
      if (!device) throw new BadRequestException('Multi-factor authentication is not enabled');
      if (!(await verifyTotp(decryptSecret(device.secret_encrypted), code)))
        throw new UnauthorizedException('Invalid verification code');
      await client.query('DELETE FROM mfa_devices WHERE user_id=$1', [actor.userId]);
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [actor.userId]);
      await this.audit(client, actor, 'mfa.disabled', device.id);
      return { disabled: true };
    });
  }

  async status(actor: MfaActor): Promise<{ enrolled: boolean; confirmed: boolean }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const rows = (
        await client.query<{ confirmed_at: Date | null }>(
          'SELECT confirmed_at FROM mfa_devices WHERE user_id=$1',
          [actor.userId],
        )
      ).rows;
      return {
        enrolled: rows.length > 0,
        confirmed: rows.some((row) => row.confirmed_at !== null),
      };
    });
  }

  private async audit(
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    actor: MfaActor,
    action: string,
    entityId: string | null,
  ): Promise<void> {
    await client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)',
      [actor.tenantId, actor.userId, action, 'mfa_device', entityId],
    );
  }
}
