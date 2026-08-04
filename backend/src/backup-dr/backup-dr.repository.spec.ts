import { BackupDrRepository } from './backup-dr.repository';

const actor = { tenantId: '7', userId: 'backup-scheduler' };

/**
 * Captures every statement issued inside the tenant transaction so the spec can
 * assert what the repository actually wrote — in particular that a backup
 * failure raises an alert and does not merely audit itself into silence.
 */
function harness(rows: Record<string, unknown[]> = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      for (const [needle, result] of Object.entries(rows))
        if (sql.includes(needle)) return { rows: result };
      return { rows: [{ id: 'backup-1', label: 'nightly' }] };
    },
  };
  const database = { tenantTransaction: (_t: string, work: any) => work(client) } as any;
  return { repository: new BackupDrRepository(database), statements };
}

const alertStatements = (statements: Array<{ sql: string; params: unknown[] }>) =>
  statements.filter((entry) => entry.sql.includes('INSERT INTO alert_instances'));

describe('BackupDrRepository failure alerting', () => {
  it('opens a critical alert when a backup fails', async () => {
    const { repository, statements } = harness();
    await repository.failBackup(actor, 'backup-1', 'pg_dump exited 1: disk full');

    const alerts = alertStatements(statements);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sql).toContain("'backup'");
    expect(alerts[0].params[0]).toBe('7'); // tenant
    expect(alerts[0].params[1]).toBe('critical');
    expect(alerts[0].params[2]).toBe('backup:failed:nightly'); // dedup key
    expect(alerts[0].params[3]).toMatch(/Backup "nightly" failed/);
    expect(String(alerts[0].params[4])).toContain('disk full');
  });

  it('still audits the failure alongside the alert', async () => {
    const { repository, statements } = harness();
    await repository.failBackup(actor, 'backup-1', 'boom');
    const audits = statements.filter((entry) => entry.sql.includes('INSERT INTO audit_log'));
    expect(audits).toHaveLength(1);
    expect(audits[0].params[2]).toBe('backup.failed');
  });

  it('opens a critical alert when verification fails', async () => {
    const { repository, statements } = harness();
    await repository.markVerifyFailed(actor, 'backup-1', 'pg_restore --list failed');
    const alerts = alertStatements(statements);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].params[1]).toBe('critical');
    expect(alerts[0].params[2]).toBe('backup:verify_failed:nightly');
  });

  it('opens a warning alert for a completed-but-degraded backup', async () => {
    const { repository, statements } = harness();
    await repository.completeBackup(actor, 'backup-1', {
      sizeBytes: 10,
      checksum: 'a'.repeat(64),
      location: 'file:///tmp/x.enc',
      detail: 'ok',
      warning: 'No offsite destination is configured.',
    });
    const alerts = alertStatements(statements);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].params[1]).toBe('warning');
    expect(alerts[0].params[2]).toBe('backup:degraded:backup-1');
  });

  it('raises no alert for a clean backup', async () => {
    const { repository, statements } = harness();
    await repository.completeBackup(actor, 'backup-1', {
      sizeBytes: 10,
      checksum: 'a'.repeat(64),
      location: 'file:///tmp/x.enc',
      detail: 'ok',
      configFileCount: 4,
      offsiteLocation: 'file:///mnt/offsite/x.enc',
      offsiteSynced: true,
    });
    expect(alertStatements(statements)).toHaveLength(0);
  });

  /**
   * The alert is a notification, not the source of truth. If raising it fails
   * (a missing constraint value, a permissions problem), the backup failure
   * must still be recorded — never masked by the alerting error.
   */
  it('does not let an alerting error mask the backup failure', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('INSERT INTO alert_instances')) throw new Error('alert table missing');
        return { rows: [{ id: 'backup-1', label: 'nightly', status: 'failed' }] };
      },
    };
    const repository = new BackupDrRepository({
      tenantTransaction: (_t: string, work: any) => work(client),
    } as any);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const row = await repository.failBackup(actor, 'backup-1', 'boom');
    expect(row.status).toBe('failed');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('BackupDrRepository grids', () => {
  it('routes list reads through the shared grid runner (cursor + fields available)', async () => {
    const { repository, statements } = harness({
      'FROM backup_records': [
        { id: 'b1', label: 'nightly', __cursor_sort: 'x', __cursor_id: 'b1' },
      ],
    });
    const page = await repository.listBackups(actor, { paginate: 'cursor', limit: 10 });
    expect(page.pagination).toBe('cursor');
    expect(statements.some((entry) => entry.sql.includes('__cursor_sort'))).toBe(true);
  });

  it('still serves the offset contract by default', async () => {
    const { repository } = harness({
      'FROM backup_records': [{ id: 'b1', label: 'nightly', __total: '3' }],
    });
    const page = await repository.listBackups(actor, {});
    expect(page.pagination).toBe('offset');
    expect(page.total).toBe(3);
    expect(page.offset).toBe(0);
  });

  it('projects ?fields= on the backups grid', async () => {
    const { repository } = harness({
      'FROM backup_records': [{ id: 'b1', label: 'nightly', status: 'completed', __total: '1' }],
    });
    const page = await repository.listBackups(actor, { fields: 'label,status' });
    expect(page.items[0]).toEqual({ label: 'nightly', status: 'completed' });
  });

  it('removes offsite and configuration artifacts when a backup expires', async () => {
    const { repository, statements } = harness();
    await repository.expireBackups(actor, 'daily', new Date().toISOString(), 10);
    const del = statements.find((entry) => entry.sql.includes('DELETE FROM backup_records'));
    expect(del!.sql).toContain('config_artifact_path');
    expect(del!.sql).toContain('offsite_location');
  });
});
