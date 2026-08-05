import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../security/permissions.guard';
import { DeliveryRetryController } from './delivery-retry.controller';

const request: any = { principal: { tenantId: '7', userId: 'operator-1' } };
const actor = { tenantId: '7', userId: 'operator-1' };
const ID = '11111111-1111-4111-8111-111111111111';

function makeController() {
  const retries: any = {
    listChains: jest.fn(async () => ({ items: [] })),
    listAttempts: jest.fn(async () => ({ items: [] })),
    listPolicies: jest.fn(async () => ({ items: [], defaults: {} })),
    effectivePolicy: jest.fn(async () => ({ enabled: false })),
    upsertPolicy: jest.fn(async () => ({ id: ID })),
    removePolicy: jest.fn(async () => undefined),
    getChain: jest.fn(async () => ({ id: ID })),
    status: jest.fn(async () => ({ watermark_sql_id: '0' })),
    scan: jest.fn(async () => ({ chainsOpened: 0 })),
    setPollInterval: jest.fn(async () => ({ poll_interval_seconds: 120 })),
  };
  return { controller: new DeliveryRetryController(retries), retries };
}

const permissionsOf = (method: keyof DeliveryRetryController): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, DeliveryRetryController.prototype[method] as any);

describe('DeliveryRetryController', () => {
  it('reads require messages.view and every mutation requires messages.send', () => {
    // Enabling retrying causes SMS to go out and credit to be spent, so saving a
    // policy is the same class of act as submitting a message — not a view.
    expect(permissionsOf('list')).toEqual(['messages.view']);
    expect(permissionsOf('listAttempts')).toEqual(['messages.view']);
    expect(permissionsOf('listPolicies')).toEqual(['messages.view']);
    expect(permissionsOf('effective')).toEqual(['messages.view']);
    expect(permissionsOf('get')).toEqual(['messages.view']);
    expect(permissionsOf('status')).toEqual(['messages.view']);
    expect(permissionsOf('savePolicy')).toEqual(['messages.send']);
    expect(permissionsOf('removePolicy')).toEqual(['messages.send']);
    expect(permissionsOf('scan')).toEqual(['messages.send']);
    expect(permissionsOf('pollInterval')).toEqual(['messages.send']);
  });

  it('declares its literal routes BEFORE the :id route', () => {
    // Nest matches in declaration order: `/delivery-retries/policies` would
    // otherwise be read as a chain id and answered with a 400.
    const order = Object.getOwnPropertyNames(DeliveryRetryController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        path: Reflect.getMetadata(
          PATH_METADATA,
          (DeliveryRetryController.prototype as any)[name],
        ) as string,
      }))
      .filter((entry) => typeof entry.path === 'string');
    const idIndex = order.findIndex((entry) => entry.path === ':id');
    expect(idIndex).toBeGreaterThan(-1);
    for (const literal of ['attempts', 'policies', 'policies/effective', 'status', 'scan'])
      expect(order.findIndex((entry) => entry.path === literal)).toBeLessThan(idIndex);
  });

  it('passes the grid query straight through, so the shared vocabulary works unchanged', async () => {
    const { controller, retries } = makeController();
    await controller.list(request, { 'filter.status': 'exhausted', sort: '-createdAt' });
    await controller.listAttempts(request, { 'filter.smscId': 'mtn-ug', paginate: 'cursor' });
    expect(retries.listChains).toHaveBeenCalledWith(actor, {
      'filter.status': 'exhausted',
      sort: '-createdAt',
    });
    expect(retries.listAttempts).toHaveBeenCalledWith(actor, {
      'filter.smscId': 'mtn-ug',
      paginate: 'cursor',
    });
  });

  it('validates ids rather than passing junk to the database', async () => {
    const { controller } = makeController();
    expect(() => controller.get(request, 'not-a-uuid')).toThrow(BadRequestException);
    await expect(controller.removePolicy(request, 'not-a-uuid')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('parses a policy write through the shared validator', async () => {
    const { controller, retries } = makeController();
    await controller.savePolicy(request, { scope: 'smsc', smscId: 'mtn-ug', enabled: true });
    expect(retries.upsertPolicy).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ scope: 'smsc', smscId: 'mtn-ug', enabled: true, maxAttempts: 1 }),
    );
    expect(() => controller.savePolicy(request, { scope: 'smsc' })).toThrow(BadRequestException);
  });

  it('resolves the effective policy for a bind and customer', async () => {
    const { controller, retries } = makeController();
    await controller.effective(request, { smscId: ' mtn-ug ', customerId: '' });
    expect(retries.effectivePolicy).toHaveBeenCalledWith(actor, {
      smscId: 'mtn-ug',
      customerId: null,
    });
  });

  it('requires a poll interval instead of silently doing nothing', () => {
    const { controller, retries } = makeController();
    expect(() => controller.pollInterval(request, {})).toThrow(BadRequestException);
    expect(retries.setPollInterval).not.toHaveBeenCalled();
  });
});
