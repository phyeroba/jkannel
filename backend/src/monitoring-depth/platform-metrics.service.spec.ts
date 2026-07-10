const mockInfo = jest.fn();
const mockOn = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    info: mockInfo,
    on: mockOn,
    disconnect: mockDisconnect,
  })),
}));

import { PlatformMetricsService } from './platform-metrics.service';

function dbWith(rows: any[] | Error) {
  return {
    query: jest.fn(async () => {
      if (rows instanceof Error) throw rows;
      return { rows };
    }),
  } as any;
}

const DB_ROW = {
  connections: '12',
  db_size: '104857600',
  commits: '5000',
  rollbacks: '7',
};

describe('PlatformMetricsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://localhost:6379';
    mockInfo.mockResolvedValue('used_memory:1048576\r\nconnected_clients:7\r\nrole:master\r\n');
  });

  it('renders database gauges from pg_stat queries', async () => {
    const service = new PlatformMetricsService(dbWith([DB_ROW]));
    const out = await service.render();
    expect(out).toContain('jkannel_db_up 1');
    expect(out).toContain('jkannel_db_connections 12');
    expect(out).toContain('jkannel_db_size_bytes 104857600');
    expect(out).toContain('jkannel_db_commits_total 5000');
    expect(out).toContain('jkannel_db_rollbacks_total 7');
    // Prometheus HELP/TYPE headers present.
    expect(out).toContain('# TYPE jkannel_db_connections gauge');
  });

  it('renders jkannel_db_up 0 when the database query fails', async () => {
    const service = new PlatformMetricsService(dbWith(new Error('connection refused')));
    const out = await service.render();
    expect(out).toContain('jkannel_db_up 0');
    expect(out).not.toContain('jkannel_db_connections');
  });

  it('renders redis gauges parsed from INFO', async () => {
    const service = new PlatformMetricsService(dbWith([DB_ROW]));
    const out = await service.render();
    expect(out).toContain('jkannel_redis_up 1');
    expect(out).toContain('jkannel_redis_used_memory_bytes 1048576');
    expect(out).toContain('jkannel_redis_connected_clients 7');
  });

  it('renders jkannel_redis_up 0 when Redis is unreachable', async () => {
    mockInfo.mockRejectedValue(new Error('ECONNREFUSED'));
    const service = new PlatformMetricsService(dbWith([DB_ROW]));
    const out = await service.render();
    expect(out).toContain('jkannel_redis_up 0');
    expect(out).not.toContain('jkannel_redis_used_memory_bytes');
  });
});
