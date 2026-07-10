import { BackupDrScheduler, computeNextRun } from './backup-dr.scheduler';
import { BackupScheduleRow } from './backup-dr.repository';

const schedule = (over: Partial<BackupScheduleRow> = {}): BackupScheduleRow => ({
  id: 's-1',
  tenant_id: '1',
  name: 'nightly',
  cron: null,
  interval_minutes: 60,
  kind: 'full',
  retention_class: 'daily',
  enabled: true,
  last_run_at: null,
  next_run_at: null,
  created_by: 'op',
  created_at: new Date().toISOString(),
  ...over,
});

describe('computeNextRun', () => {
  const from = new Date('2026-07-10T00:00:00.000Z');
  it('advances by interval_minutes when set', () => {
    expect(computeNextRun(schedule({ interval_minutes: 90 }), from).toISOString()).toBe(
      '2026-07-10T01:30:00.000Z',
    );
  });
  it('falls back to daily for cron-only schedules', () => {
    expect(
      computeNextRun(schedule({ interval_minutes: null, cron: '0 2 * * *' }), from).toISOString(),
    ).toBe('2026-07-11T00:00:00.000Z');
  });
});

describe('BackupDrScheduler', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('does not start a timer under NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const scheduler = new BackupDrScheduler({} as any, {} as any, {} as any);
    const spy = jest.spyOn(global, 'setInterval');
    scheduler.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    scheduler.onModuleDestroy();
  });

  it('runs due schedules and applies retention for a tenant', async () => {
    const repository: any = {
      dueSchedules: jest.fn().mockResolvedValue([schedule()]),
      markScheduleRan: jest.fn().mockResolvedValue(undefined),
    };
    const service: any = {
      createBackup: jest.fn().mockResolvedValue({ id: 'b-1' }),
      applyRetention: jest.fn().mockResolvedValue([]),
    };
    const scheduler = new BackupDrScheduler({} as any, repository, service);
    const now = new Date('2026-07-10T00:00:00.000Z');

    const ran = await scheduler.runTenant({ tenantId: '1', userId: 'backup-scheduler' }, now);
    expect(ran).toBe(1);
    expect(service.createBackup).toHaveBeenCalledTimes(1);
    expect(service.applyRetention).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'backup-scheduler' },
      now,
    );
    // next_run_at advanced by the 60-minute interval.
    expect(repository.markScheduleRan).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'backup-scheduler' },
      's-1',
      now,
      new Date('2026-07-10T01:00:00.000Z'),
    );
  });
});
