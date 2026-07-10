import { DataModelRetentionService } from './retention.service';
import { RetentionPolicy } from './retention.policy';

const actor = { tenantId: '1', userId: 'sys' };

const PRUNE_POLICY: RetentionPolicy = {
  sourceTable: 'notification_deliveries',
  archiveTable: 'notification_deliveries_archive',
  timestampColumn: 'created_at',
  retentionDays: 90,
  retentionEnvVar: 'X_UNUSED',
  deleteAfterArchive: true,
  columns: ['id', 'tenant_id', 'created_at'],
};

const COPY_POLICY: RetentionPolicy = {
  sourceTable: 'audit_log',
  archiveTable: 'audit_log_archive',
  timestampColumn: 'created_at',
  retentionDays: 365,
  retentionEnvVar: 'X_UNUSED',
  deleteAfterArchive: false,
  columns: ['id', 'uuid', 'tenant_id', 'created_at'],
};

/** Mock client answering by SQL fragment; records every call. */
function makeClient(
  opts: { locked?: boolean; pruneRows?: number; copyTs?: string[]; watermark?: string | null } = {},
) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('pg_try_advisory_xact_lock'))
      return { rows: [{ locked: opts.locked ?? true }] };
    if (sql.includes('SELECT watermark FROM data_model_retention_state'))
      return { rows: [{ watermark: opts.watermark ?? null }] };
    // archive-then-prune CTE ends in DELETE ... RETURNING id
    if (sql.includes('DELETE FROM notification_deliveries'))
      return { rowCount: opts.pruneRows ?? 0, rows: [] };
    // copy-only INSERT ... RETURNING created_at AS ts
    if (sql.includes('INSERT INTO audit_log_archive'))
      return {
        rowCount: (opts.copyTs ?? []).length,
        rows: (opts.copyTs ?? []).map((ts) => ({ ts })),
      };
    return { rowCount: 0, rows: [] };
  });
  return { query, calls };
}

function serviceWith(client: any, policies: RetentionPolicy[]) {
  const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
  return new DataModelRetentionService(db, policies);
}

describe('DataModelRetentionService', () => {
  it('skips the tenant when the advisory lock is held by another replica', async () => {
    const client = makeClient({ locked: false });
    const service = serviceWith(client, [PRUNE_POLICY]);
    const result = await service.runForTenant(actor);
    expect(result.locked).toBe(false);
    expect(result.policies).toEqual([]);
    // No archive/prune work attempted.
    expect(client.calls.some((c) => c.sql.includes('DELETE FROM'))).toBe(false);
  });

  it('archives then prunes a mutable log and records counts', async () => {
    const client = makeClient({ pruneRows: 3 });
    const service = serviceWith(client, [PRUNE_POLICY]);
    const result = await service.runForTenant(actor);
    expect(result.locked).toBe(true);
    expect(result.policies[0]).toMatchObject({
      sourceTable: 'notification_deliveries',
      archived: 3,
      deleted: 3,
    });
    // State upsert + audit row written.
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO data_model_retention_state'))).toBe(
      true,
    );
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('archives audit_log copy-only (no delete) and advances the watermark', async () => {
    const client = makeClient({ copyTs: ['2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z'] });
    const service = serviceWith(client, [COPY_POLICY]);
    const result = await service.runForTenant(actor);
    expect(result.policies[0]).toMatchObject({
      sourceTable: 'audit_log',
      archived: 2,
      deleted: 0,
    });
    // Never issues a DELETE against the append-only source.
    expect(client.calls.some((c) => c.sql.includes('DELETE FROM audit_log'))).toBe(false);
    // Advances the watermark to the newest archived timestamp.
    const wmUpdate = client.calls.find((c) =>
      c.sql.includes('UPDATE data_model_retention_state SET watermark'),
    );
    expect(wmUpdate?.params[2]).toBe(new Date('2025-02-01T00:00:00.000Z').toISOString());
  });
});
