import {
  BadRequestException,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { EtagConflictError } from '../platform/etag';
import { BackupDrController } from './backup-dr.controller';
import { BackupDrRepository } from './backup-dr.repository';

/**
 * Optimistic concurrency on backup schedules — the first resource to actually
 * use `platform/etag.ts`.
 *
 * The failure this prevents: two operators open the same schedule, one widens
 * the retention window, the other disables the job for maintenance and saves
 * last. Without a precondition the second save silently restores the old
 * retention, and nobody learns about it until a restore needs a backup that was
 * expired early.
 */

const ID = '11111111-1111-4111-8111-111111111111';

function controller(overrides: Partial<Record<keyof BackupDrRepository, unknown>> = {}) {
  const stored = {
    id: ID,
    tenant_id: '7',
    name: 'nightly',
    cron: null,
    interval_minutes: 1440,
    kind: 'full',
    retention_class: 'daily',
    enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_by: 'op',
    created_at: new Date().toISOString(),
    version: 3,
  };
  const getSchedule = jest.fn(async () => stored);
  const updateSchedule = jest.fn(async (_a: unknown, _id: string, patch: any) => ({
    ...stored,
    ...patch,
    version: stored.version + 1,
  }));
  const repository = { getSchedule, updateSchedule, ...overrides } as unknown as BackupDrRepository;
  return {
    controller: new BackupDrController({} as any, repository),
    getSchedule,
    updateSchedule,
    stored,
  };
}

const request = (headers: Record<string, string> = {}) =>
  ({ principal: { tenantId: '7', userId: 'u-1', username: 'op' }, headers }) as any;

const response = () => {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (name: string, value: string) => (headers[name] = value) };
};

describe('GET /backup-dr/schedules/:id', () => {
  it('publishes the row version as a strong ETag', async () => {
    const { controller: subject } = controller();
    const res = response();
    const row = await subject.getSchedule(request(), ID, res);
    expect(row.version).toBe(3);
    expect(res.headers.etag).toBe('"3"');
  });

  it('404s for an unknown schedule', async () => {
    const { controller: subject } = controller({ getSchedule: jest.fn(async () => undefined) });
    await expect(subject.getSchedule(request(), ID, response())).rejects.toThrow(NotFoundException);
  });
});

describe('PATCH /backup-dr/schedules/:id', () => {
  it('applies the update and returns the new ETag when If-Match is current', async () => {
    const { controller: subject, updateSchedule } = controller();
    const res = response();
    const row = await subject.updateSchedule(
      request({ 'if-match': '"3"' }),
      ID,
      { retentionClass: 'weekly' },
      res,
    );
    expect(updateSchedule).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      { retentionClass: 'weekly' },
      3,
    );
    expect(row.version).toBe(4);
    expect(res.headers.etag).toBe('"4"');
  });

  /** The whole point: a stale editor is refused, not merged. */
  it('rejects a stale If-Match with 412 and never touches the row', async () => {
    const { controller: subject, updateSchedule } = controller();
    await expect(
      subject.updateSchedule(request({ 'if-match': '"2"' }), ID, { enabled: false }, response()),
    ).rejects.toThrow(PreconditionFailedException);
    await expect(
      subject.updateSchedule(request({ 'if-match': '"2"' }), ID, { enabled: false }, response()),
    ).rejects.toThrow(/has version 3, not 2/);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('accepts a weak tag and a quoted tag alike', async () => {
    const { controller: subject } = controller();
    await expect(
      subject.updateSchedule(request({ 'if-match': 'W/"3"' }), ID, { enabled: false }, response()),
    ).resolves.toMatchObject({ version: 4 });
  });

  it("treats If-Match: * as 'whatever the current version is'", async () => {
    const { controller: subject, updateSchedule } = controller();
    await subject.updateSchedule(request({ 'if-match': '*' }), ID, { enabled: false }, response());
    expect(updateSchedule).toHaveBeenCalledWith(expect.anything(), ID, { enabled: false }, 3);
  });

  /** Backwards compatibility: every existing client sends no precondition. */
  it('updates without a precondition when no If-Match is sent', async () => {
    const { controller: subject, updateSchedule } = controller();
    await subject.updateSchedule(request(), ID, { enabled: false }, response());
    expect(updateSchedule).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      { enabled: false },
      undefined,
    );
  });

  it('rejects a malformed entity tag rather than ignoring the precondition', async () => {
    const { controller: subject } = controller();
    await expect(
      subject.updateSchedule(request({ 'if-match': '"not-a-version"' }), ID, {}, response()),
    ).rejects.toThrow(BadRequestException);
  });

  it('recomputes the next run when the interval changes', async () => {
    const { controller: subject, updateSchedule } = controller();
    await subject.updateSchedule(request(), ID, { intervalMinutes: 30 }, response());
    const patch = updateSchedule.mock.calls[0][2];
    expect(patch.intervalMinutes).toBe(30);
    expect(patch.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to leave a schedule with neither cron nor interval', async () => {
    const { controller: subject } = controller();
    await expect(
      subject.updateSchedule(request(), ID, { intervalMinutes: null }, response()),
    ).rejects.toThrow(/must keep either cron or intervalMinutes/);
  });

  it('surfaces a concurrent update that landed between the read and the write', async () => {
    const { controller: subject } = controller({
      updateSchedule: jest.fn(async () => {
        throw new EtagConflictError('Backup schedule');
      }),
    });
    await expect(
      subject.updateSchedule(request({ 'if-match': '"3"' }), ID, { enabled: false }, response()),
    ).rejects.toThrow(/modified concurrently/);
  });
});

describe('BackupDrRepository.updateSchedule', () => {
  function harness(rows: unknown[][]) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    let call = 0;
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.startsWith('INSERT INTO audit_log')) return { rows: [] };
        return { rows: rows[call++] ?? [] };
      },
    };
    const repository = new BackupDrRepository({
      tenantTransaction: (_t: string, work: any) => work(client),
    } as any);
    return { repository, statements };
  }

  const actor = { tenantId: '7', userId: 'u-1' };

  it('asserts the expected version in the UPDATE itself and always bumps it', async () => {
    const { repository, statements } = harness([[{ id: ID, version: 4 }]]);
    await repository.updateSchedule(actor, ID, { enabled: false }, 3);

    const update = statements[0];
    expect(update.sql).toContain('UPDATE backup_schedules');
    expect(update.sql).toContain('enabled=$2');
    expect(update.sql).toContain('version=version+1');
    expect(update.sql).toMatch(/\$3::integer IS NULL OR version=\$3::integer/);
    expect(update.params).toEqual([ID, false, 3]);
  });

  it('passes a null precondition when no version was demanded', async () => {
    const { repository, statements } = harness([[{ id: ID, version: 4 }]]);
    await repository.updateSchedule(actor, ID, { name: 'renamed' });
    expect(statements[0].params).toEqual([ID, 'renamed', null]);
  });

  it('throws EtagConflictError when the row exists but has moved on', async () => {
    // First query (the guarded UPDATE) matches nothing; the existence probe finds the row.
    const { repository } = harness([[], [{ id: ID }]]);
    await expect(repository.updateSchedule(actor, ID, { enabled: false }, 3)).rejects.toThrow(
      EtagConflictError,
    );
  });

  it('returns undefined when the schedule does not exist at all', async () => {
    const { repository } = harness([[], []]);
    await expect(
      repository.updateSchedule(actor, ID, { enabled: false }, 3),
    ).resolves.toBeUndefined();
  });

  it('audits the update with the resulting version', async () => {
    const { repository, statements } = harness([[{ id: ID, version: 4 }]]);
    await repository.updateSchedule(actor, ID, { enabled: false }, 3);
    const audit = statements.find((entry) => entry.sql.includes('INSERT INTO audit_log'))!;
    expect(audit.params[2]).toBe('backup_schedule.updated');
    expect(String(audit.params[5])).toContain('"version":4');
  });
});
