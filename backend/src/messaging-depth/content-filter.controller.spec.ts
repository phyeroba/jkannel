import { BadRequestException } from '@nestjs/common';
import { ContentFilterController } from './content-filter.controller';

const request: any = { principal: { tenantId: '7', userId: 'operator-1' } };
const actor = { tenantId: '7', userId: 'operator-1' };
const ID = '11111111-1111-4111-8111-111111111111';

describe('ContentFilterController', () => {
  const rules: any = {
    list: jest.fn(async () => ({ items: [] })),
    get: jest.fn(async () => ({ id: ID })),
    create: jest.fn(async () => ({ id: ID })),
    update: jest.fn(async () => ({ id: ID })),
    remove: jest.fn(async () => undefined),
    preview: jest.fn(async () => ({ outcome: 'allow' })),
    policy: jest.fn(() => ({ precedence: 'first_match_wins' })),
  };
  const controller = new ContentFilterController(rules);
  beforeEach(() => jest.clearAllMocks());

  it('passes the grid query straight through, so the shared vocabulary works unchanged', async () => {
    await controller.list(request, {
      'filter.action': 'block',
      sort: 'priority',
      fields: 'id,name',
    });
    expect(rules.list).toHaveBeenCalledWith(actor, {
      'filter.action': 'block',
      sort: 'priority',
      fields: 'id,name',
    });
  });

  it('validates the id on every route rather than passing junk to the database', async () => {
    expect(() => controller.get(request, 'not-a-uuid')).toThrow(BadRequestException);
    expect(() => controller.update(request, 'not-a-uuid', {})).toThrow(BadRequestException);
    await expect(controller.remove(request, 'not-a-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires a candidate body on preview: an empty preview would always say "allowed"', () => {
    expect(() => controller.preview(request, { sender: 'S' })).toThrow(BadRequestException);
    expect(rules.preview).not.toHaveBeenCalled();
  });

  it('forwards a preview with the carrier and customer the caller supplied', async () => {
    await controller.preview(request, {
      sender: 'JKANNEL',
      recipient: '+256700000000',
      text: 'cheap loan',
      smscId: 'mtn-ug',
      customerId: ID,
    });
    expect(rules.preview).toHaveBeenCalledWith(actor, {
      sender: 'JKANNEL',
      recipient: '+256700000000',
      text: 'cheap loan',
      smscId: 'mtn-ug',
      customerId: ID,
    });
  });

  it('sends ONLY the supplied fields on a PATCH, so an omitted field is not reset', async () => {
    await controller.update(request, ID, { enabled: false });
    expect(rules.update).toHaveBeenCalledWith(actor, ID, { enabled: false });
  });

  it('rejects a non-boolean enabled instead of coercing it to true', () => {
    expect(() => controller.update(request, ID, { enabled: 'yes' })).toThrow(BadRequestException);
  });

  it('rejects an unparseable expiry rather than storing a rule that never expires', () => {
    expect(() =>
      controller.create(request, {
        name: 'r',
        matchField: 'body',
        matchType: 'substring',
        pattern: 'x',
        action: 'block',
        expiresAt: 'tomorrow-ish',
      }),
    ).toThrow(BadRequestException);
  });

  it('exposes the precedence policy for a console to render', () => {
    expect(controller.policy()).toMatchObject({ precedence: 'first_match_wins' });
  });
});
