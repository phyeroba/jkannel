import { EngineQueueSnapshot } from '../engine/kamex.adapter';
import { EngineMetricsService } from './engine-metrics.service';
import { EngineSnapshotCache } from './engine-snapshot.cache';

const AT = new Date('2026-08-04T03:00:00.000Z');

function snapshot(overrides: Partial<EngineQueueSnapshot> = {}): EngineQueueSnapshot {
  return {
    observedAt: AT.toISOString(),
    engine: {
      status: 'running',
      version: '1.8.3',
      uptimeSeconds: 7200,
      smsQueuedOut: 12,
      smsQueuedIn: 3,
      dlrQueued: 5,
      storeSize: null,
    },
    binds: [
      {
        engineId: 'local-fake',
        name: 'Local Fake',
        status: 'online',
        queued: 7,
        failed: 2,
        sent: 100,
        received: 40,
        outboundRate: [1.5, 1.25, 1],
        inboundRate: [0.5, 0.25, 0],
      },
      {
        engineId: 'local-fake-b',
        name: 'Local Fake B',
        status: 'connecting',
        queued: 0,
        failed: 0,
        sent: 0,
        received: 0,
        outboundRate: [0, 0, 0],
        inboundRate: [0, 0, 0],
      },
    ],
    source: { status: 'ok', detail: 'Parsed from Kamex bearerbox /status.json' },
    ...overrides,
  };
}

function render(value: EngineQueueSnapshot | null, now = AT): string {
  const cache = new EngineSnapshotCache();
  if (value) cache.set(value, AT);
  return new EngineMetricsService(cache).render(now);
}

describe('EngineMetricsService exposition', () => {
  it('exports per-bind status, queue depth, failures, volume and throughput', () => {
    const out = render(snapshot());
    expect(out).toContain('jkannel_smsc_bind_up{smsc="local-fake",state="bound"} 1');
    expect(out).toContain('jkannel_smsc_bind_up{smsc="local-fake-b",state="connecting"} 0');
    expect(out).toContain('jkannel_smsc_queued{smsc="local-fake"} 7');
    expect(out).toContain('jkannel_smsc_failed_total{smsc="local-fake"} 2');
    expect(out).toContain('jkannel_smsc_messages_total{smsc="local-fake",direction="sent"} 100');
    expect(out).toContain('jkannel_smsc_messages_total{smsc="local-fake",direction="received"} 40');
    expect(out).toContain(
      'jkannel_smsc_throughput_messages_per_second{smsc="local-fake",direction="outbound",window="1m"} 1.500',
    );
    expect(out).toContain(
      'jkannel_smsc_throughput_messages_per_second{smsc="local-fake",direction="inbound",window="15m"} 0',
    );
  });

  it('exports the engine-wide queue, DLR and bind-count gauges', () => {
    const out = render(snapshot());
    expect(out).toContain('jkannel_engine_up 1');
    expect(out).toContain('jkannel_engine_sms_queued{direction="outbound"} 12');
    expect(out).toContain('jkannel_engine_sms_queued{direction="inbound"} 3');
    expect(out).toContain('jkannel_engine_dlr_queued 5');
    expect(out).toContain('jkannel_engine_binds 2');
    expect(out).toContain('jkannel_engine_binds_bound 1');
    expect(out).toContain('jkannel_engine_uptime_seconds 7200');
  });

  it('emits a HELP and TYPE header for every metric family it exports', () => {
    const out = render(snapshot());
    const families = new Set(
      out
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => line.split(/[{ ]/)[0]),
    );
    for (const family of families) {
      expect(out).toContain(`# HELP ${family} `);
      expect(out).toContain(`# TYPE ${family} `);
    }
  });

  it('omits the store size entirely when the engine reports it as unknown (-1 -> null)', () => {
    // The adapter already converts bearerbox's -1 sentinel to null; exporting 0
    // would read as "the spool is empty", which is a different claim.
    expect(render(snapshot())).not.toContain('jkannel_engine_store_size');
    const known = snapshot();
    known.engine.storeSize = 42;
    expect(render(known)).toContain('jkannel_engine_store_size 42');
  });

  it('omits nullable engine counters rather than reporting them as zero', () => {
    const partial = snapshot();
    partial.engine.smsQueuedOut = null;
    partial.engine.dlrQueued = null;
    partial.engine.uptimeSeconds = null;
    const out = render(partial);
    expect(out).not.toContain('jkannel_engine_sms_queued{direction="outbound"}');
    expect(out).not.toContain('jkannel_engine_dlr_queued');
    expect(out).not.toContain('jkannel_engine_uptime_seconds');
    expect(out).toContain('jkannel_engine_sms_queued{direction="inbound"} 3');
  });
});

describe('EngineMetricsService honesty about the cache', () => {
  it('serves from the cached snapshot and exposes its age (never calls the engine)', () => {
    const out = render(snapshot(), new Date('2026-08-04T03:00:20.000Z'));
    expect(out).toContain('jkannel_engine_snapshot_age_seconds 20');
    expect(out).toContain('jkannel_engine_poller_up 1');
  });

  it('reports engine down with no bind gauges when the last poll was unavailable', () => {
    const out = render(
      snapshot({
        binds: [],
        source: { status: 'unavailable', detail: 'Kamex status unavailable: fetch failed' },
      }),
    );
    expect(out).toContain('jkannel_engine_up 0');
    expect(out).not.toContain('jkannel_smsc_bind_up');
    expect(out).not.toContain('jkannel_engine_sms_queued');
  });

  it('reports poller-down rather than a healthy engine when nothing has been cached', () => {
    const out = render(null);
    expect(out).toContain('jkannel_engine_up 0');
    expect(out).toContain('jkannel_engine_poller_up 0');
    expect(out).not.toContain('jkannel_smsc_bind_up');
  });

  it('escapes label values so a hostile bind id cannot break the exposition format', () => {
    const hostile = snapshot({
      binds: [
        {
          engineId: 'weird"id',
          name: 'weird',
          status: 'online',
          queued: 0,
          failed: 0,
          sent: 0,
          received: 0,
          outboundRate: [0, 0, 0],
          inboundRate: [0, 0, 0],
        },
      ],
    });
    expect(render(hostile)).toContain('jkannel_smsc_bind_up{smsc="weird\\"id",state="bound"} 1');
  });
});
