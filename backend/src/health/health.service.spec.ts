const mockPing = jest.fn();
const mockOn = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    ping: mockPing,
    on: mockOn,
    disconnect: mockDisconnect,
  })),
}));

import { DependencyHealth, HealthService, HealthStatus, safeDetail } from './health.service';

/** DatabaseService stub: resolves, rejects, or never settles (a wedged pool). */
function dbWith(behaviour: 'ok' | Error | 'hang') {
  return {
    query: jest.fn(() => {
      if (behaviour === 'hang') return new Promise(() => undefined);
      if (behaviour instanceof Error) return Promise.reject(behaviour);
      return Promise.resolve({ rows: [{ '?column?': 1 }] });
    }),
  } as any;
}

const dependency = (health: HealthStatus, name: DependencyHealth['name']) =>
  health.dependencies.find((d) => d.name === name)!;

describe('HealthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://localhost:6379';
    delete process.env.REDIS_SENTINELS;
    delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    mockPing.mockResolvedValue('PONG');
  });

  it('reports ok and probes every dependency when they are all up', async () => {
    const database = dbWith('ok');
    const health = await new HealthService(database).check();
    expect(health.status).toBe('ok');
    expect(health.service).toBe('jkannel-backend');
    expect(Number.isNaN(Date.parse(health.timestamp))).toBe(false);
    expect(typeof health.durationMs).toBe('number');
    // The probe is real: the database was actually queried.
    expect(database.query).toHaveBeenCalledWith('SELECT 1');
    expect(mockPing).toHaveBeenCalled();
    expect(dependency(health, 'postgres').status).toBe('ok');
    expect(dependency(health, 'redis').status).toBe('ok');
  });

  it('reports unhealthy when the database probe throws', async () => {
    const health = await new HealthService(dbWith(new Error('connection refused'))).check();
    expect(health.status).toBe('unhealthy');
    expect(dependency(health, 'postgres').status).toBe('unhealthy');
    expect(dependency(health, 'postgres').required).toBe(true);
    expect(dependency(health, 'postgres').detail).toContain('connection refused');
  });

  it('times a wedged database out instead of hanging, and never throws', async () => {
    process.env.HEALTH_CHECK_TIMEOUT_MS = '200';
    const startedAt = Date.now();
    const health = await new HealthService(dbWith('hang')).check();
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(health.status).toBe('unhealthy');
    expect(dependency(health, 'postgres').status).toBe('unhealthy');
    expect(dependency(health, 'postgres').detail).toContain('timed out');
  });

  it('degrades (rather than failing) when only the optional Redis dependency is down', async () => {
    mockPing.mockRejectedValue(new Error('ECONNREFUSED'));
    const health = await new HealthService(dbWith('ok')).check();
    expect(health.status).toBe('degraded');
    expect(dependency(health, 'redis').status).toBe('unhealthy');
    expect(dependency(health, 'redis').required).toBe(false);
    expect(dependency(health, 'postgres').status).toBe('ok');
  });

  it('recovers to ok once Redis comes back, instead of latching degraded', async () => {
    // The shared client factory sets retryStrategy: () => null, so a client whose
    // connection dropped fails every later PING with "Connection is closed."
    // A failed probe must therefore discard the client and rebuild it, otherwise
    // one transient blip pins the service to degraded until it restarts. This was
    // observed against the live stack before the fix.
    const service = new HealthService(dbWith('ok'));
    mockPing.mockRejectedValueOnce(new Error('Connection is closed.'));
    const down = await service.check();
    expect(down.status).toBe('degraded');
    expect(mockDisconnect).toHaveBeenCalled();

    mockPing.mockResolvedValue('PONG');
    const recovered = await service.check();
    expect(recovered.status).toBe('ok');
    expect(dependency(recovered, 'redis').status).toBe('ok');
  });

  it('skips Redis (staying ok) when no Redis is configured', async () => {
    delete process.env.REDIS_URL;
    const health = await new HealthService(dbWith('ok')).check();
    expect(health.status).toBe('ok');
    expect(dependency(health, 'redis').status).toBe('skipped');
    expect(mockPing).not.toHaveBeenCalled();
  });

  it('never leaks connection strings, credentials or stack traces', async () => {
    const error = new Error(
      'connect ECONNREFUSED postgres://jkannel_app:s3cr3t@postgres:5432/jkannel\n' +
        '    at Socket.<anonymous> (/app/node_modules/pg/lib/client.js:1:1)',
    );
    const health = await new HealthService(dbWith(error)).check();
    const detail = dependency(health, 'postgres').detail;
    expect(detail).not.toContain('s3cr3t');
    expect(detail).not.toContain('postgres://');
    expect(detail).not.toContain('node_modules');
    expect(detail).toContain('[redacted]');
    expect(safeDetail('password = hunter2')).toBe('password=[redacted]');
  });
});
