import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface GatewayActor {
  tenantId: string;
  userId: string;
}

export interface GatewayKeySettings {
  /** Requests permitted per 60s window; null clears the limit (unlimited). */
  rateLimit?: number | null;
  /** IP/CIDR allowlist; [] clears it (allow all). */
  ipAllowlist?: string[];
  /** Hard expiry; null clears it (never expires). */
  expiresAt?: Date | null;
  /** Enable/disable the key. */
  enabled?: boolean;
  reason?: string;
}

export interface GatewayKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  allowed_ips: string[];
  rate_limit: number | null;
  expires_at: Date | null;
  is_enabled: boolean;
  last_used_at: Date | null;
  created_at: Date;
}

const KEY_COLUMNS =
  'id,name,key_prefix,scopes,allowed_ips,rate_limit,expires_at,is_enabled,last_used_at,created_at';

/**
 * Administrative management of the gateway controls on an existing API key:
 * rate limit, IP allowlist, expiry and enablement. Tenant-scoped via RLS; every
 * mutation writes an audit_log row. Distinct from the user-owned api-keys.service
 * (which manages a caller's own keys) — this operates on any key in the tenant.
 */
@Injectable()
export class GatewayKeysService {
  constructor(private readonly database: DatabaseService) {}

  async get(actor: GatewayActor, id: string): Promise<GatewayKeyRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<GatewayKeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id=$1`, [id])
      ).rows[0];
      if (!row) throw new NotFoundException('API key not found');
      return row;
    });
  }

  async configure(
    actor: GatewayActor,
    id: string,
    settings: GatewayKeySettings,
  ): Promise<GatewayKeyRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const before = (
        await client.query<GatewayKeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id=$1`, [id])
      ).rows[0];
      if (!before) throw new NotFoundException('API key not found');

      // COALESCE-per-column with sentinel params: `undefined` (skip) is sent as
      // null and COALESCE keeps the current value; an explicit clear passes a
      // dedicated flag so a genuine null/`{}` overwrites.
      const row = (
        await client.query<GatewayKeyRow>(
          `UPDATE api_keys SET
             rate_limit  = CASE WHEN $2 THEN $3 ELSE rate_limit END,
             allowed_ips = CASE WHEN $4 THEN $5 ELSE allowed_ips END,
             expires_at  = CASE WHEN $6 THEN $7 ELSE expires_at END,
             is_enabled  = COALESCE($8, is_enabled)
           WHERE id=$1
           RETURNING ${KEY_COLUMNS}`,
          [
            id,
            settings.rateLimit !== undefined,
            settings.rateLimit ?? null,
            settings.ipAllowlist !== undefined,
            settings.ipAllowlist ?? [],
            settings.expiresAt !== undefined,
            settings.expiresAt ?? null,
            settings.enabled ?? null,
          ],
        )
      ).rows[0];

      await client.query(
        `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value,reason)
         VALUES($1,$2,'apikey.gateway.configured','api_key',$3,$4,$5,$6)`,
        [
          actor.tenantId,
          actor.userId,
          id,
          JSON.stringify({
            rate_limit: before.rate_limit,
            allowed_ips: before.allowed_ips,
            expires_at: before.expires_at,
            is_enabled: before.is_enabled,
          }),
          JSON.stringify({
            rate_limit: row.rate_limit,
            allowed_ips: row.allowed_ips,
            expires_at: row.expires_at,
            is_enabled: row.is_enabled,
          }),
          settings.reason ?? null,
        ],
      );
      return row;
    });
  }
}
