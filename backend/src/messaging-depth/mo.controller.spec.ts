import { BadRequestException } from '@nestjs/common';
import { MoController } from './mo.controller';

const request: any = { principal: { tenantId: '7', userId: 'operator-1' } };
const actor = { tenantId: '7', userId: 'operator-1' };
const ID = '11111111-1111-4111-8111-111111111111';

describe('MoController', () => {
  const rules: any = {
    list: jest.fn(async () => ({ items: [] })),
    get: jest.fn(async () => ({ id: ID })),
    create: jest.fn(async () => ({ id: ID })),
    update: jest.fn(async () => ({ id: ID })),
    remove: jest.fn(async () => undefined),
    preview: jest.fn(async () => ({ matches: [] })),
    addDestination: jest.fn(async () => ({ id: ID })),
    removeDestination: jest.fn(async () => undefined),
  };
  const inbound: any = {
    ingest: jest.fn(async () => ({ moMessageId: ID })),
    status: jest.fn(async () => ({ polling_enabled: false })),
    sweep: jest.fn(async () => ({ ingested: 0 })),
    setPolling: jest.fn(async () => ({ polling_enabled: true })),
    listMessages: jest.fn(async () => ({ items: [] })),
    getMessage: jest.fn(async () => ({ id: ID })),
    listDeliveries: jest.fn(async () => ({ items: [] })),
    retryDelivery: jest.fn(async () => ({ id: ID })),
  };
  const controller = new MoController(rules, inbound);
  beforeEach(() => jest.clearAllMocks());

  it('passes the grid query straight through on every grid', async () => {
    await controller.listRules(request, { 'filter.enabled': 'true', sort: 'priority' });
    await controller.listMessages(request, { 'filter.status': 'no_match', cursor: 'abc' });
    await controller.listDeliveries(request, { 'filter.status': 'dead_letter' });
    expect(rules.list).toHaveBeenCalledWith(actor, {
      'filter.enabled': 'true',
      sort: 'priority',
    });
    expect(inbound.listMessages).toHaveBeenCalledWith(actor, {
      'filter.status': 'no_match',
      cursor: 'abc',
    });
    expect(inbound.listDeliveries).toHaveBeenCalledWith(actor, { 'filter.status': 'dead_letter' });
  });

  it('validates ids rather than passing junk to the database', async () => {
    expect(() => controller.getRule(request, 'nope')).toThrow(BadRequestException);
    await expect(controller.removeRule(request, 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(() => controller.retry(request, 'nope')).toThrow(BadRequestException);
    await expect(controller.removeDestination(request, ID, 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires a sender and a receiver on ingest — a stub row helps nobody', () => {
    expect(() => controller.ingest(request, { receiver: '8080', text: 'x' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.ingest(request, { sender: '2567001', text: 'x' })).toThrow(
      BadRequestException,
    );
    expect(inbound.ingest).not.toHaveBeenCalled();
  });

  it('accepts either `text` or `body` for the message content', async () => {
    await controller.ingest(request, { sender: 'S', receiver: '8080', body: 'hello' });
    expect(inbound.ingest).toHaveBeenCalledWith(actor, expect.objectContaining({ text: 'hello' }));
  });

  it('takes the idempotency handle from externalRef or messageId', async () => {
    await controller.ingest(request, {
      sender: 'S',
      receiver: '8080',
      text: 'x',
      messageId: 'kannel-42',
    });
    expect(inbound.ingest).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ externalRef: 'kannel-42' }),
    );
  });

  it('rejects an unparseable receivedAt rather than silently stamping "now"', () => {
    expect(() =>
      controller.ingest(request, {
        sender: 'S',
        receiver: '8080',
        text: 'x',
        receivedAt: 'yesterday',
      }),
    ).toThrow(BadRequestException);
  });

  it('requires an explicit boolean to change the polling switch', () => {
    expect(() => controller.polling(request, {})).toThrow(BadRequestException);
    expect(() => controller.polling(request, { enabled: 'yes' })).toThrow(BadRequestException);
  });

  it('turns polling on with the requested interval', async () => {
    await controller.polling(request, { enabled: true, pollIntervalSeconds: 60 });
    expect(inbound.setPolling).toHaveBeenCalledWith(actor, true, 60);
  });
});
