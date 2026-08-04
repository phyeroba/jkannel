import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationGeneratorService } from './configuration-generator.service';
import { MissingSecretError, SecretResolver } from './secret-resolver.service';
import { ConfigurationDeploymentService } from './configuration-deployment.service';
import { MINIMAL_GATEWAY, MULTI_SMSC, SMPP_CARRIER } from './__fixtures__/fixtures';

const golden = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', `${name}.conf`), 'utf8').replace(/\r\n/g, '\n');

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

  describe('golden files', () => {
    // Each case renders a fixture and compares byte for byte with a committed
    // .conf, so any emitter change is reviewed as a diff of real engine syntax.
    it.each([
      ['minimal-gateway', MINIMAL_GATEWAY],
      ['smpp-carrier', SMPP_CARRIER],
      ['multi-smsc', MULTI_SMSC],
    ])('renders %s exactly', (name, fixture) => {
      expect(service.generate(fixture).content).toBe(golden(name));
    });

    it('renders a complete working gateway, not just core + smsc', () => {
      const content = service.generate(MINIMAL_GATEWAY).content;
      for (const group of [
        'group = core',
        'group = smsc',
        'group = smsbox',
        'group = sendsms-user',
        'group = sms-service',
      ])
        expect(content).toContain(group);
      // Shapes match the working runtime/kamex/kamex.conf this stack runs.
      expect(content).toContain('bearerbox-host = kamex-bearerbox');
      expect(content).toContain('sendsms-port = 13013');
      expect(content).toContain('keyword = default');
    });

    it('emits every SMPP bind directive a real carrier needs', () => {
      const content = service.generate(SMPP_CARRIER).content;
      for (const directive of [
        'smsc = smpp',
        'smsc-id = carrier-a',
        'host = smpp.carrier-a.example',
        'port = 2775',
        'smsc-username = jkannel_prod',
        'smsc-password = ${KAMEX_CARRIER_A_PASSWORD}',
        'system-type = VMA',
        'interface-version = 34',
        'transceiver-mode = 1',
        'source-addr-ton = 5',
        'dest-addr-npi = 1',
        'max-pending-submits = 20',
        'throughput = 50',
        'enquire-link-interval = 30',
        'reconnect-delay = 10',
        'wait-ack = 60',
        'use-ssl = true',
      ])
        expect(content).toContain(directive);
      expect(content).toContain('group = dlr-db');
      expect(content).toContain('dlr-storage = pgsql');
    });

    it('omits disabled SMSCs and the secrets only they needed', () => {
      const generated = service.generate(MULTI_SMSC);
      expect(generated.content).not.toContain('retired-carrier');
      expect(generated.requiredSecrets).not.toContain('KAMEX_RETIRED_PASSWORD');
      expect(generated.requiredSecrets).toContain('KAMEX_ZETA_PASSWORD');
    });

    it('selects directives per adapter type', () => {
      const content = service.generate(MULTI_SMSC).content;
      const http = content.split('group = smsc').find((part) => part.includes('smsc = http'))!;
      // SMPP-only directives must not appear inside an HTTP smsc group.
      expect(http).toContain('send-url = "https://sms.provider.example/submit"');
      expect(http).not.toContain('transceiver-mode');
      expect(http).not.toContain('max-pending-submits');
      const fake = service
        .generate(MINIMAL_GATEWAY)
        .content.split('group = smsc')
        .find((part) => part.includes('smsc = fake'))!;
      expect(fake).not.toContain('smsc-username');
    });

    it('never writes a credential value into the rendered file', () => {
      const resolver = new SecretResolver({
        KAMEX_CARRIER_A_PASSWORD: 'the-real-carrier-password',
        KAMEX_ADMIN_PASSWORD: 'the-real-admin-password',
        KAMEX_STATUS_PASSWORD: 'x',
        KAMEX_SENDSMS_PASSWORD: 'y',
      });
      const content = new ConfigurationGeneratorService(resolver).generate(SMPP_CARRIER).content;
      expect(content).not.toContain('the-real-carrier-password');
      expect(content).not.toContain('the-real-admin-password');
      expect(content).not.toContain('secret://');
      expect(content).toContain('${KAMEX_CARRIER_A_PASSWORD}');
    });
  });

  describe('secret handling', () => {
    it('reports the environment variables the rendered file depends on', () => {
      expect(service.generate(MINIMAL_GATEWAY).requiredSecrets).toEqual([
        'KAMEX_ADMIN_PASSWORD',
        'KAMEX_SENDSMS_PASSWORD',
        'KAMEX_STATUS_PASSWORD',
      ]);
    });

    it('fails loudly in strict mode when a referenced secret is absent', () => {
      const strict = new ConfigurationGeneratorService(
        new SecretResolver({ KAMEX_ADMIN_PASSWORD: 'present' }),
      );
      expect(() => strict.generate(MINIMAL_GATEWAY, 'kamex', { requireSecrets: true })).toThrow(
        MissingSecretError,
      );
      try {
        strict.generate(MINIMAL_GATEWAY, 'kamex', { requireSecrets: true });
      } catch (error) {
        expect((error as MissingSecretError).envNames).toEqual([
          'KAMEX_STATUS_PASSWORD',
          'KAMEX_SENDSMS_PASSWORD',
        ]);
        expect((error as MissingSecretError).message).not.toContain('present');
      }
    });

    it('renders without the secrets present by default (the engine container owns them)', () => {
      const detached = new ConfigurationGeneratorService(new SecretResolver({}));
      expect(() => detached.generate(MINIMAL_GATEWAY)).not.toThrow();
    });
  });

  describe('validation', () => {
    it('rejects out-of-range SMPP attributes with field-named errors', () => {
      const errors = service.validate({
        ...MINIMAL_GATEWAY,
        smsc: [
          {
            id: 'bad',
            type: 'smpp',
            host: 'h',
            port: 1,
            enabled: true,
            bindMode: 'sideways' as never,
            interfaceVersion: 99,
            sourceAddrTon: 900,
            windowSize: 0,
            keepaliveSeconds: -1,
          },
        ],
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('bindMode'),
          expect.stringContaining('interfaceVersion'),
          expect.stringContaining('sourceAddrTon'),
          expect.stringContaining('windowSize'),
          expect.stringContaining('keepaliveSeconds'),
        ]),
      );
    });

    it('requires an smsbox group when sendsms-users or sms-services are present', () => {
      const { smsbox: _smsbox, ...withoutSmsbox } = MINIMAL_GATEWAY;
      expect(service.validate(withoutSmsbox)).toContain(
        'sendsms-user and sms-service groups require an smsbox group',
      );
    });

    it('requires exactly one default sms-service', () => {
      expect(
        service.validate({
          ...MINIMAL_GATEWAY,
          smsServices: [{ keyword: 'mo', getUrl: 'http://x' }],
        }),
      ).toContain('sms-service list must contain exactly one service with keyword "default"');
    });

    it('refuses to fabricate an AT modem group it cannot model', () => {
      expect(
        service
          .validate({
            ...MINIMAL_GATEWAY,
            smsc: [{ id: 'modem', type: 'at', host: '/dev/ttyUSB0', port: 1, enabled: true }],
          })
          .join('; '),
      ).toContain('AT modem SMSCs cannot be rendered');
    });

    it('still refuses to render Kannel syntax', () =>
      expect(() => service.generate(MINIMAL_GATEWAY, 'kannel')).toThrow(/not implemented/i));
  });

  describe('native validator (skipped when kamex-validator is unreachable)', () => {
    it('accepts the generated minimal gateway', async () => {
      if (!process.env.KAMEX_VALIDATOR_URL || !process.env.KAMEX_VALIDATOR_TOKEN) {
        // Unit tests must not require the validator container; the same
        // assertion runs in environments where it is configured.
        expect(true).toBe(true);
        return;
      }
      const deployment = new ConfigurationDeploymentService();
      await expect(
        deployment.validateNative(service.generate(MINIMAL_GATEWAY).content),
      ).resolves.toMatchObject({ valid: true });
    });
  });
});
