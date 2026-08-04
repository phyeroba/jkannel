import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SecuritySettingsSource } from './security-policy.service';

/**
 * Reads the `security.*` rows of `system_settings` for one tenant.
 *
 * Deliberately goes through {@link DatabaseService.tenantTransaction} (the
 * jkannel_app role with `app.tenant_id` set) rather than the auth pool: the auth
 * role is granted identity tables only, and widening it to `system_settings`
 * would hand a BYPASSRLS role read access to every tenant's settings — including
 * the rows flagged `is_secret`. Going through the tenant-scoped pool keeps RLS in
 * force, and the `is_secret = false` predicate means a secret value can never be
 * pulled into a policy object even by accident.
 *
 * The caller ({@link SecurityPolicyService}) caches the result for 30 s, so this
 * runs at most twice a minute per tenant on the login path.
 */
@Injectable()
export class PostgresSecuritySettingsRepository implements SecuritySettingsSource {
  constructor(private readonly database: DatabaseService) {}

  async loadSecuritySettings(tenantId: string): Promise<Record<string, unknown>> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<{ key: string; value: unknown }>(
        "SELECT key, value FROM system_settings WHERE is_secret = false AND key LIKE 'security.%'",
      );
      const settings: Record<string, unknown> = {};
      for (const row of result.rows) settings[row.key] = row.value;
      return settings;
    });
  }
}
