import { BadRequestException } from '@nestjs/common';
import { MessageOperationsController } from './message-operations.controller';

const request: any = { principal: { tenantId: '1', userId: 'u1' } };

describe('MessageOperationsController', () => {
  it('forwards a replay to the service with the actor and id', () => {
    const operations: any = { replay: jest.fn(() => Promise.resolve({ action: 'replayed' })) };
    const controller = new MessageOperationsController(operations);
    void controller.replay(request, '42');
    expect(operations.replay).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' }, '42');
  });

  it('rejects an empty id', () => {
    const controller = new MessageOperationsController({} as any);
    expect(() => controller.replay(request, '   ')).toThrow(BadRequestException);
  });

  it('parses clone overrides (bare body and overrides envelope both accepted)', () => {
    const operations: any = { clone: jest.fn(() => Promise.resolve({})) };
    const controller = new MessageOperationsController(operations);
    void controller.clone(request, '42', { receiver: '+256700000000', text: 'hi' });
    expect(operations.clone).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' }, '42', {
      receiver: '+256700000000',
      sender: undefined,
      text: 'hi',
    });
    void controller.clone(request, '42', { overrides: { sender: 'BRAND' } });
    expect(operations.clone).toHaveBeenLastCalledWith({ tenantId: '1', userId: 'u1' }, '42', {
      receiver: undefined,
      sender: 'BRAND',
      text: undefined,
    });
  });

  it('rejects a blank override value', () => {
    const controller = new MessageOperationsController({ clone: jest.fn() } as any);
    expect(() => controller.clone(request, '42', { receiver: '   ' })).toThrow(BadRequestException);
  });

  it('delegates requeue and source preview', () => {
    const operations: any = {
      requeue: jest.fn(() => Promise.resolve({})),
      resolve: jest.fn(() => Promise.resolve({})),
    };
    const controller = new MessageOperationsController(operations);
    void controller.requeue(request, '7');
    void controller.source(request, '7');
    expect(operations.requeue).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' }, '7');
    expect(operations.resolve).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' }, '7');
  });
});
