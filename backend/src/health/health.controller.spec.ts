import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService, HealthStatus } from './health.service';

/** Captures the status code the controller sets on the passthrough response. */
function fakeResponse() {
  return {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

async function controllerFor(status: HealthStatus['status']) {
  const health: HealthStatus = {
    service: 'jkannel-backend',
    status,
    timestamp: new Date().toISOString(),
    durationMs: 1,
    dependencies: [
      {
        name: 'postgres',
        status: status === 'unhealthy' ? 'unhealthy' : 'ok',
        required: true,
        durationMs: 1,
        detail: 'SELECT 1 succeeded',
      },
    ],
  };
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: HealthService, useValue: { check: async () => health } }],
  }).compile();
  return module.get(HealthController);
}

describe('HealthController', () => {
  it('returns 200 and the healthy contract when every dependency is up', async () => {
    const response = fakeResponse();
    const result = await (await controllerFor('ok')).getHealth(response);
    expect(result.service).toBe('jkannel-backend');
    expect(result.status).toBe('ok');
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    expect(response.statusCode).toBe(200);
  });

  it('stays 200 when degraded so the load balancer keeps the instance', async () => {
    const response = fakeResponse();
    const result = await (await controllerFor('degraded')).getHealth(response);
    expect(result.status).toBe('degraded');
    expect(response.statusCode).toBe(200);
  });

  it('returns 503 with the dependency detail when unhealthy', async () => {
    const response = fakeResponse();
    const result = await (await controllerFor('unhealthy')).getHealth(response);
    expect(response.statusCode).toBe(503);
    // The body still reaches the client (passthrough), so an operator can see why.
    expect(result.dependencies[0]).toMatchObject({ name: 'postgres', status: 'unhealthy' });
  });
});
