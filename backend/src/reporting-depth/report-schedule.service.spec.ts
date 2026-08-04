import { ReportScheduleService } from './report-schedule.service';

describe('ReportScheduleService', () => {
  const build = (over: Partial<Record<string, any>> = {}) =>
    new ReportScheduleService(
      over.database ?? ({} as any),
      over.analytics ?? ({} as any),
      over.exporter ?? ({ toCsv: () => 'csv' } as any),
      over.notifications,
    );

  describe('isDue', () => {
    const service = build();
    const now = new Date('2026-07-10T12:00:00Z');
    it('is false without a schedule', () => {
      expect(service.isDue(null, null, now)).toBe(false);
      expect(service.isDue('monthly', null, now)).toBe(false);
    });
    it('is true when never run', () => {
      expect(service.isDue('daily', null, now)).toBe(true);
    });
    it('is false within the cadence window and true past it', () => {
      const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);
      expect(service.isDue('daily', twoHoursAgo, now)).toBe(false);
      expect(service.isDue('hourly', twoHoursAgo, now)).toBe(true);
      const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000);
      expect(service.isDue('weekly', eightDaysAgo, now)).toBe(true);
    });
  });

  describe('renderReport', () => {
    it('shapes smsc_success groups into export rows', async () => {
      const analytics: any = {
        smscSuccess: jest.fn(async () => ({
          period: '2026-07-09',
          groups: [
            {
              label: 'Carrier A',
              messages: 10,
              dlrs: 8,
              delivered: 6,
              failed: 1,
              rejected: 1,
              pending: 2,
              successRate: 0.75,
              failureRate: 0.25,
            },
          ],
        })),
      };
      const report = await build({ analytics }).renderReport('smsc_success', '1', null);
      expect(analytics.smscSuccess).toHaveBeenCalledWith({ tenantId: '1' });
      expect(report.rows).toHaveLength(1);
      // Raw outcome counts are exported alongside the rate so it is judgeable.
      expect(report.columns.map((c) => c.key)).toEqual([
        'label',
        'messages',
        'dlrs',
        'delivered',
        'failed',
        'rejected',
        'pending',
        'successRate',
        'failureRate',
      ]);
      expect(report.summary).toContain('2026-07-09');
    });

    it('passes a days parameter through to latency_sla', async () => {
      const analytics: any = {
        latencySla: jest.fn(async () => ({ count: 3, p50: 1, p95: 2, p99: 3, window: '14d' })),
      };
      const report = await build({ analytics }).renderReport('latency_sla', '1', { days: 14 });
      expect(analytics.latencySla).toHaveBeenCalledWith({ tenantId: '1' }, 14);
      expect(report.rows).toEqual([{ count: 3, p50: 1, p95: 2, p99: 3 }]);
    });

    it('throws for a non-runnable report type', async () => {
      await expect(build().renderReport('nope', '1', null)).rejects.toThrow();
    });
  });

  describe('runForTenant', () => {
    it('delivers a due definition in-app when no channels exist and records the run', async () => {
      const calls: Array<{ sql: string; params: any[] }> = [];
      const client = {
        query: jest.fn(async (sql: string, params: any[] = []) => {
          calls.push({ sql, params });
          if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
          if (sql.includes('FROM report_definitions'))
            return {
              rows: [
                {
                  id: 'def-1',
                  name: 'Nightly',
                  report_type: 'smsc_success',
                  parameters: {},
                  schedule: 'daily',
                  format: 'csv',
                  last_ran_at: null,
                },
              ],
            };
          if (sql.includes('FROM users')) return { rows: [{ id: 'u1' }] };
          if (sql.includes('FROM notification_channels')) return { rows: [] };
          return { rows: [] };
        }),
      };
      const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
      const analytics: any = {
        smscSuccess: jest.fn(async () => ({
          period: '2026-07-09',
          groups: [{ label: 'A', messages: 1, dlrs: 1, successRate: 1, failureRate: 0 }],
        })),
      };
      const recorded = await build({ database, analytics }).runForTenant('1', new Date());
      expect(recorded).toBe(1);
      const runInsert = calls.find((c) => c.sql.includes('INSERT INTO report_definition_runs'));
      expect(runInsert?.params[2]).toBe('in-app-only');
    });

    it('skips when the advisory lock is held by another worker', async () => {
      const client = { query: jest.fn(async () => ({ rows: [{ locked: false }] })) };
      const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
      const recorded = await build({ database }).runForTenant('1', new Date());
      expect(recorded).toBe(0);
      expect(client.query).toHaveBeenCalledTimes(1);
    });
  });
});
