import { ReportingAnalyticsService } from './reporting-analytics.service';

describe('ReportingAnalyticsService', () => {
  const service = new ReportingAnalyticsService({} as any, {} as any);

  it('publishes a report catalog with available and planned kinds', () => {
    const catalog = service.catalog();
    const keys = catalog.categories.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining(['traffic', 'per_smsc', 'per_route', 'operational', 'audit_security']),
    );
    const traffic = catalog.categories.find((c) => c.key === 'traffic')!;
    expect(traffic.kinds.some((k) => k.key === 'traffic_trend' && k.available)).toBe(true);
    const financial = catalog.categories.find((c) => c.key === 'financial')!;
    expect(financial.kinds.every((k) => !k.available)).toBe(true);
  });

  it('marks the new performance/heatmap/latency kinds available in the catalog', () => {
    const catalog = service.catalog();
    const kindKeys = catalog.categories.flatMap((c) => c.kinds.map((k) => k.key));
    for (const key of ['smsc_success', 'route_performance', 'hourly_heatmap', 'latency_sla']) {
      expect(kindKeys).toContain(key);
    }
    const performance = catalog.categories.find((c) => c.key === 'performance')!;
    expect(performance.kinds.find((k) => k.key === 'latency_sla')!.available).toBe(true);
  });

  it('computes per-SMSC success and failure rates from the latest daily snapshots', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('ORDER BY period_start DESC LIMIT 1'))
          return { rows: [{ period_start: '2026-07-09' }] };
        if (sql.includes('ORDER BY message_count DESC'))
          return {
            rows: [
              { scope_label: 'Carrier A', messages: '200', dlrs: '150' },
              { scope_label: 'Carrier B', messages: '0', dlrs: '0' },
            ],
          };
        return { rows: [] };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const result = await new ReportingAnalyticsService(database, {} as any).smscSuccess({
      tenantId: '1',
    });
    expect(result.period).toBe('2026-07-09');
    expect(result.groups[0]).toEqual({
      label: 'Carrier A',
      messages: 200,
      dlrs: 150,
      successRate: 0.75,
      failureRate: 0.25,
    });
    // A scope with no messages yields null rates rather than dividing by zero.
    expect(result.groups[1].successRate).toBeNull();
  });

  it('returns an honest unavailable heatmap when SQLBox is not configured', async () => {
    delete process.env.KAMEX_SQLBOX_DATABASE_URL;
    const result = await new ReportingAnalyticsService({} as any, {} as any).hourlyHeatmap({
      tenantId: '1',
    });
    expect(result.cells).toEqual([]);
    expect(result.maxCount).toBe(0);
    expect(result.source.status).toBe('unavailable');
  });

  it('returns honest null latency percentiles when SQLBox is not configured', async () => {
    delete process.env.KAMEX_SQLBOX_DATABASE_URL;
    const result = await new ReportingAnalyticsService({} as any, {} as any).latencySla({
      tenantId: '1',
    });
    expect(result.count).toBe(0);
    expect(result.p95).toBeNull();
    expect(result.note).toContain('foreign_id');
  });

  it('computes overview KPI cards including a delivery rate', async () => {
    const rows: Record<string, any[]> = {
      daily: [{ messages: '200', dlrs: '150', period_start: '2026-07-09' }],
      weekly: [{ messages: '1200', dlrs: '1000' }],
      smsc: [{ total: '3', enabled: '2', degraded: '1' }],
      alerts: [{ open: '4', critical: '1' }],
      routes: [{ c: '5' }],
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("period_type='daily' AND scope='total'")) return { rows: rows.daily };
        if (sql.includes("period_type='weekly'")) return { rows: rows.weekly };
        if (sql.includes('FROM smsc_definitions')) return { rows: rows.smsc };
        if (sql.includes('FROM alert_instances')) return { rows: rows.alerts };
        if (sql.includes('FROM routing_rules')) return { rows: rows.routes };
        return { rows: [] };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const svc = new ReportingAnalyticsService(database, {} as any);
    const overview = await svc.overview({ tenantId: '1' });
    const rate = overview.cards.find((c) => c.key === 'delivery_rate')!;
    expect(rate.value).toBe(75); // 150/200
    expect(overview.cards.find((c) => c.key === 'messages_today')!.value).toBe(200);
  });
});
