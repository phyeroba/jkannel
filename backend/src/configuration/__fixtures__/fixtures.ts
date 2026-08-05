import { EngineConfiguration } from '../configuration-generator.service';

/**
 * Golden-file render inputs. Each fixture pairs with a `.conf` file in this
 * directory holding the exact expected output; the spec renders the fixture and
 * compares byte for byte, so any change to the emitter shows up as a reviewable
 * diff of real engine configuration rather than a green test.
 *
 * Shapes deliberately track the working `runtime/kamex/kamex.conf` and
 * `infrastructure/kannel/kamex.conf` this deployment actually runs.
 */

/** The smallest configuration that is a *working* gateway, not just a valid file. */
export const MINIMAL_GATEWAY: EngineConfiguration = {
  adminPort: 13000,
  smsboxPort: 13001,
  adminSecretRef: 'secret://kamex/admin-password',
  statusSecretRef: 'secret://kamex/status-password',
  logLevel: 1,
  smsc: [
    { id: 'local-fake', type: 'fake', port: 10000, enabled: true },
    { id: 'local-fake-b', type: 'fake', port: 10001, enabled: true },
  ],
  smsbox: { bearerboxHost: 'kamex-bearerbox', sendsmsPort: 13013, logLevel: 1 },
  sendsmsUsers: [{ username: 'jkannel', passwordSecretRef: 'secret://kamex/sendsms-password' }],
  smsServices: [{ keyword: 'default', text: 'No service specified' }],
  dlrStorage: { type: 'internal' },
};

/** An authenticated SMPP carrier bind with the full SMSC_MANAGER_SPEC_03 attribute set. */
export const SMPP_CARRIER: EngineConfiguration = {
  adminPort: 13000,
  smsboxPort: 13001,
  adminSecretRef: 'secret://kamex/admin-password',
  logLevel: 1,
  smsc: [
    {
      id: 'carrier-a',
      type: 'smpp',
      host: 'smpp.carrier-a.example',
      port: 2775,
      enabled: true,
      username: 'jkannel_prod',
      passwordSecretRef: 'secret://kamex/carrier-a-password',
      systemType: 'VMA',
      bindMode: 'transceiver',
      interfaceVersion: 34,
      addressRange: '',
      sourceAddrTon: 5,
      sourceAddrNpi: 0,
      destAddrTon: 1,
      destAddrNpi: 1,
      windowSize: 20,
      throughput: 50,
      keepaliveSeconds: 30,
      reconnectDelaySeconds: 10,
      waitAckSeconds: 60,
      maxErrorCount: 10,
      useTls: true,
    },
  ],
  smsbox: { bearerboxHost: 'kamex-bearerbox', sendsmsPort: 13013, logLevel: 1 },
  sendsmsUsers: [
    {
      username: 'jkannel',
      passwordSecretRef: 'secret://kamex/sendsms-password',
      allowedIps: '*',
      concatenation: true,
      maxMessages: 10,
    },
  ],
  smsServices: [{ keyword: 'default', text: 'No service specified' }],
  dlrStorage: { type: 'pgsql', connectionId: 'jkannel-sqlbox', table: 'dlr' },
  sqlbox: {
    enabled: true,
    host: 'postgres',
    port: 5432,
    database: 'jkannel',
    usernameEnv: 'JKANNEL_SQLBOX_USER',
    passwordEnv: 'JKANNEL_SQLBOX_PASSWORD',
  },
};

/**
 * A carrier that permits three simultaneous binds, with the full resilience
 * set turned on: parallel connections, idle-link detection, requeue-on-ack-
 * timeout, retry through a bind rejection, and a declarative preference so this
 * link is chosen ahead of the standby carrier that follows it.
 *
 * The standby (`carrier-standby`) deliberately carries none of the new
 * attributes: it renders exactly as a pre-041 SMSC would, and it is the link
 * traffic falls back to when the preferred one is unusable.
 */
export const PARALLEL_CARRIER: EngineConfiguration = {
  adminPort: 13000,
  smsboxPort: 13001,
  adminSecretRef: 'secret://kamex/admin-password',
  logLevel: 1,
  smsc: [
    {
      id: 'carrier-primary',
      type: 'smpp',
      host: 'smpp.primary.example',
      port: 2775,
      enabled: true,
      username: 'jkannel_prod',
      passwordSecretRef: 'secret://kamex/carrier-primary-password',
      bindMode: 'transceiver',
      interfaceVersion: 34,
      windowSize: 20,
      throughput: 50,
      keepaliveSeconds: 30,
      reconnectDelaySeconds: 10,
      waitAckSeconds: 60,
      maxErrorCount: 10,
      useTls: true,
      connectionCount: 3,
      connectionTimeoutSeconds: 120,
      waitAckExpireAction: 1,
      retryOnAuthFailure: true,
      preferredSmscIds: ['carrier-primary'],
      preferredPrefixes: ['2567', '2569'],
      deniedPrefixes: ['1900'],
    },
    {
      id: 'carrier-standby',
      type: 'smpp',
      host: 'smpp.standby.example',
      port: 2775,
      enabled: true,
      username: 'jkannel_standby',
      passwordSecretRef: 'secret://kamex/carrier-standby-password',
      bindMode: 'transceiver',
      windowSize: 10,
      throughput: 20,
      keepaliveSeconds: 30,
      reconnectDelaySeconds: 10,
      connectionCount: 1,
    },
  ],
  smsbox: { bearerboxHost: 'kamex-bearerbox', sendsmsPort: 13013, logLevel: 1 },
  sendsmsUsers: [{ username: 'jkannel', passwordSecretRef: 'secret://kamex/sendsms-password' }],
  smsServices: [{ keyword: 'default', text: 'No service specified' }],
  dlrStorage: { type: 'internal' },
};

/**
 * Several links of different kinds, one of them disabled, plus a
 * receiver-only bind and an HTTP provider. Exercises ordering, per-type
 * directive selection and the enabled filter in one render.
 */
export const MULTI_SMSC: EngineConfiguration = {
  adminPort: 13000,
  smsboxPort: 13001,
  adminSecretRef: 'secret://kamex/admin-password',
  logLevel: 2,
  smsc: [
    {
      id: 'zeta-transmitter',
      type: 'smpp',
      host: 'smpp.zeta.example',
      port: 2775,
      enabled: true,
      usernameSecretRef: 'secret://kamex/zeta-username',
      passwordSecretRef: 'secret://kamex/zeta-password',
      bindMode: 'transmitter',
      windowSize: 5,
      throughput: 10,
      keepaliveSeconds: 60,
    },
    {
      id: 'alpha-receiver',
      type: 'smpp',
      host: 'smpp.alpha.example',
      port: 2775,
      receivePort: 2776,
      enabled: true,
      username: 'alpha_mo',
      passwordSecretRef: 'secret://kamex/alpha-password',
      bindMode: 'receiver',
      throughput: 25,
    },
    {
      id: 'http-provider',
      type: 'http',
      host: 'sms.provider.example',
      port: 13015,
      enabled: true,
      sendUrl: 'https://sms.provider.example/submit',
      username: 'jkannel',
      passwordSecretRef: 'secret://kamex/http-provider-password',
      throughput: 5,
    },
    {
      id: 'retired-carrier',
      type: 'smpp',
      host: 'smpp.retired.example',
      port: 2775,
      enabled: false,
      passwordSecretRef: 'secret://kamex/retired-password',
    },
  ],
  smsbox: {
    bearerboxHost: 'kamex-bearerbox',
    sendsmsPort: 13013,
    smsboxId: 'jkannel-smsbox',
    globalSender: '10000',
    logLevel: 2,
  },
  sendsmsUsers: [
    { username: 'jkannel', passwordSecretRef: 'secret://kamex/sendsms-password' },
    {
      username: 'bulk',
      passwordSecretRef: 'secret://kamex/bulk-password',
      defaultSmsc: 'zeta-transmitter',
      maxMessages: 50,
      concatenation: true,
    },
  ],
  smsServices: [
    { keyword: 'default', text: 'No service specified' },
    {
      keyword: 'mo',
      getUrl: 'http://jkannel-backend:3000/api/v1/engine/mo?sender=%p&text=%a',
      maxMessages: 0,
      acceptXKannelHeaders: true,
      catchAll: true,
    },
  ],
  dlrStorage: { type: 'internal' },
};
