import { GatewayPerformanceService } from './gateway-performance.service';

/**
 * The window/bucket choice is pure arithmetic and the thing most likely to be
 * changed carelessly later, so it is tested without a database at all.
 */
describe('GatewayPerformanceService.resolveWindow', () => {
  it('defaults to six hours when nothing is asked for', () => {
    expect(GatewayPerformanceService.resolveWindow(undefined).windowMinutes).toBe(360);
    expect(GatewayPerformanceService.resolveWindow('not a number').windowMinutes).toBe(360);
  });

  it('clamps rather than rejecting, because this is a chart range', () => {
    expect(GatewayPerformanceService.resolveWindow(1).windowMinutes).toBe(5);
    expect(GatewayPerformanceService.resolveWindow(999_999).windowMinutes).toBe(60 * 24 * 7);
  });

  it('widens the bucket with the window so the chart keeps a readable density', () => {
    // Narrow windows must not bucket so coarsely that the series collapses to
    // two points, and a week must not return 10,000.
    const hour = GatewayPerformanceService.resolveWindow(60);
    const week = GatewayPerformanceService.resolveWindow(60 * 24 * 7);
    expect(hour.bucketSeconds).toBeLessThan(week.bucketSeconds);
    expect((hour.windowMinutes * 60) / hour.bucketSeconds).toBeLessThanOrEqual(48);
    expect((week.windowMinutes * 60) / week.bucketSeconds).toBeGreaterThan(0);
  });
});

/**
 * A client that answers each of the three queries by matching a fragment of its
 * SQL. Matching on text rather than call order means a future reordering of the
 * `Promise.all` does not silently hand the ceiling rows to the series parser.
 */
function fakeDatabase(rows: { series?: any[]; sampling?: any[]; ceiling?: any[] }) {
  const client = {
    query: jest.fn(async (text: string) => {
      if (text.includes('smsc_definitions')) return { rows: rows.ceiling ?? [] };
      if (text.includes('percentile_cont')) return { rows: rows.sampling ?? [] };
      return { rows: rows.series ?? [] };
    }),
  };
  return {
    tenantTransaction: async (_tenantId: string, run: (client: any) => Promise<any>) => run(client),
  } as any;
}

const actor = { tenantId: '1', userId: '1' };

describe('GatewayPerformanceService.throughput', () => {
  it('reports an unmeasured estate as unknown, never as a zero-capacity one', async () => {
    // Nothing polled and no ceiling declared. Every honest answer here is null:
    // rendering 0/s of capacity would say the gateway can send nothing, which is
    // the opposite of what an undeclared ceiling means.
    const service = new GatewayPerformanceService(
      fakeDatabase({
        series: [],
        sampling: [{ polls: 0, median_gap: null, last_at: null, latest_outbound: null }],
        ceiling: [{ effective_tps: 0, with_ceiling: 0, without_ceiling: 2, connections: 2 }],
      }),
    );
    const result = await service.throughput(actor, 60);
    expect(result.points).toEqual([]);
    expect(result.peakOutbound).toBeNull();
    expect(result.latestOutbound).toBeNull();
    expect(result.ceiling.effectiveTps).toBeNull();
    expect(result.ceiling.smscsWithoutCeiling).toBe(2);
    expect(result.sampling.intervalSeconds).toBeNull();
    expect(result.sampling.lastObservedAt).toBeNull();
  });

  it('multiplies the declared ceiling by connections, as the engine enforces it', async () => {
    const service = new GatewayPerformanceService(
      fakeDatabase({
        ceiling: [{ effective_tps: 150, with_ceiling: 2, without_ceiling: 1, connections: 4 }],
        sampling: [{ polls: 0, median_gap: null, last_at: null, latest_outbound: null }],
      }),
    );
    const result = await service.throughput(actor, 60);
    expect(result.ceiling.effectiveTps).toBe(150);
    expect(result.ceiling.contributingSmscs).toBe(2);
    // One connection contributes no known ceiling, so 150 is a lower bound and
    // the console has what it needs to say so.
    expect(result.ceiling.smscsWithoutCeiling).toBe(1);
    expect(result.ceiling.connections).toBe(4);
  });

  it('carries the per-bucket peak alongside the mean', async () => {
    const service = new GatewayPerformanceService(
      fakeDatabase({
        series: [
          {
            bucket_at: '2026-08-21T09:00:00.000Z',
            outbound_avg: '12.5',
            outbound_peak: '40',
            inbound_avg: '2',
            samples: 4,
          },
          {
            bucket_at: '2026-08-21T09:10:00.000Z',
            outbound_avg: '30',
            outbound_peak: '31',
            inbound_avg: '3',
            samples: 4,
          },
        ],
        sampling: [
          {
            polls: 8,
            median_gap: '29.87',
            last_at: '2026-08-21T09:19:30.000Z',
            latest_outbound: '28',
          },
        ],
        ceiling: [{ effective_tps: 100, with_ceiling: 2, without_ceiling: 0, connections: 2 }],
      }),
    );
    const result = await service.throughput(actor, 60);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({ outbound: 12.5, peakOutbound: 40, samples: 4 });
    // The window peak is the highest single POLL, not the highest bucket mean —
    // a spike inside a quiet bucket is exactly what a capacity screen is for.
    expect(result.peakOutbound).toBe(40);
    expect(result.latestOutbound).toBe(28);
  });

  it('reports the measured poll interval, rounded, not the configured one', async () => {
    const service = new GatewayPerformanceService(
      fakeDatabase({
        sampling: [
          {
            polls: 12,
            median_gap: '29.87',
            last_at: new Date(Date.now() - 4_000).toISOString(),
            latest_outbound: '5',
          },
        ],
        ceiling: [{ effective_tps: 10, with_ceiling: 1, without_ceiling: 0, connections: 1 }],
      }),
    );
    const result = await service.throughput(actor, 60);
    expect(result.sampling.intervalSeconds).toBe(30);
    expect(result.sampling.polls).toBe(12);
    expect(result.sampling.ageSeconds).toBeGreaterThanOrEqual(3);
    expect(result.sampling.ageSeconds).toBeLessThanOrEqual(6);
  });

  it('names the latencies it cannot measure instead of leaving a blank panel', async () => {
    const service = new GatewayPerformanceService(
      fakeDatabase({
        sampling: [{ polls: 0, median_gap: null, last_at: null, latest_outbound: null }],
        ceiling: [{ effective_tps: 0, with_ceiling: 0, without_ceiling: 0, connections: 0 }],
      }),
    );
    const result = await service.throughput(actor, 60);
    expect(result.limits.unavailable).toEqual(
      expect.arrayContaining([expect.stringContaining('submit latency')]),
    );
    // And it must point at the latency that IS measured, or an operator reads
    // "no latency available" and stops looking.
    expect(result.limits.reason).toContain('DLR Performance');
  });
});
