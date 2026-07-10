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
