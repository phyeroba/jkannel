import { MetricsController } from './metrics.controller';
import { HealthService } from '../health/health.service';

describe('MetricsController', () => {
  it('emits Prometheus text without the JSON envelope contract', () => {
    const controller = new MetricsController(new HealthService());
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
    controller.metrics(response);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('jkannel_backend_up');
    expect(response.body).toContain('jkannel_backend_memory_bytes');
  });
});
