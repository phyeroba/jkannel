import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  it('returns a stable healthy contract', async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();
    const result = module.get(HealthController).getHealth();
    expect(result.service).toBe('jkannel-backend');
    expect(result.status).toBe('ok');
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});
