import { BadRequestException } from '@nestjs/common';
import { ConfigurationsController, RoutesController } from './console.controllers';
import { SecretResolver } from '../configuration/secret-resolver.service';

const request: any = { principal: { tenantId: '7', userId: 'user-1' } };

/**
 * Two things the console needs in order to be configurable by pointing and
 * clicking, both of which were previously knowledge an operator had to already
 * have:
 *
 *  1. WHICH ENVIRONMENT VARIABLE a `secret://` reference resolves to. The
 *     derivation lived only inside `envName()`, so somebody invented a
 *     reference, saved it, and found out which variable they needed by reading
 *     a failed bind.
 *  2. WHETHER A ROUTE IS ACTUALLY IN FORCE. The simulator resolved against
 *     every route in the table while the send path takes deployed ones only, so
 *     it confidently predicted a winner that could not win.
 */
describe('secret-check — which variable, and is it set', () => {
  const resolver = new SecretResolver({ CARRIER_MTN_UG: 's3cret', CARRIER_EMPTY: '' } as any);
  const controller = () =>
    new ConfigurationsController(
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver,
    );

  it('names the variable and reports it present', () => {
    const result: any = controller().secretCheck({ references: ['secret://carrier/mtn-ug'] });
    expect(result.references[0]).toEqual({
      reference: 'secret://carrier/mtn-ug',
      envName: 'CARRIER_MTN_UG',
      present: true,
      valid: true,
    });
  });

  it('treats an empty variable as not set, because an empty password is not a password', () => {
    const result: any = controller().secretCheck({ references: ['secret://carrier/empty'] });
    expect(result.references[0].present).toBe(false);
    expect(result.references[0].envName).toBe('CARRIER_EMPTY');
  });

  it('reports an unset variable rather than pretending the reference is bad', () => {
    const result: any = controller().secretCheck({ references: ['secret://carrier/absent'] });
    expect(result.references[0]).toMatchObject({
      envName: 'CARRIER_ABSENT',
      present: false,
      valid: true,
    });
  });

  it('answers "not valid yet" for half-typed input instead of failing the whole check', () => {
    // The form asks on every keystroke; a 400 here would blank the status for
    // every other reference in the same request.
    const result: any = controller().secretCheck({ references: ['secret://'] });
    expect(result.references[0]).toMatchObject({ valid: false, envName: null, present: false });
  });

  it('never returns the secret value itself', () => {
    const result: any = controller().secretCheck({ references: ['secret://carrier/mtn-ug'] });
    expect(JSON.stringify(result)).not.toContain('s3cret');
  });

  it('rejects a malformed request and an unbounded one', () => {
    expect(() => controller().secretCheck({ references: 'nope' })).toThrow(BadRequestException);
    expect(() => controller().secretCheck({ references: [1, 2] })).toThrow(BadRequestException);
    expect(() =>
      controller().secretCheck({ references: Array.from({ length: 33 }, () => 'secret://a/b') }),
    ).toThrow(BadRequestException);
  });
});

describe('route simulation — only deployed routes decide', () => {
  const smscId = '22222222-2222-4222-8222-222222222222';
  const routing: any = {
    evaluate: jest.fn(() => ({ smscId: null, reason: 'no route matched the destination' })),
  };

  const controllerWith = (deployed: any[], undeployed: any[]) =>
    new RoutesController(
      {
        routeSimulationData: jest.fn().mockResolvedValue({
          routes: deployed,
          undeployed,
          smscs: [{ id: smscId }],
        }),
      } as any,
      routing,
    );

  beforeEach(() => jest.clearAllMocks());

  it('does not offer an undeployed route to the resolver', async () => {
    await controllerWith(
      [],
      [
        {
          id: 'r1',
          priority: 10,
          enabled: true,
          destination_prefix: '25677',
          target_smsc_id: smscId,
          deployment_state: 'draft',
        },
      ],
    ).simulate(request, { destination: '256771234567' });
    // The rules handed to the resolver must be empty: a draft route is not in
    // force, and predicting from one is how an operator was told traffic would
    // flow moments before every message was refused.
    expect(routing.evaluate.mock.calls[0][1]).toEqual([]);
  });

  it('says a matching route exists but is not deployed, rather than just "no route matched"', async () => {
    const result: any = await controllerWith(
      [],
      [
        {
          id: 'r1',
          priority: 10,
          enabled: true,
          destination_prefix: '25677',
          target_smsc_id: smscId,
          deployment_state: 'draft',
        },
      ],
    ).simulate(request, { destination: '+256771234567' });
    expect(result.notInForce).toHaveLength(1);
    expect(result.notInForce[0]).toMatchObject({ id: 'r1', deploymentState: 'draft' });
    expect(result.notInForceNote).toContain('not deployed');
  });

  it('stays quiet when nothing undeployed matches', async () => {
    const result: any = await controllerWith(
      [],
      [
        {
          id: 'r1',
          priority: 10,
          enabled: true,
          destination_prefix: '99999',
          target_smsc_id: smscId,
          deployment_state: 'draft',
        },
      ],
    ).simulate(request, { destination: '256771234567' });
    expect(result.notInForce).toEqual([]);
    expect(result.notInForceNote).toBeUndefined();
  });
});
