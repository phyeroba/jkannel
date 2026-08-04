import { MetricsController } from './metrics.controller';
import { HealthService } from '../health/health.service';

/** DatabaseService stub for the health probe behind jkannel_backend_up. */
const database = { query: async () => ({ rows: [{ ok: 1 }] }) } as any;

describe('MetricsController', () => {
  it('emits Prometheus text without the JSON envelope contract', async () => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINELS;
    const controller = new MetricsController(new HealthService(database));
    const response = {
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      send(body: string) {
        this.body = body;
      },
    };
    await controller.metrics(response);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('jkannel_backend_up{service="jkannel-backend",status="ok"} 1');
    expect(response.body).toContain('jkannel_backend_memory_bytes');
  });
});
