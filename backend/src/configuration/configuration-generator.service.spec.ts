import { ConfigurationGeneratorService } from './configuration-generator.service';
describe('ConfigurationGeneratorService', () => {
  const service = new ConfigurationGeneratorService();
  const model = {
    adminPort: 13000,
    smsboxPort: 13001,
    adminSecretRef: 'secret://kannel/admin',
    logLevel: 1 as const,
    sqlbox: {
      enabled: true,
      host: 'postgres',
      port: 5432,
      database: 'jkannel',
      usernameEnv: 'POSTGRES_USER',
      passwordEnv: 'POSTGRES_PASSWORD',
    },
    smsc: [{ id: 'test', type: 'fake' as const, enabled: true }],
  };
  it('is deterministic and excludes secret values', () => {
    expect(service.generate(model)).toEqual(service.generate(model));
    expect(service.generate(model).content).not.toContain('secret://');
    expect(service.generate(model).content).toContain('group = pgsql-connection');
    expect(service.generate(model).content).toContain('password = ${POSTGRES_PASSWORD}');
  });
  it('rejects duplicate ports and ids', () =>
    expect(
      service.validate({ ...model, smsboxPort: 13000, smsc: [...model.smsc, ...model.smsc] }),
    ).toHaveLength(2));
});
