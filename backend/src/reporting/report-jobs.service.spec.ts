import { ReportJobsService, previousDay, previousIsoWeek } from './report-jobs.service';

describe('report period helpers', () => {
  it('computes the previous UTC day', () => {
    const period = previousDay(new Date('2026-07-09T13:45:00Z'));
    expect(period.start.toISOString()).toBe('2026-07-08T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-07-09T00:00:00.000Z');
  });
  it('computes the previous ISO week (Monday to Monday)', () => {
    // 2026-07-09 is a Thursday; the previous full ISO week is Jun 29 - Jul 6.
    const period = previousIsoWeek(new Date('2026-07-09T13:45:00Z'));
    expect(period.start.toISOString()).toBe('2026-06-29T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-07-06T00:00:00.000Z');
  });
});

describe('ReportJobsService.generateForTenant', () => {
  function clientWith(rows: Record<string, unknown[]>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: any = {
      calls,
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('INSERT INTO report_job_runs')) return { rowCount: 1, rows: [{ id: 1 }] };
        if (sql.includes('FROM smsc_definitions')) return { rows: rows.smscs ?? [] };
        if (sql.includes('FROM routing_rules')) return { rows: rows.routes ?? [] };
        if (sql.includes('FROM users')) return { rows: rows.recipients ?? [] };
        return { rows: [], rowCount: 1 };
      }),
    };
    return client;
  }

  it('claims the period, snapshots totals/smsc/route and notifies subscribers', async () => {
    const client = clientWith({
      smscs: [{ id: 'smsc-1', engine_id: 'carrier-a', name: 'Carrier A' }],
      routes: [{ id: 'route-1', name: 'Uganda MTN', target_smsc_id: 'smsc-1' }],
      recipients: [{ id: 'user-1' }, { id: 'user-2' }],
    });
    const database: any = {
      tenantTransaction: jest.fn((_tenant: string, work: any) => work(client)),
    };
    const sqlbox: any = {
      volumeSummary: jest.fn().mockResolvedValue({
        messages: 120,
        dlrs: 100,
        bySmsc: [{ smscId: 'carrier-a', messages: 120, dlrs: 100 }],
      }),
    };
    const service = new ReportJobsService(database, sqlbox);
    const generated = await service.generateForTenant(
      '7',
      previousDay(new Date('2026-07-09T01:00:00Z')),
    );
    expect(generated).toBe(true);
    expect(sqlbox.volumeSummary).toHaveBeenCalledWith(
      Math.floor(Date.parse('2026-07-08T00:00:00Z') / 1000),
      Math.floor(Date.parse('2026-07-09T00:00:00Z') / 1000),
      ['carrier-a'],
    );
    const snapshotCalls = client.calls.filter((call: any) =>
      call.sql.includes('INSERT INTO report_snapshots'),
    );
    // total + 1 smsc + 1 route
    expect(snapshotCalls).toHaveLength(3);
    expect(snapshotCalls[0].params).toEqual(
      expect.arrayContaining(['total', 'All traffic', 120, 100]),
    );
    const routeCall = snapshotCalls[2];
    expect(routeCall.params).toEqual(expect.arrayContaining(['route', 'route-1', 'Uganda MTN']));
    expect(JSON.parse(routeCall.params[9] as string)).toMatchObject({
      attribution: 'target_smsc',
    });
    const notifications = client.calls.filter((call: any) =>
      call.sql.includes('INSERT INTO user_notifications'),
    );
    expect(notifications).toHaveLength(2);
    expect(notifications[0].params?.[2]).toContain('Daily message report');
  });

  it('skips periods that were already reported', async () => {
    const client: any = {
      query: jest.fn(async (sql: string) =>
        sql.includes('INSERT INTO report_job_runs') ? { rowCount: 0, rows: [] } : { rows: [] },
      ),
    };
    const database: any = {
      tenantTransaction: jest.fn((_tenant: string, work: any) => work(client)),
    };
    const sqlbox: any = { volumeSummary: jest.fn() };
    const service = new ReportJobsService(database, sqlbox);
    await expect(
      service.generateForTenant('7', previousDay(new Date('2026-07-09T01:00:00Z'))),
    ).resolves.toBe(false);
    expect(sqlbox.volumeSummary).not.toHaveBeenCalled();
  });
});
