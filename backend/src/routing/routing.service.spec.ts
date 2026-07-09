import { RoutingService } from './routing.service';
describe('RoutingService', () => {
  const service = new RoutingService();
  const context = {
    messageId: 'm1',
    destination: '+256700000000',
    now: new Date(0),
    healthySmscIds: new Set(['backup']),
  };
  it('deterministically selects a healthy fallback', () =>
    expect(
      service.evaluate(context, [
        {
          id: 'ug',
          priority: 10,
          enabled: true,
          destinationPrefix: '+256',
          targetSmscId: 'primary',
          fallbackSmscId: 'backup',
        },
      ]).smscId,
    ).toBe('backup'));
  it('fails closed without an eligible route', () =>
    expect(() => service.evaluate(context, [])).toThrow('No eligible route'));
});
