import { BadRequestException } from '@nestjs/common';
import { LogBufferService } from './log-buffer';
import { LogsController } from './logs.controller';
import { DurableLogService } from './durable-log.service';

/**
 * A durable store that is present but holds nothing, which is the state of a
 * fresh deployment and the one most likely to mislead: a caller must be able to
 * tell "stored nothing" from "does not store".
 */
const emptyDurable = (available = true) =>
  ({
    query: async () => ({ items: [], matched: 0 }),
    stats: async () => ({
      durable: available,
      levels: ['warn', 'error', 'fatal'],
      stored: 0,
      oldest: null,
      queued: 0,
      written: 0,
      dropped: 0,
      lastError: null,
      retentionDays: 30,
      ringBuffer: { stored: 0, capacity: 50, dropped: 0 },
    }),
  }) as unknown as DurableLogService;

function controllerWith(durable: DurableLogService = emptyDurable()) {
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
  return { controller: new LogsController(buffer, durable), buffer };
}

describe('LogsController', () => {
  it('filters by correlation id', async () => {
    const { controller } = controllerWith();
    const result = (await controller.search({ correlationId: 'corr-1' })) as any;
    expect(result.matched).toBe(1);
    expect(result.items[0].message).toBe('line-0');
  });

  it('filters by level and honours the limit', async () => {
    const { controller } = controllerWith();
    expect(((await controller.search({ level: 'error' })) as any).matched).toBe(1);
    expect(((await controller.search({ limit: '1' })) as any).items).toHaveLength(1);
  });

  it('rejects an unknown level, a bad timestamp and a bad limit', async () => {
    const { controller } = controllerWith();
    await expect(controller.search({ level: 'shouty' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.search({ since: 'yesterday' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.search({ limit: '-4' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('states the honest limits of the buffer in every response', async () => {
    const { controller } = controllerWith();
    const result = (await controller.search({})) as any;
    expect(result.durable).toBe(false);
    expect(result.scope).toBe('process');
    expect(result.notice).toContain('not durable');
    const stats = (await controller.stats()) as Record<string, any>;
    expect(stats.items).toBeUndefined();
    expect(stats.capacity).toBe(50);
    expect(stats.stored).toBe(3);
    // Both sources are described by one call, so an operator does not have to
    // know the durable store exists to discover it.
    expect(stats.durableStore.durable).toBe(true);
  });

  it('reads the DURABLE store only when asked, and says what it does not hold', async () => {
    /*
     * The two sources answer different questions - the ring buffer has every
     * level for one process, the table has warn-and-above for the deployment -
     * so switching silently would be worse than either. An operator searching
     * for an info line in the durable store must be told it was never a
     * candidate, rather than concluding the event did not happen.
     */
    const { controller } = controllerWith();
    const result = (await controller.search({ source: 'durable' })) as any;
    expect(result.source).toBe('log_entries');
    expect(result.scope).toBe('deployment');
    expect(result.durable).toBe(true);
    expect(result.levels).toEqual(['warn', 'error', 'fatal']);
    expect(result.notice).toContain('Info and debug are not here');
    // The ring buffer's three lines must NOT leak into a durable answer.
    expect(result.items).toHaveLength(0);
  });

  it('says plainly when the deployment has no durable table at all', async () => {
    const { controller } = controllerWith(emptyDurable(false));
    const result = (await controller.search({ source: 'durable' })) as any;
    expect(result.durable).toBe(false);
    expect(result.notice).toContain('not present in this deployment');
  });
});
