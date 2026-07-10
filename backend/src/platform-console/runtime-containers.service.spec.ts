import { RuntimeContainersService } from './runtime-containers.service';

describe('RuntimeContainersService', () => {
  it('reports live health for probed services and honest unknown for the rest', async () => {
    const database: any = {
      query: jest.fn().mockResolvedValue({ rows: [{ v: 'PostgreSQL 17.0' }] }),
    };
    const engines: any = {
      forImplementation: () => ({
        identify: jest.fn().mockResolvedValue({ family: 'kamex', version: '1.8.3' }),
        health: jest.fn().mockResolvedValue({ transport: 'reachable', engine: 'degraded' }),
      }),
    };
    const sqlbox: any = { probe: jest.fn().mockResolvedValue({ available: true, evidence: 'ok' }) };
    const service = new RuntimeContainersService(database, engines, sqlbox);

    const { items, total } = await service.list();
    expect(total).toBe(items.length);
    const postgres = items.find((c) => c.service === 'postgres')!;
    expect(postgres.observed).toBe(true);
    expect(postgres.health).toBe('healthy');

    const engine = items.find((c) => c.service === 'kamex-bearerbox')!;
    expect(engine.observed).toBe(true);
    expect(engine.health).toBe('degraded');

    // Redis is not probed from the API — must be honest, never a fake "healthy".
    const redis = items.find((c) => c.service === 'redis')!;
    expect(redis.observed).toBe(false);
    expect(redis.health).toBe('unknown');
  });
});
