import { ReportingAnalyticsService, summariseOutcomes } from './reporting-analytics.service';
import { DLR_EVENT_STATUS } from '../engine/kamex-sqlbox.repository';

/** Zeroed delivery-status counts, overridden per test. */
const counts = (overrides: Partial<Record<string, number>> = {}) => ({
  delivered: 0,
  failed: 0,
  rejected: 0,
  buffered: 0,
  accepted: 0,
  pending: 0,
  unknown: 0,
  ...overrides,
});

/**
 * Snapshot-backed tenant transaction stub. `groups` are report_snapshots rows
 * for the latest daily period; `engineIds` are the tenant's SMSC engine ids.
 */
function databaseWith(groups: any[], engineIds: string[] = [], period = '2026-07-09') {
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM smsc_definitions'))
        return { rows: engineIds.map((engine_id) => ({ engine_id })) };
      if (sql.includes('ORDER BY period_start DESC LIMIT 1'))
        return { rows: [{ period_start: period, messages: '0', dlrs: '0' }] };
      if (sql.includes('ORDER BY message_count DESC')) return { rows: groups };
      return { rows: [] };
    }),
  };
  return { tenantTransaction: (_t: string, work: any) => work(client) } as any;
}

/** SQLBox repository stub returning per-SMSC delivery status counts. */
function sqlboxWith(bySmsc: Record<string, ReturnType<typeof counts>>) {
  return {
    deliveryStatusCounts: jest.fn(async ({ smscId }: { smscId?: string }) => {
      const found = smscId ? bySmsc[smscId] : undefined;
      if (!found) throw new Error(`no counts for ${smscId}`);
      return {
        ...found,
        resendable: found.failed + found.rejected,
        inFlight: found.buffered + found.accepted,
      };
    }),
  } as any;
}

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

  describe('delivery outcome semantics', () => {
    // The mask mapping lives in the engine repository; this asserts the shared
    // table is what reporting relies on, so the two can never silently diverge.
    it('maps each Kannel DLR event to success, failure or in-flight', () => {
      expect(DLR_EVENT_STATUS[1]).toBe('delivered'); // success
      expect(DLR_EVENT_STATUS[2]).toBe('failed'); // failure
      expect(DLR_EVENT_STATUS[4]).toBe('buffered'); // in flight
      expect(DLR_EVENT_STATUS[8]).toBe('accepted'); // in flight
      expect(DLR_EVENT_STATUS[16]).toBe('rejected'); // failure
      // 31 is the *requested* mask on an MT row, never a delivery event.
      expect(DLR_EVENT_STATUS[31]).toBeUndefined();

      const summary = summariseOutcomes(
        counts({ delivered: 1, failed: 1, rejected: 1, buffered: 1, accepted: 1, pending: 1 }),
      );
      // Only delivered/failed/rejected are finalised; buffered/accepted/pending are not.
      expect(summary.finalised).toBe(3);
      expect(summary.inFlight).toBe(2);
      expect(summary.successRate).toBeCloseTo(1 / 3, 4);
      expect(summary.failureRate).toBeCloseTo(2 / 3, 4);
    });

    it('returns a null success rate when nothing has finalised', () => {
      const summary = summariseOutcomes(counts({ pending: 500, buffered: 10, accepted: 5 }));
      expect(summary.successRate).toBeNull();
      expect(summary.failureRate).toBeNull();
      expect(summary.finalised).toBe(0);
    });

    it('does not let a pending backlog drag the denominator', () => {
      const summary = summariseOutcomes(counts({ delivered: 10, pending: 9990 }));
      expect(summary.successRate).toBe(1);
    });
  });

  it('computes per-SMSC success from delivery outcomes, not from DLR existence', async () => {
    const database = databaseWith(
      [
        {
          scope_key: 'smsc-a',
          scope_label: 'Carrier A',
          messages: '200',
          dlrs: '150',
          details: {},
        },
        { scope_key: 'smsc-b', scope_label: 'Carrier B', messages: '0', dlrs: '0', details: {} },
      ],
      ['smsc-a', 'smsc-b'],
    );
    const sqlbox = sqlboxWith({
      'smsc-a': counts({ delivered: 120, failed: 20, rejected: 10, pending: 50 }),
      'smsc-b': counts(),
    });
    const result = await new ReportingAnalyticsService(database, sqlbox).smscSuccess({
      tenantId: '1',
    });
    expect(result.period).toBe('2026-07-09');
    expect(result.groups[0]).toEqual({
      label: 'Carrier A',
      messages: 200,
      dlrs: 150,
      // 120 delivered / 150 finalised — NOT 150 DLRs / 200 messages (0.75).
      successRate: 0.8,
      failureRate: 0.2,
      dlrRate: 0.75, // the old successRate, kept under an honest name
      delivered: 120,
      failed: 20,
      rejected: 10,
      pending: 50,
      inFlight: 0,
      finalised: 150,
    });
    // A scope with nothing finalised yields null rates rather than 0 or 1.
    expect(result.groups[1].successRate).toBeNull();
    expect(result.groups[1].failureRate).toBeNull();
  });

  it('reports 0% success for a carrier whose traffic is entirely rejected', async () => {
    // THE BUG: every message produced a DLR, so dlrs/messages said 100% success
    // while the carrier delivered nothing at all.
    const database = databaseWith(
      [
        {
          scope_key: 'smsc-reject',
          scope_label: 'Rejecting carrier',
          messages: '500',
          dlrs: '500',
          details: {},
        },
      ],
      ['smsc-reject'],
    );
    const sqlbox = sqlboxWith({ 'smsc-reject': counts({ rejected: 500 }) });
    const result = await new ReportingAnalyticsService(database, sqlbox).smscSuccess({
      tenantId: '1',
    });
    expect(result.groups[0].successRate).toBe(0);
    expect(result.groups[0].failureRate).toBe(1);
    expect(result.groups[0].rejected).toBe(500);
    expect(result.groups[0].dlrRate).toBe(1); // what the old formula reported as success
  });

  it('attributes route performance through the snapshot target SMSC', async () => {
    const database = databaseWith(
      [
        {
          scope_key: 'route-1',
          scope_label: 'Primary route',
          messages: '10',
          dlrs: '10',
          details: { attribution: 'target_smsc', targetSmscEngineId: 'smsc-a' },
        },
        {
          scope_key: 'route-2',
          scope_label: 'Unrouted',
          messages: '0',
          dlrs: '0',
          details: { attribution: 'target_smsc', targetSmscEngineId: null },
        },
      ],
      ['smsc-a'],
    );
    const sqlbox = sqlboxWith({ 'smsc-a': counts({ delivered: 8, failed: 2 }) });
    const result = await new ReportingAnalyticsService(database, sqlbox).routePerformance({
      tenantId: '1',
    });
    expect(result.groups[0].successRate).toBe(0.8);
    // A route with no resolvable target SMSC reports null, not a guessed rate.
    expect(result.groups[1].successRate).toBeNull();
    expect(result.groups[1].delivered).toBeNull();
  });

  it('reports null rates (never a wrong one) when SQLBox cannot be read', async () => {
    const database = databaseWith(
      [
        {
          scope_key: 'smsc-a',
          scope_label: 'Carrier A',
          messages: '200',
          dlrs: '150',
          details: {},
        },
      ],
      ['smsc-a'],
    );
    const sqlbox = {
      deliveryStatusCounts: jest.fn(async () => {
        throw new Error('KAMEX_SQLBOX_DATABASE_URL is not configured');
      }),
    } as any;
    const result = await new ReportingAnalyticsService(database, sqlbox).smscSuccess({
      tenantId: '1',
    });
    expect(result.groups[0].successRate).toBeNull();
    expect(result.groups[0].dlrRate).toBe(0.75);
    expect(result.source.status).toBe('unavailable');
  });

  it('breaks delivery down by real outcome instead of labelling DLRs as delivered', async () => {
    const database = databaseWith([], ['smsc-a']);
    const sqlbox = {
      deliveryStatusCounts: jest.fn(async () => ({
        ...counts({
          delivered: 70,
          failed: 20,
          rejected: 10,
          buffered: 3,
          accepted: 2,
          pending: 5,
        }),
        resendable: 30,
        inFlight: 8,
      })),
    } as any;
    const result = await new ReportingAnalyticsService(database, sqlbox).deliveryBreakdown({
      tenantId: '1',
    });
    const labels = result.segments.map((s) => s.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Delivered', 'Failed', 'Rejected', 'Awaiting delivery report']),
    );
    expect(labels).not.toContain('Confirmed delivered');
    expect(result.segments.find((s) => s.label === 'Delivered')!.value).toBe(70);
    expect(result.successRate).toBe(0.7);
    expect(result.total).toBe(110);
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

  it('computes overview KPI cards including a real delivery success rate', async () => {
    const rows: Record<string, any[]> = {
      daily: [{ messages: '200', dlrs: '150', period_start: '2026-07-09' }],
      weekly: [{ messages: '1200', dlrs: '1000' }],
      smsc: [{ total: '3', enabled: '2', degraded: '1' }],
      alerts: [{ open: '4', critical: '1' }],
      routes: [{ c: '5' }],
      engines: [{ engine_id: 'smsc-a' }],
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT engine_id FROM smsc_definitions')) return { rows: rows.engines };
        if (sql.includes("period_type='daily' AND scope='total'")) return { rows: rows.daily };
        if (sql.includes("period_type='weekly'")) return { rows: rows.weekly };
        if (sql.includes('FROM smsc_definitions')) return { rows: rows.smsc };
        if (sql.includes('FROM alert_instances')) return { rows: rows.alerts };
        if (sql.includes('FROM routing_rules')) return { rows: rows.routes };
        return { rows: [] };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const sqlbox = {
      deliveryStatusCounts: jest.fn(async () => ({
        ...counts({ delivered: 120, failed: 20, rejected: 10, pending: 50 }),
        resendable: 30,
        inFlight: 0,
      })),
    } as any;
    const overview = await new ReportingAnalyticsService(database, sqlbox).overview({
      tenantId: '1',
    });
    // Coverage keeps its old value under a label that says what it measures.
    expect(overview.cards.find((c) => c.key === 'delivery_rate')!.value).toBe(75); // 150/200
    // Success is 120 delivered of 150 finalised.
    expect(overview.cards.find((c) => c.key === 'delivery_success_rate')!.value).toBe(80);
    expect(overview.cards.find((c) => c.key === 'delivery_failures')!.value).toBe(30);
    expect(overview.cards.find((c) => c.key === 'messages_today')!.value).toBe(200);
  });
});
