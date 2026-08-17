import { TelemetryFreshnessService } from './telemetry-freshness.service';
import { SystemInfoService } from './system-info.service';

const T0 = Date.parse('2026-08-06T12:00:00.000Z');

function makeService(options: {
  observedAgoSeconds?: number | null;
  sourceStatus?: 'ok' | 'degraded' | 'unavailable';
  sourceDetail?: string;
  gate?: { suppressed: boolean; kind: 'credentials' | 'unreachable' | 'unknown' };
}) {
  const observedAt =
    options.observedAgoSeconds === null || options.observedAgoSeconds === undefined
      ? null
      : new Date(T0 - options.observedAgoSeconds * 1000).toISOString();
  const cache: any = {
    get: () =>
      observedAt
        ? {
            snapshot: {
              observedAt,
              source: { status: options.sourceStatus ?? 'ok', detail: options.sourceDetail },
            },
            cachedAt: new Date(observedAt),
          }
        : null,
  };
  const adapter: any = {
    gateState: () => options.gate ?? { suppressed: false, kind: 'unknown', consecutiveFailures: 0 },
  };
  return new TelemetryFreshnessService(adapter, cache);
}

/**
 * The state machine exists because "how old is this number" and "why did it stop
 * moving" are different questions with different fixes, and a bare timestamp
 * cannot tell them apart. A screen that reports suppressed polling as an engine
 * outage sends an operator to restart a healthy engine.
 */
describe('TelemetryFreshnessService', () => {
  it('reports live inside one poll interval', () => {
    const result = makeService({ observedAgoSeconds: 12 }).current(T0);
    expect(result.state).toBe('live');
    expect(result.ageSeconds).toBe(12);
  });

  it('tolerates a single missed poll rather than crying stale on normal jitter', () => {
    // Poller runs at 30s; 40s is one late cycle, not a signal.
    expect(makeService({ observedAgoSeconds: 40 }).current(T0).state).toBe('live');
  });

  it('reports delayed once more than one interval has been missed', () => {
    const result = makeService({ observedAgoSeconds: 90 }).current(T0);
    expect(result.state).toBe('delayed');
    expect(result.detail).toMatch(/90s ago/);
  });

  it('reports disconnected after a long silence and says the figures are historical', () => {
    const result = makeService({ observedAgoSeconds: 400 }).current(T0);
    expect(result.state).toBe('disconnected');
    expect(result.detail).toMatch(/historical/);
  });

  it('does not claim freshness when the last poll failed, however recent it was', () => {
    // A snapshot two seconds old whose source is `unavailable` is not live data.
    // Age alone would have called this healthy.
    const result = makeService({
      observedAgoSeconds: 2,
      sourceStatus: 'unavailable',
      sourceDetail: 'connect ECONNREFUSED',
    }).current(T0);
    expect(result.state).toBe('disconnected');
    expect(result.cause).toBe('unreachable');
    expect(result.detail).toMatch(/ECONNREFUSED/);
  });

  it('distinguishes suppressed polling from an engine outage, and names the credential', () => {
    const result = makeService({
      observedAgoSeconds: 30,
      gate: { suppressed: true, kind: 'credentials' },
    }).current(T0);
    expect(result.state).toBe('disconnected');
    expect(result.pollingSuppressed).toBe(true);
    expect(result.cause).toBe('credentials');
    // The operator must be sent to the right system.
    expect(result.detail).toMatch(/KAMEX_STATUS_PASSWORD/);
    expect(result.detail).toMatch(/reachable/);
  });

  it('reports suppression from repeated failures without blaming the credential', () => {
    const result = makeService({
      observedAgoSeconds: 30,
      gate: { suppressed: true, kind: 'unreachable' },
    }).current(T0);
    expect(result.pollingSuppressed).toBe(true);
    expect(result.detail).not.toMatch(/KAMEX_STATUS_PASSWORD/);
  });

  it('says unknown, not live, before the first observation', () => {
    const result = makeService({ observedAgoSeconds: null }).current(T0);
    expect(result.state).toBe('unknown');
    expect(result.ageSeconds).toBeNull();
  });
});

describe('SystemInfoService', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the declared deployment designation and marks it declared', () => {
    process.env.JKANNEL_ENVIRONMENT = 'disaster-recovery';
    const info = new SystemInfoService().info();
    expect(info.environment).toBe('disaster-recovery');
    expect(info.environmentLabel).toBe('DR');
    expect(info.environmentDeclared).toBe(true);
    expect(info.environmentTone).toBe('warning');
  });

  /**
   * NODE_ENV cannot distinguish a DR site from a production site — both run
   * `production`. Inferring "Production" and presenting it as fact is the exact
   * mistake this indicator exists to prevent, so the inference is flagged.
   */
  it('falls back to NODE_ENV but admits the designation was inferred', () => {
    delete process.env.JKANNEL_ENVIRONMENT;
    process.env.NODE_ENV = 'production';
    const info = new SystemInfoService().info();
    expect(info.environment).toBe('production');
    expect(info.environmentDeclared).toBe(false);
  });

  it('treats an unrecognised designation as undeclared rather than trusting it', () => {
    process.env.JKANNEL_ENVIRONMENT = 'prod-eu-west';
    process.env.NODE_ENV = 'production';
    const info = new SystemInfoService().info();
    expect(info.environmentDeclared).toBe(false);
    expect(info.environment).toBe('production');
  });

  it('marks production as the most prominent tone', () => {
    process.env.JKANNEL_ENVIRONMENT = 'production';
    expect(new SystemInfoService().info().environmentTone).toBe('critical');
  });

  it('reports a null build rather than inventing one when the image is unstamped', () => {
    delete process.env.JKANNEL_BUILD_SHA;
    expect(new SystemInfoService().info().build).toBeNull();
  });
});
