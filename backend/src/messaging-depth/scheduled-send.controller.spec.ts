import { BadRequestException } from '@nestjs/common';
import { ScheduledSendController } from './scheduled-send.controller';

const request: any = { principal: { tenantId: '7', userId: 'operator-1' } };
const actor = { tenantId: '7', userId: 'operator-1' };
const ID = '11111111-1111-4111-8111-111111111111';

describe('ScheduledSendController', () => {
  const scheduling: any = {
    list: jest.fn(async () => ({ items: [] })),
    get: jest.fn(async () => ({ id: ID })),
    cancel: jest.fn(async () => ({ id: ID, status: 'cancelled' })),
    reschedule: jest.fn(async () => ({ id: ID, status: 'pending' })),
  };
  const controller = new ScheduledSendController(scheduling);
  beforeEach(() => jest.clearAllMocks());

  it('passes the grid query straight through, so the shared vocabulary works unchanged', async () => {
    await controller.list(request, { 'filter.status': 'pending', sort: 'scheduledAt' });
    expect(scheduling.list).toHaveBeenCalledWith(actor, {
      'filter.status': 'pending',
      sort: 'scheduledAt',
    });
  });

  it('validates the id on every route rather than passing junk to the database', () => {
    expect(() => controller.get(request, 'not-a-uuid')).toThrow(BadRequestException);
    expect(() => controller.cancel(request, 'not-a-uuid', {})).toThrow(BadRequestException);
    expect(() =>
      controller.reschedule(request, 'not-a-uuid', { scheduledAt: '2030-01-01T09:00:00Z' }),
    ).toThrow(BadRequestException);
  });

  it('requires scheduledAt on a reschedule instead of silently doing nothing', () => {
    expect(() => controller.reschedule(request, ID, {})).toThrow(BadRequestException);
    expect(() => controller.reschedule(request, ID, { scheduledAt: '' })).toThrow(
      BadRequestException,
    );
    expect(scheduling.reschedule).not.toHaveBeenCalled();
  });

  it('delegates cancel and reschedule with the operator and the id', async () => {
    await controller.cancel(request, ID, { reason: 'wrong hour' });
    await controller.reschedule(request, ID, { scheduledAt: '2030-01-01T09:00:00Z' });
    expect(scheduling.cancel).toHaveBeenCalledWith(actor, ID, 'wrong hour');
    expect(scheduling.reschedule).toHaveBeenCalledWith(actor, ID, '2030-01-01T09:00:00Z');
  });

  /**
   * The console must be able to show the real ceiling. Hard-coding "2 hours" in
   * a UI while the server runs something else is how a documented policy
   * quietly becomes a lie.
   */
  it('reports the deployment’s own staleness ceiling', () => {
    const previous = process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
    process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = '45';
    try {
      expect(controller.policy()).toMatchObject({
        maxLatenessMinutes: 45,
        configuredBy: 'SCHEDULED_SEND_MAX_LATENESS_MINUTES',
      });
    } finally {
      if (previous === undefined) delete process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
      else process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = previous;
    }
  });

  it('defaults to two hours when nothing is configured', () => {
    const previous = process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
    delete process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
    try {
      expect(controller.policy().maxLatenessMinutes).toBe(120);
    } finally {
      if (previous !== undefined) process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = previous;
    }
  });
});
