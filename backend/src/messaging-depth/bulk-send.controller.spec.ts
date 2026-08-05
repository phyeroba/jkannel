import { BadRequestException } from '@nestjs/common';
import { BulkSendController } from './bulk-send.controller';

const request: any = { principal: { tenantId: '1', userId: 'u1' } };
const validId = '11111111-1111-4111-8111-111111111111';

describe('BulkSendController', () => {
  const service: any = {
    createJob: jest.fn(() => Promise.resolve({ id: validId })),
    listJobs: jest.fn(() => Promise.resolve({ items: [] })),
    getJob: jest.fn(() => Promise.resolve({ id: validId })),
    listRecipients: jest.fn(() => Promise.resolve({ items: [] })),
  };
  /**
   * Creation goes through ScheduledSendService, which decides between "create
   * and dispatch now" and "hold until scheduledAt". The controller's job is
   * only to validate and normalise, so that is all this spec asserts.
   */
  const scheduling: any = { submitBulk: jest.fn(() => Promise.resolve({ id: validId })) };
  beforeEach(() => jest.clearAllMocks());

  it('requires a name, smscId, message and recipients', () => {
    const controller = new BulkSendController(service, scheduling);
    expect(() =>
      controller.create(request, { smscId: 's', message: 'm', recipients: ['+100'] }),
    ).toThrow(BadRequestException);
    expect(scheduling.submitBulk).not.toHaveBeenCalled();
  });

  it('rejects a non-array recipients value', () => {
    const controller = new BulkSendController(service, scheduling);
    expect(() =>
      controller.create(request, { name: 'c', smscId: 's', message: 'm', recipients: 'nope' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a recipient that is not an E.164-like address', () => {
    const controller = new BulkSendController(service, scheduling);
    expect(() =>
      controller.create(request, {
        name: 'c',
        smscId: 's',
        message: 'm',
        recipients: ['+256700000000', 'not-a-number'],
      }),
    ).toThrow(BadRequestException);
  });

  it('normalizes a valid create into actor + input', async () => {
    const controller = new BulkSendController(service, scheduling);
    await controller.create(request, {
      name: '  Campaign  ',
      smscId: '  carrier-a  ',
      message: '  hi  ',
      recipients: [' +256700000000 ', '+256711111111'],
    });
    expect(scheduling.submitBulk).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      {
        name: 'Campaign',
        smscId: 'carrier-a',
        message: 'hi',
        recipients: ['+256700000000', '+256711111111'],
        sender: undefined,
        customerId: undefined,
        // null, not 0: a campaign that expressed no priority must not be
        // demoted to the bulk level, which is a real and lower SMPP value.
        priority: null,
        // An unscheduled campaign still carries an explicit empty schedule, so
        // the service never has to distinguish "not asked for" from "absent".
        schedule: { scheduledAtMs: null, validityMinutes: null },
      },
    );
  });

  it('passes a stated campaign priority through, and rejects an out-of-range one', async () => {
    const controller = new BulkSendController(service, scheduling);
    await controller.create(request, {
      name: 'Campaign',
      message: 'hi',
      recipients: ['+256700000000'],
      priority: 0,
    });
    expect(scheduling.submitBulk).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ priority: 0 }),
    );

    expect(() =>
      controller.create(request, {
        name: 'Campaign',
        message: 'hi',
        recipients: ['+256700000000'],
        priority: 9,
      }),
    ).toThrow(BadRequestException);
  });

  it('validates the job id on read endpoints', () => {
    const controller = new BulkSendController(service, scheduling);
    expect(() => controller.get(request, 'not-a-uuid')).toThrow(BadRequestException);
    expect(() => controller.recipients(request, 'not-a-uuid', {})).toThrow(BadRequestException);
  });

  it('delegates list and detail to the service', async () => {
    const controller = new BulkSendController(service, scheduling);
    await controller.list(request, {});
    await controller.get(request, validId);
    await controller.recipients(request, validId, {});
    expect(service.listJobs).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' }, {});
    expect(service.getJob).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' }, validId);
    expect(service.listRecipients).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      validId,
      {},
    );
  });
});
