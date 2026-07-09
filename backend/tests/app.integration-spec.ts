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
  it('wires health through AppModule', () =>
    expect(app.get(HealthController).getHealth().status).toBe('ok'));
});
