import { MetricsController } from './metrics.controller';
import { HealthService } from '../health/health.service';
import { EngineMetricsService } from '../monitoring-depth/engine-metrics.service';
import { EngineSnapshotCache } from '../monitoring-depth/engine-snapshot.cache';

/** DatabaseService stub for the health probe behind jkannel_backend_up. */
const database = { query: async () => ({ rows: [{ ok: 1 }] }) } as any;

function makeResponse() {
  return {
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    send(body: string) {
      this.body = body;
    },
  };
}

describe('MetricsController', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINELS;
  });

  it('emits Prometheus text without the JSON envelope contract', async () => {
    const controller = new MetricsController(new HealthService(database));
    const response = makeResponse();
    await controller.metrics(response);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('jkannel_backend_up{service="jkannel-backend",status="ok"} 1');
    expect(response.body).toContain('jkannel_backend_memory_bytes');
  });

  it('appends SMS/SMSC telemetry from the cached engine snapshot', async () => {
    const cache = new EngineSnapshotCache();
    cache.set({
      observedAt: '2026-08-04T03:00:00.000Z',
      engine: {
        status: 'running',
        version: '1.8.3',
        uptimeSeconds: 60,
        smsQueuedOut: 3,
        smsQueuedIn: 0,
        dlrQueued: 1,
        storeSize: null,
      },
      binds: [
        {
          engineId: 'local-fake',
          name: 'Local Fake',
          status: 'online',
          queued: 3,
          failed: 0,
          sent: 9,
          received: 1,
          outboundRate: [0, 0, 0],
          inboundRate: [0, 0, 0],
        },
      ],
      source: { status: 'ok', detail: 'ok' },
    });
    const controller = new MetricsController(
      new HealthService(database),
      undefined,
      undefined,
      new EngineMetricsService(cache),
    );
    const response = makeResponse();
    await controller.metrics(response);
    expect(response.body).toContain('jkannel_engine_up 1');
    expect(response.body).toContain('jkannel_smsc_bind_up{smsc="local-fake",state="bound"} 1');
    expect(response.body).toContain('jkannel_smsc_queued{smsc="local-fake"} 3');
    // Node-process metrics are still present; the SMS metrics are additive.
    expect(response.body).toContain('jkannel_backend_memory_bytes');
  });

  it('never fails the scrape when the engine exporter throws', async () => {
    const exploding = {
      render: () => {
        throw new Error('unexpected');
      },
    } as unknown as EngineMetricsService;
    const controller = new MetricsController(
      new HealthService(database),
      undefined,
      undefined,
      exploding,
    );
    const response = makeResponse();
    await controller.metrics(response);
    expect(response.body).toContain('jkannel_backend_up');
  });
});
