import { BadRequestException } from '@nestjs/common';
import { CustomersController } from './customers.controller';

const request: any = { principal: { tenantId: '7', userId: 'user-1' } };
const validId = '11111111-1111-4111-8111-111111111111';

describe('CustomersController', () => {
  const repository: any = {
    listCustomers: jest.fn(),
    getCustomer: jest.fn(),
    createCustomer: jest.fn(),
    updateCustomer: jest.fn(),
    archiveCustomer: jest.fn(),
  };
  beforeEach(() => jest.clearAllMocks());

  it('requires a name on create', () => {
    expect(() => new CustomersController(repository).create(request, {})).toThrow(
      BadRequestException,
    );
    expect(repository.createCustomer).not.toHaveBeenCalled();
  });

  it('rejects an unsupported status', () => {
    expect(() =>
      new CustomersController(repository).create(request, { name: 'Acme', status: 'frozen' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a malformed contact email', () => {
    expect(() =>
      new CustomersController(repository).create(request, {
        name: 'Acme',
        contactEmail: 'not-an-email',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a negative quota', () => {
    expect(() =>
      new CustomersController(repository).create(request, { name: 'Acme', quotaDaily: -1 }),
    ).toThrow(BadRequestException);
  });

  it('normalizes a valid create into the actor + input shape', async () => {
    repository.createCustomer.mockResolvedValue({ id: validId, name: 'Acme' });
    await new CustomersController(repository).create(request, {
      name: '  Acme  ',
      code: 'ACME-1',
      contactEmail: 'ops@acme.test',
      quotaDaily: 1000,
      rateLimitPerMin: 60,
      allowedSenderIds: ['ACME', 'ACME2'],
      notes: 'preferred partner',
    });
    expect(repository.createCustomer).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      expect.objectContaining({
        name: 'Acme',
        code: 'ACME-1',
        contactEmail: 'ops@acme.test',
        quotaDaily: 1000,
        rateLimitPerMin: 60,
        allowedSenderIds: ['ACME', 'ACME2'],
        notes: 'preferred partner',
      }),
    );
  });

  it('rejects a non-uuid id on detail', () => {
    expect(() => new CustomersController(repository).get(request, 'not-a-uuid')).toThrow(
      BadRequestException,
    );
  });

  it('archives via DELETE', async () => {
    repository.archiveCustomer.mockResolvedValue({ id: validId, status: 'archived' });
    await expect(
      new CustomersController(repository).archive(request, validId),
    ).resolves.toMatchObject({ status: 'archived' });
    expect(repository.archiveCustomer).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      validId,
    );
  });
});
