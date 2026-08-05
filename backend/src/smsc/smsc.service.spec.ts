import { SmscService } from './smsc.service';
describe('SmscService', () => {
  const service = new SmscService();
  it('accepts a secret-referenced SMPP definition', () =>
    expect(
      service.validate({
        id: 'primary',
        name: 'Primary',
        type: 'smpp',
        host: 'smsc.local',
        port: 2775,
        credentialSecretRef: 'secret://smsc/primary',
        tps: 100,
        enabled: true,
      }),
    ).toEqual([]));
  it('rejects plaintext credentials and missing endpoints', () =>
    expect(
      service.validate({
        id: 'bad',
        name: 'Bad',
        type: 'smpp',
        credentialSecretRef: 'password',
        tps: 1,
        enabled: true,
      }),
    ).toHaveLength(2));

  describe('connection resilience attributes (migration 041)', () => {
    const base = {
      id: 'primary',
      name: 'Primary',
      type: 'smpp' as const,
      host: 'smsc.local',
      port: 2775,
      tps: 100,
      enabled: true,
    };

    it('accepts parallel binds and declarative routing on an SMPP link', () =>
      expect(
        service.validate({
          ...base,
          connectionCount: 3,
          connectionTimeoutSeconds: 120,
          waitAckExpireAction: 1,
          retryOnAuthFailure: true,
          preferredSmscIds: ['primary'],
          deniedPrefixes: ['1900'],
        }),
      ).toEqual([]));

    it('rejects parallel binds on an adapter that listens on a local port', () =>
      expect(
        service.validate({ ...base, type: 'fake', host: undefined, connectionCount: 2 }),
      ).toContain('connectionCount above 1 is only supported for SMPP links'));

    it('rejects out-of-range counts and an invalid wait-ack-expire action', () =>
      expect(
        service.validate({ ...base, connectionCount: 0, waitAckExpireAction: 5 }),
      ).toHaveLength(2));

    it('rejects routing entries containing the engine list separator', () =>
      expect(service.validate({ ...base, preferredSmscIds: ['a;b'] })).toEqual([
        'preferredSmscIds entries may not contain ";", which separates values in the engine',
      ]));

    it('rejects an allow list and a deny list together, which the engine ignores', () =>
      expect(service.validate({ ...base, allowedSmscIds: ['a'], deniedSmscIds: ['b'] })).toContain(
        'allowedSmscIds and deniedSmscIds are mutually exclusive',
      ));

    it('coerces the new attributes from a request body', () => {
      expect(
        service.attributesFrom({
          connectionCount: '3',
          connectionTimeoutSeconds: 120,
          waitAckExpireAction: '1',
          retryOnAuthFailure: true,
          // A carrier's own semicolon-separated form is accepted verbatim.
          preferredPrefixes: '2567; 2569',
          allowedSmscIds: ['carrier-a'],
        }),
      ).toEqual({
        connectionCount: 3,
        connectionTimeoutSeconds: 120,
        waitAckExpireAction: 1,
        retryOnAuthFailure: true,
        preferredPrefixes: ['2567', '2569'],
        allowedSmscIds: ['carrier-a'],
      });
    });

    it('leaves absent keys out so a PATCH does not clear stored resilience settings', () =>
      expect(service.attributesFrom({ host: 'x' })).toEqual({}));
  });
});
