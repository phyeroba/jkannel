import { BadRequestException } from '@nestjs/common';
import { LogBufferService } from './log-buffer';
import { LogsController } from './logs.controller';

function controllerWith() {
  const buffer = new LogBufferService(50);
  for (let index = 0; index < 3; index += 1)
    buffer.push({
      timestamp: `2026-08-01T00:00:0${index}.000Z`,
      level: index === 2 ? 'error' : 'info',
      message: `line-${index}`,
      correlationId: index === 0 ? 'corr-1' : 'corr-2',
      route: '/api/v1/alerts',
      tenantId: '1',
    });
  return { controller: new LogsController(buffer), buffer };
}

describe('LogsController', () => {
  it('filters by correlation id', () => {
    const { controller } = controllerWith();
    const result = controller.search({ correlationId: 'corr-1' });
    expect(result.matched).toBe(1);
    expect(result.items[0].message).toBe('line-0');
  });

  it('filters by level and honours the limit', () => {
    const { controller } = controllerWith();
    expect(controller.search({ level: 'error' }).matched).toBe(1);
    expect(controller.search({ limit: '1' }).items).toHaveLength(1);
  });

  it('rejects an unknown level, a bad timestamp and a bad limit', () => {
    const { controller } = controllerWith();
    expect(() => controller.search({ level: 'shouty' })).toThrow(BadRequestException);
    expect(() => controller.search({ since: 'yesterday' })).toThrow(BadRequestException);
    expect(() => controller.search({ limit: '-4' })).toThrow(BadRequestException);
  });

  it('states the honest limits of the buffer in every response', () => {
    const { controller } = controllerWith();
    const result = controller.search({});
    expect(result.durable).toBe(false);
    expect(result.scope).toBe('process');
    expect(result.notice).toContain('not durable');
    const stats = controller.stats() as Record<string, unknown>;
    expect(stats.items).toBeUndefined();
    expect(stats.capacity).toBe(50);
    expect(stats.stored).toBe(3);
  });
});
