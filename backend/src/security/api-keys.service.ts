import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { sha256Hex } from './identity-crypto';

export interface ApiKeyActor {
  tenantId: string;
  userId: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  allowed_ips: string[];
  rate_limit: number | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_enabled: boolean;
  created_at: Date;
}

export interface ApiKeyPage {
  items: ApiKeyRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * User-owned personal API keys (User Management spec §14). The full secret is
 * shown exactly once at creation; only sha256(secret) is persisted. All access
 * is tenant-scoped via row level security (migration 017). This is distinct
 * from the platform-console API Gateway clients.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly database: DatabaseService) {}

  async create(
    actor: ApiKeyActor,
    input: { name?: unknown; scopes?: unknown; expiresAt?: unknown },
  ): Promise<{
    id: string;
    name: string;
    keyPrefix: string;
    key: string;
    scopes: string[];
    expiresAt: Date | null;
    createdAt: Date;
  }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    const scopes = this.parseScopes(input.scopes);
    const expiresAt = this.parseExpiry(input.expiresAt);
    const prefix = randomBytes(4).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const fullKey = `jk_${prefix}.${secret}`;
    const created = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<{ id: string; created_at: Date }>(
          'INSERT INTO api_keys(tenant_id,user_id,name,key_prefix,key_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
          [actor.tenantId, actor.userId, name, prefix, sha256Hex(secret), scopes, expiresAt],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'apikey.created',
          'api_key',
          row.id,
          JSON.stringify({ name, keyPrefix: prefix, scopes }),
        ],
      );
      return row;
    });
    return {
      id: created.id,
      name,
      keyPrefix: prefix,
      key: fullKey,
      scopes,
      expiresAt,
      createdAt: created.created_at,
    };
  }

  async list(actor: ApiKeyActor, options: { limit: number; offset: number }): Promise<ApiKeyPage> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query<ApiKeyRow & { __total: string }>(
        'SELECT id,name,key_prefix,scopes,allowed_ips,rate_limit,expires_at,last_used_at,is_enabled,created_at,count(*) OVER() AS __total FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [actor.userId, options.limit, options.offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as ApiKeyRow);
      return { items, total, limit: options.limit, offset: options.offset };
    });
  }

  async disable(actor: ApiKeyActor, id: string): Promise<{ id: string; disabled: true }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<{ id: string }>(
          'UPDATE api_keys SET is_enabled=false WHERE id=$1 AND user_id=$2 RETURNING id',
          [id, actor.userId],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('API key not found');
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)',
        [actor.tenantId, actor.userId, 'apikey.disabled', 'api_key', id],
      );
      return { id: row.id, disabled: true };
    });
  }

  private parseScopes(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
      throw new BadRequestException('scopes must be an array of strings');
    return value.map((entry) => (entry as string).trim()).filter(Boolean);
  }

  private parseExpiry(value: unknown): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException('expiresAt must be a valid date');
    return date;
  }
}
