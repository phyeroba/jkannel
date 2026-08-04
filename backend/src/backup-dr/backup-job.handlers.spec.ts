import { JobContext, JobHandlerRegistry } from '../platform/job-registry';
import { BackupJobHandlers } from './backup-job.handlers';

const actor = { tenantId: '1', userId: 'operator' };

function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'job-1',
    type: 'backup.create',
    actor,
    input: {},
    attempt: 1,
    maxAttempts: 3,
    progress: async () => undefined,
    ...overrides,
  };
}

function build(service: any, repository: any = {}) {
  const registry = new JobHandlerRegistry();
  const handlers = new BackupJobHandlers(registry, service, repository);
  handlers.onModuleInit();
  return { registry, handlers };
}

describe('BackupJobHandlers registration', () => {
  it('registers the backup job types so POST /jobs can accept them', () => {
    const { registry } = build({});
    expect(registry.types()).toEqual([
      'backup.create',
      'backup.retention',
      'backup.schedule.run',
      'backup.verify',
    ]);
  });

  it('never retries retention (deletion is not safe to blindly repeat)', () => {
    const { registry } = build({});
    expect(registry.require('backup.retention').maxAttempts).toBe(1);
    expect(registry.require('backup.create').maxAttempts).toBe(3);
  });

  it('is idempotent so a second module init does not throw', () => {
    const { registry, handlers } = build({});
    expect(() => handlers.register()).not.toThrow();
    expect(registry.types()).toHaveLength(4);
  });
});

describe('backup.create handler', () => {
  it('returns the artifact metadata on success', async () => {
    const createBackup = jest.fn().mockResolvedValue({
      id: 'backup-1',
      label: 'nightly',
      status: 'completed',
      size_bytes: '1024',
      checksum: 'a'.repeat(64),
      location: 'file:///var/backups/nightly.enc',
      offsite_location: 'file:///mnt/offsite/nightly.enc',
      config_file_count: 4,
      warning: null,
    });
    const { registry } = build({ createBackup });

    const result: any = await registry
      .require('backup.create')
      .handler(context({ input: { kind: 'full', retentionClass: 'daily' } }));
    expect(createBackup).toHaveBeenCalledWith(actor, {
      kind: 'full',
      retentionClass: 'daily',
      label: undefined,
      scope: undefined,
    });
    expect(result.backupId).toBe('backup-1');
    expect(result.offsiteLocation).toBe('file:///mnt/offsite/nightly.enc');
  });

  /**
   * The non-negotiable: a backup that recorded itself as failed must fail the
   * job. Returning the record would report a green job over a red backup.
   */
  it('fails the job when the backup itself failed', async () => {
    const createBackup = jest.fn().mockResolvedValue({
      id: 'backup-1',
      status: 'failed',
      detail: 'pg_dump not available in this image',
    });
    const { registry } = build({ createBackup });
    await expect(registry.require('backup.create').handler(context())).rejects.toThrow(
      /finished with status "failed": pg_dump not available/,
    );
  });

  it('rejects a non-string input field permanently rather than retrying it', async () => {
    const { registry } = build({ createBackup: jest.fn() });
    await expect(
      registry.require('backup.create').handler(context({ input: { kind: 7 } })),
    ).rejects.toMatchObject({ permanent: true });
  });
});

describe('backup.verify handler', () => {
  it('requires a UUID backupId, permanently', async () => {
    const { registry } = build({ verifyBackup: jest.fn() });
    await expect(
      registry.require('backup.verify').handler(context({ input: { backupId: 'nope' } })),
    ).rejects.toMatchObject({ permanent: true });
  });

  it('fails when the artifact did not verify', async () => {
    const verifyBackup = jest
      .fn()
      .mockResolvedValue({ status: 'completed', detail: 'pg_restore --list failed' });
    const { registry } = build({ verifyBackup });
    await expect(
      registry
        .require('backup.verify')
        .handler(context({ input: { backupId: '11111111-1111-4111-8111-111111111111' } })),
    ).rejects.toThrow(/did not verify/);
  });

  it('returns the verification result on success', async () => {
    const verifyBackup = jest
      .fn()
      .mockResolvedValue({ status: 'verified', verified_at: '2026-08-04T00:00:00.000Z' });
    const { registry } = build({ verifyBackup });
    const result: any = await registry
      .require('backup.verify')
      .handler(context({ input: { backupId: '11111111-1111-4111-8111-111111111111' } }));
    expect(result.status).toBe('verified');
  });
});

describe('backup.retention handler', () => {
  it('returns the per-class summary', async () => {
    const applyRetention = jest.fn().mockResolvedValue([{ retentionClass: 'daily', removed: 2 }]);
    const { registry } = build({ applyRetention });
    const result: any = await registry.require('backup.retention').handler(context());
    expect(result.classes).toEqual([{ retentionClass: 'daily', removed: 2 }]);
  });
});

describe('backup.schedule.run handler', () => {
  it('refuses an unknown schedule permanently', async () => {
    const repository = { listSchedules: jest.fn().mockResolvedValue({ items: [] }) };
    const { registry } = build({ createBackup: jest.fn() }, repository);
    await expect(
      registry
        .require('backup.schedule.run')
        .handler(context({ input: { scheduleId: '11111111-1111-4111-8111-111111111111' } })),
    ).rejects.toMatchObject({ permanent: true });
  });

  it('runs the named schedule', async () => {
    const scheduleId = '11111111-1111-4111-8111-111111111111';
    const repository = {
      listSchedules: jest.fn().mockResolvedValue({
        items: [{ id: scheduleId, name: 'nightly', kind: 'full', retention_class: 'daily' }],
      }),
    };
    const createBackup = jest
      .fn()
      .mockResolvedValue({ id: 'backup-9', status: 'completed', label: 'nightly-x' });
    const { registry } = build({ createBackup }, repository);
    const result: any = await registry
      .require('backup.schedule.run')
      .handler(context({ input: { scheduleId } }));
    expect(result.backupId).toBe('backup-9');
    expect(createBackup.mock.calls[0][1].kind).toBe('full');
  });
});
