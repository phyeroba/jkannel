import { BadRequestException } from '@nestjs/common';
import { QueueConsoleController } from './queue-console.controller';

const request: any = { principal: { tenantId: '7', userId: 'user-1', permissions: [] } };
const expectedActor = { tenantId: '7', userId: 'user-1' };

function makeController() {
  const queue = {
    live: jest.fn(async () => ({ binds: [] })),
    spool: jest.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    history: jest.fn(async () => ({ items: [], counts: {} })),
    reroute: jest.fn(async () => ({ requested: 1, rerouted: 1, skipped: 0 })),
    cancel: jest.fn(async () => ({ requested: 1, cancelled: 1 })),
    resend: jest.fn(async () => ({ requested: 1, resent: 1, skipped: 0 })),
    controlBind: jest.fn(async () => ({ accepted: true })),
  };
  return { queue, controller: new QueueConsoleController(queue as any) };
}

describe('QueueConsoleController', () => {
  it('passes the authenticated principal through as the actor', async () => {
    const { queue, controller } = makeController();
    await controller.live(request);
    expect(queue.live).toHaveBeenCalledWith(expectedActor);
  });

  it('parses and bounds the spool query', async () => {
    const { queue, controller } = makeController();
    await controller.spool(request, { limit: '25', cursor: '900', smscId: 'local-fake' });
    expect(queue.spool).toHaveBeenCalledWith(expectedActor, {
      limit: 25,
      cursor: 900,
      smscId: 'local-fake',
      query: undefined,
    });
    expect(() => controller.spool(request, { limit: '5000' })).toThrow(BadRequestException);
  });

  it('normalises and deduplicates sql ids', async () => {
    const { queue, controller } = makeController();
    await controller.reroute(request, { sqlIds: [3, '4', 3], targetSmscId: 'local-fake-b' });
    expect(queue.reroute).toHaveBeenCalledWith(expectedActor, {
      sqlIds: [3, 4],
      targetSmscId: 'local-fake-b',
    });
  });

  it('rejects malformed reroute payloads before touching the spool', async () => {
    const { queue, controller } = makeController();
    expect(() => controller.reroute(request, { sqlIds: [], targetSmscId: 'x' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.reroute(request, { sqlIds: [0], targetSmscId: 'x' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.reroute(request, { sqlIds: ['abc'], targetSmscId: 'x' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.reroute(request, { sqlIds: [1] })).toThrow(BadRequestException);
    expect(() =>
      controller.reroute(request, {
        sqlIds: Array.from({ length: 501 }, (_, index) => index + 1),
        targetSmscId: 'x',
      }),
    ).toThrow(BadRequestException);
    expect(queue.reroute).not.toHaveBeenCalled();
  });

  it('rejects an unknown delivery status rather than silently ignoring it', () => {
    const { controller } = makeController();
    // A typo must not quietly widen the selection to everything.
    expect(() => controller.history(request, { status: 'faield' })).toThrow(BadRequestException);
    expect(() =>
      controller.resend(request, { filter: { status: 'faield' }, targetSmscId: 'local-fake-b' }),
    ).toThrow(BadRequestException);
  });

  it('accepts delivery statuses and operator groups on the history filter', async () => {
    const { queue, controller } = makeController();
    await controller.history(request, { status: 'resendable', limit: '50' });
    expect(queue.history).toHaveBeenCalledWith(
      expectedActor,
      expect.objectContaining({ status: 'resendable', limit: 50 }),
    );
    await controller.history(request, { status: 'failed,pending' });
    expect(queue.history).toHaveBeenLastCalledWith(
      expectedActor,
      expect.objectContaining({ status: 'failed,pending' }),
    );
  });

  it('routes resend by explicit ids or by filter, but never both', async () => {
    const { queue, controller } = makeController();
    await controller.resend(request, { ids: ['1', '2'], targetSmscId: 'local-fake-b' });
    expect(queue.resend).toHaveBeenCalledWith(expectedActor, {
      ids: ['1', '2'],
      targetSmscId: 'local-fake-b',
    });

    await controller.resend(request, {
      filter: { status: 'failed' },
      targetSmscId: 'local-fake-b',
    });
    expect(queue.resend).toHaveBeenLastCalledWith(expectedActor, {
      filter: expect.objectContaining({ status: 'failed' }),
      targetSmscId: 'local-fake-b',
    });

    expect(() =>
      controller.resend(request, { ids: ['1'], filter: {}, targetSmscId: 'local-fake-b' }),
    ).toThrow(BadRequestException);
  });

  it('defaults resend to the filter path when no ids are supplied', async () => {
    const { queue, controller } = makeController();
    await controller.resend(request, { targetSmscId: 'local-fake-b' });
    expect(queue.resend).toHaveBeenCalledWith(expectedActor, {
      filter: expect.objectContaining({ limit: 500 }),
      targetSmscId: 'local-fake-b',
    });
  });

  it('validates the bind control operation', async () => {
    const { queue, controller } = makeController();
    await controller.control(request, 'local-fake', { operation: 'disable' });
    expect(queue.controlBind).toHaveBeenCalledWith(expectedActor, 'local-fake', 'disable');
    expect(() => controller.control(request, 'local-fake', { operation: 'restart' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.control(request, 'local-fake', {})).toThrow(BadRequestException);
  });
});
