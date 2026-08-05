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
  beforeEach(() => jest.clearAllMocks());

  it('requires a name, smscId, message and recipients', () => {
    const controller = new BulkSendController(service);
    expect(() =>
      controller.create(request, { smscId: 's', message: 'm', recipients: ['+100'] }),
    ).toThrow(BadRequestException);
    expect(service.createJob).not.toHaveBeenCalled();
  });

  it('rejects a non-array recipients value', () => {
    const controller = new BulkSendController(service);
    expect(() =>
      controller.create(request, { name: 'c', smscId: 's', message: 'm', recipients: 'nope' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a recipient that is not an E.164-like address', () => {
    const controller = new BulkSendController(service);
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
    const controller = new BulkSendController(service);
    await controller.create(request, {
      name: '  Campaign  ',
      smscId: '  carrier-a  ',
      message: '  hi  ',
      recipients: [' +256700000000 ', '+256711111111'],
    });
    expect(service.createJob).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      {
        name: 'Campaign',
        smscId: 'carrier-a',
        message: 'hi',
        recipients: ['+256700000000', '+256711111111'],
        // An unscheduled campaign still carries an explicit empty schedule, so
        // the service never has to distinguish "not asked for" from "absent".
        schedule: { scheduledAtMs: null, validityMinutes: null },
      },
    );
  });

  it('validates the job id on read endpoints', () => {
    const controller = new BulkSendController(service);
    expect(() => controller.get(request, 'not-a-uuid')).toThrow(BadRequestException);
    expect(() => controller.recipients(request, 'not-a-uuid', {})).toThrow(BadRequestException);
  });

  it('delegates list and detail to the service', async () => {
    const controller = new BulkSendController(service);
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
