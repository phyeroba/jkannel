import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationGeneratorService } from './configuration-generator.service';
import { MissingSecretError, SecretResolver } from './secret-resolver.service';
import { ConfigurationDeploymentService } from './configuration-deployment.service';
import {
  MINIMAL_GATEWAY,
  MULTI_SMSC,
  PARALLEL_CARRIER,
  SMPP_CARRIER,
} from './__fixtures__/fixtures';

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
      serviceHost: 'kamex-sqlbox',
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
      ['parallel-carrier', PARALLEL_CARRIER],
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

    it('keeps a single-connection SMSC byte-identical to the pre-041 output', () => {
      // The regression guard for the whole feature: an SMSC that does not opt
      // in must render exactly as it did before parallel binds existed, so an
      // existing deployment's checksum does not move and no drift is reported.
      const untouched = service.generate(SMPP_CARRIER).content;
      expect(untouched).toBe(golden('smpp-carrier'));
      expect(untouched).not.toContain('instances');
      // An explicit count of 1 is the same as not setting one at all.
      const explicitlyOne = service.generate({
        ...SMPP_CARRIER,
        smsc: SMPP_CARRIER.smsc.map((entry) => ({ ...entry, connectionCount: 1 })),
      }).content;
      expect(explicitlyOne).toBe(untouched);
    });

    it('opens N parallel binds under one smsc-id via the engine instances directive', () => {
      const content = service.generate(PARALLEL_CARRIER).content;
      const groups = content.split('group = smsc').filter((part) => part.includes('smsc-id ='));
      const primary = groups.find((part) => part.includes('smsc-id = carrier-primary'))!;

      // Kamex creates `instances` connections from the one group
      // (gw/bb_smscconn.c smscconn_instances), all sharing this smsc-id, and
      // load-shares across them. One group, three binds.
      expect(primary).toContain('instances = 3');
      expect(content.match(/smsc-id = carrier-primary/g)).toHaveLength(1);
      // Nothing else about the bind changes: the three connections are opened
      // from an identical directive set.
      for (const directive of [
        'smsc = smpp',
        'host = smpp.primary.example',
        'port = 2775',
        'smsc-username = jkannel_prod',
        'transceiver-mode = 1',
        'throughput = 50',
      ])
        expect(primary).toContain(directive);

      // The standby link sets connectionCount: 1 and must stay a single bind.
      const standby = groups.find((part) => part.includes('smsc-id = carrier-standby'))!;
      expect(standby).not.toContain('instances');
    });

    it('emits the reconnect and idle-detection directives a lost bind needs', () => {
      const primary = service
        .generate(PARALLEL_CARRIER)
        .content.split('group = smsc')
        .find((part) => part.includes('smsc-id = carrier-primary'))!;
      for (const directive of [
        // Keepalive: without traffic, this is what proves the bind is alive.
        'enquire-link-interval = 30',
        // Dead-but-open socket: no PDU response for this long forces a rebuild.
        'connection-timeout = 120',
        // How fast the rebuild is retried.
        'reconnect-delay = 10',
        // An unacked submit is requeued so another bind can carry it.
        'wait-ack = 60',
        'wait-ack-expire = 1',
        // Keep reconnecting through a bind rejection instead of stopping dead.
        'retry = true',
      ])
        expect(primary).toContain(directive);
    });

    it('always emits a keepalive interval when one is modelled, never leaves it implicit', () => {
      // keepalive_seconds is NOT NULL DEFAULT 30 in migration 029, so every
      // SMSC built from the database carries one. Guard the render path.
      for (const fixture of [SMPP_CARRIER, PARALLEL_CARRIER])
        for (const smsc of fixture.smsc.filter((entry) => entry.type === 'smpp' && entry.enabled))
          expect(service.generate(fixture).content).toContain(
            `enquire-link-interval = ${smsc.keepaliveSeconds}`,
          );
    });

    it('renders TLS and the routing preference/fallback directives', () => {
      const primary = service
        .generate(PARALLEL_CARRIER)
        .content.split('group = smsc')
        .find((part) => part.includes('smsc-id = carrier-primary'))!;
      expect(primary).toContain('use-ssl = true');
      // preferred-* is a ranking, not a filter: the standby link keeps carrying
      // traffic when the preferred one is unusable. That is the declarative
      // "prefer this carrier, fall back to that one".
      expect(primary).toContain('preferred-smsc-id = "carrier-primary"');
      expect(primary).toContain('preferred-prefix = "2567;2569"');
      expect(primary).toContain('denied-prefix = "1900"');
      // TLS on the pre-existing fixture must not have moved.
      expect(service.generate(SMPP_CARRIER).content).toContain('use-ssl = true');
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

    it('rejects an out-of-range or unusable parallel-bind count', () => {
      const errors = service.validate({
        ...MINIMAL_GATEWAY,
        smsc: [
          { id: 'too-many', type: 'smpp', host: 'h', port: 1, enabled: true, connectionCount: 65 },
          // fake/http adapters listen on `port`; a second instance cannot bind.
          { id: 'local-fake', type: 'fake', port: 10000, enabled: true, connectionCount: 2 },
        ],
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('connectionCount must be an integer between 1 and 64'),
          expect.stringContaining('only supported for SMPP links'),
        ]),
      );
    });

    it('rejects resilience attributes the engine would reject or ignore', () => {
      const errors = service.validate({
        ...MINIMAL_GATEWAY,
        smsc: [
          {
            id: 'bad',
            type: 'smpp',
            host: 'h',
            port: 1,
            enabled: true,
            connectionTimeoutSeconds: 99999,
            // wait-ack-expire outside 0..2 makes bearerbox panic on start-up.
            waitAckExpireAction: 7 as never,
          },
        ],
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('connectionTimeoutSeconds'),
          expect.stringContaining('waitAckExpireAction must be 0, 1 or 2'),
        ]),
      );
    });

    it('rejects routing lists that would render into something else', () => {
      const errors = service.validate({
        ...MINIMAL_GATEWAY,
        smsc: [
          {
            id: 'bad-routing',
            type: 'smpp',
            host: 'h',
            port: 1,
            enabled: true,
            // A ';' inside an entry would split it into two rules in the file.
            preferredSmscIds: ['carrier-a;carrier-b'],
            allowedPrefixes: ['  '],
            // The engine ignores denied-smsc-id whenever allowed-smsc-id is set.
            allowedSmscIds: ['carrier-a'],
            deniedSmscIds: ['carrier-b'],
          },
        ],
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('may not contain ";"'),
          expect.stringContaining('allowedPrefixes entries must be non-empty strings'),
          expect.stringContaining('cannot set both allowedSmscIds and deniedSmscIds'),
        ]),
      );
    });

    it('still refuses to render Kannel syntax', () =>
      expect(() => service.generate(MINIMAL_GATEWAY, 'kannel')).toThrow(/not implemented/i));
  });

  describe('native validator (skipped when kamex-validator is unreachable)', () => {
    // Every directive the emitter can produce must be declared for its group in
    // the engine's gwlib/cfg.def: Kamex's parser fails the whole configuration
    // load on an unknown variable rather than ignoring it. `bearerbox --test`
    // behind the validator is the only authority on that, so the resilience and
    // routing fixture is checked here too, not just the minimal gateway.
    it.each([
      ['minimal gateway', MINIMAL_GATEWAY],
      ['parallel/resilient carrier', PARALLEL_CARRIER],
    ])('accepts the generated %s', async (_name, fixture) => {
      if (!process.env.KAMEX_VALIDATOR_URL || !process.env.KAMEX_VALIDATOR_TOKEN) {
        // Unit tests must not require the validator container; the same
        // assertion runs in environments where it is configured.
        expect(true).toBe(true);
        return;
      }
      const deployment = new ConfigurationDeploymentService();
      await expect(
        deployment.validateNative(service.generate(fixture).content),
      ).resolves.toMatchObject({ valid: true });
    });
  });
});
