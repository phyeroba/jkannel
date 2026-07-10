import { BadRequestException } from '@nestjs/common';
import { RoutingDepthController } from './routing-depth.controller';

const request: any = { principal: { tenantId: '7', userId: 'user-1' } };
const validId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

describe('RoutingDepthController', () => {
  const repository: any = {
    listRoutes: jest.fn(),
    getRoute: jest.fn(),
    createRoute: jest.fn(),
    updateRoute: jest.fn(),
    archiveRoute: jest.fn(),
    listVersions: jest.fn(),
    getVersion: jest.fn(),
  };
  const service: any = { resolve: jest.fn() };
  const controller = () => new RoutingDepthController(repository, service);
  beforeEach(() => jest.clearAllMocks());

  it('requires name/priority/targetSmscId on create', () => {
    expect(() => controller().create(request, {})).toThrow(BadRequestException);
    expect(repository.createRoute).not.toHaveBeenCalled();
  });

  it('rejects an unsupported route type', () => {
    expect(() =>
      controller().create(request, {
        name: 'r',
        priority: 1,
        targetSmscId: validId,
        routeType: 'magic',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a weighted route with no targets', () => {
    expect(() =>
      controller().create(request, {
        name: 'r',
        priority: 1,
        targetSmscId: validId,
        routeType: 'weighted',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a malformed time window', () => {
    expect(() =>
      controller().create(request, {
        name: 'r',
        priority: 1,
        targetSmscId: validId,
        windowStart: '9am',
      }),
    ).toThrow(BadRequestException);
  });

  it('normalizes a valid create into actor + input', async () => {
    repository.createRoute.mockResolvedValue({ id: validId });
    await controller().create(request, {
      name: '  Night MTN  ',
      priority: 3,
      routeType: 'weighted',
      strategy: 'load-balance',
      targetSmscId: validId,
      targets: [{ smscId: otherId, weight: 2, cost: 1.5 }],
    });
    expect(repository.createRoute).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      expect.objectContaining({
        name: 'Night MTN',
        priority: 3,
        routeType: 'weighted',
        strategy: 'load-balance',
        targets: [expect.objectContaining({ smscId: otherId, weight: 2, cost: 1.5 })],
      }),
    );
  });

  it('requires an msisdn on resolve', () => {
    expect(() => controller().resolve(request, {})).toThrow(BadRequestException);
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid in availableSmscIds on resolve', () => {
    expect(() =>
      controller().resolve(request, { msisdn: '+256700', availableSmscIds: ['nope'] }),
    ).toThrow(BadRequestException);
  });

  it('passes a well-formed resolve request through to the service', async () => {
    service.resolve.mockResolvedValue({ smscId: validId });
    await controller().resolve(request, {
      msisdn: '+256700000000',
      operator: 'MTN',
      rotation: 4,
      availableSmscIds: [validId],
    });
    expect(service.resolve).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      expect.objectContaining({ msisdn: '+256700000000', operator: 'MTN', rotation: 4 }),
    );
  });

  it('rejects a non-uuid id on detail', () => {
    expect(() => controller().get(request, 'not-a-uuid')).toThrow(BadRequestException);
  });

  it('rejects a non-positive version number', () => {
    expect(() => controller().version(request, validId, '0')).toThrow(BadRequestException);
  });
});
