import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { HealthController } from '../src/health/health.controller';

describe('application integration', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  it('wires health through AppModule', async () => {
    const response = {
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
    };
    const health = await app.get(HealthController).getHealth(response);
    expect(health.service).toBe('jkannel-backend');
    // Real probe: 'ok' with the compose dependencies up, 503 only if they are not.
    expect(response.statusCode).toBe(health.status === 'unhealthy' ? 503 : 200);
  });
});
