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
});
