import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { safeHexEqual, sha256Hex } from '../security/identity-crypto';

/** The resolved identity behind a presented gateway API key. */
export interface GatewayClient {
  apiKeyId: string;
  keyPrefix: string;
  tenantId: string;
  userId: string;
  scopes: string[];
  allowedIps: string[];
  rateLimit: number | null;
}

interface ApiKeyAuthRow {
  id: string;
  tenant_id: string;
  user_id: string;
  key_hash: string;
  scopes: string[];
  allowed_ips: string[];
  rate_limit: number | null;
  expires_at: Date | null;
  is_enabled: boolean;
}

/**
 * Resolves a presented API key (`jk_<prefix>.<secret>`) to its owning tenant and
 * enforces the credential's own lifecycle: the key must exist, its secret must
 * match the stored sha256 hash (constant-time), it must be enabled, and it must
 * not be past `expires_at`.
 *
 * The lookup runs on the pre-context auth connection (jkannel_auth, BYPASSRLS,
 * granted SELECT/UPDATE on api_keys by migration 024) because the tenant is not
 * known until the key row is read — exactly how the login flow resolves a user
 * before a tenant context exists. All *downstream* work then runs tenant-scoped.
 */
@Injectable()
export class GatewayKeyAuthenticator {
  constructor(private readonly database: DatabaseService) {}

  /** Split `jk_<prefix>.<secret>` into its parts, or null if malformed. */
  static parseKey(raw: string): { prefix: string; secret: string } | null {
    const trimmed = raw.trim();
    const withoutScheme = trimmed.replace(/^ApiKey\s+/i, '').trim();
    const body = withoutScheme.startsWith('jk_') ? withoutScheme.slice(3) : null;
    if (!body) return null;
    const dot = body.indexOf('.');
    if (dot <= 0 || dot === body.length - 1) return null;
    return { prefix: body.slice(0, dot), secret: body.slice(dot + 1) };
  }

  async authenticate(rawKey: string): Promise<GatewayClient> {
    const parsed = GatewayKeyAuthenticator.parseKey(rawKey);
    if (!parsed) throw new UnauthorizedException('Malformed API key');

    const row = (
      await this.database.authQuery<ApiKeyAuthRow>(
        `SELECT id, tenant_id, user_id, key_hash, scopes, allowed_ips, rate_limit, expires_at, is_enabled
           FROM api_keys WHERE key_prefix = $1`,
        [parsed.prefix],
      )
    ).rows[0];

    // A single generic error for every failure mode below avoids leaking whether
    // a prefix exists or a secret was close.
    if (!row) throw new UnauthorizedException('Invalid API key');
    if (!safeHexEqual(sha256Hex(parsed.secret), row.key_hash))
      throw new UnauthorizedException('Invalid API key');
    if (!row.is_enabled) throw new UnauthorizedException('API key is disabled');
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
      throw new UnauthorizedException('API key has expired');

    return {
      apiKeyId: row.id,
      keyPrefix: parsed.prefix,
      tenantId: String(row.tenant_id),
      userId: row.user_id,
      scopes: row.scopes ?? [],
      allowedIps: row.allowed_ips ?? [],
      rateLimit: row.rate_limit ?? null,
    };
  }

  /** Best-effort last-used stamp; never blocks or fails the request. */
  async touch(apiKeyId: string): Promise<void> {
    try {
      await this.database.authQuery('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [
        apiKeyId,
      ]);
    } catch {
      // last_used_at is advisory; ignore failures.
    }
  }
}
