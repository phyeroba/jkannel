import { ConfigurationModelBuilder, MO_PUSH_QUERY } from './configuration-model.builder';
import { ConfigurationGeneratorService } from './configuration-generator.service';

const actor = { tenantId: '7', userId: 'user-1' };

/** Fake DatabaseService whose tenantTransaction runs work() against a query stub. */
function fakeDatabase(handler: (sql: string, params: unknown[]) => { rows: any[] }) {
  const client = { query: jest.fn((sql: string, params: unknown[] = []) => handler(sql, params)) };
  return {
    client,
    database: {
      tenantTransaction: jest.fn((_tenantId: string, work: (c: any) => Promise<any>) =>
        work(client),
      ),
    } as any,
  };
}

/** A row shaped like smsc_definitions after migrations 029 and 041, with column defaults. */
const smscRow = (overrides: Record<string, unknown> = {}) => ({
  engine_id: 'carrier-a',
  type: 'smpp',
  host: 'smpp.carrier-a.example',
  port: 2775,
  receive_port: null,
  system_id: 'jkannel_prod',
  username_secret_ref: null,
  credential_secret_ref: 'secret://kamex/carrier-a-password',
  system_type: 'VMA',
  bind_mode: 'transceiver',
  interface_version: 34,
  address_range: null,
  source_addr_ton: 5,
  source_addr_npi: 0,
  dest_addr_ton: 1,
  dest_addr_npi: 1,
  window_size: 20,
  tps: 50,
  keepalive_seconds: 30,
  reconnect_delay_seconds: 10,
  wait_ack_seconds: 60,
  max_error_count: 10,
  use_tls: false,
  alt_charset: null,
  send_url: null,
  // Migration 041 defaults: a single bind, no explicit idle/ack overrides, no
  // routing rules. These must render exactly as they did before 041 existed.
  connection_count: 1,
  connection_timeout_seconds: null,
  wait_ack_expire_action: null,
  retry_on_auth_failure: false,
  allowed_smsc_ids: [],
  denied_smsc_ids: [],
  preferred_smsc_ids: [],
  allowed_prefixes: [],
  denied_prefixes: [],
  preferred_prefixes: [],
  enabled: true,
  lifecycle_state: 'deployed',
  ...overrides,
});

const withRows = (rows: any[], settings: any[] = []) =>
  fakeDatabase((sql) => {
    if (sql.includes('FROM smsc_definitions')) return { rows };
    if (sql.includes('FROM system_settings')) return { rows: settings };
    return { rows: [] };
  });

describe('ConfigurationModelBuilder', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of [
      'KAMEX_ADMIN_PORT',
      'KAMEX_SMSBOX_PORT',
      'KAMEX_SENDSMS_PORT',
      'KAMEX_LOG_LEVEL',
      'KAMEX_BEARERBOX_HOST',
      'KAMEX_SENDSMS_USERNAME',
      'KAMEX_SQLBOX_DATABASE_URL',
      'KAMEX_SQLBOX_HOST',
      'KAMEX_MO_PUSH_URL',
    ])
      delete process.env[key];
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it('builds the model from smsc_definitions inside the tenant transaction', async () => {
    const { database, client } = withRows([smscRow()]);
    const { model, sources } = await new ConfigurationModelBuilder(database).build(actor);

    expect(database.tenantTransaction).toHaveBeenCalledWith('7', expect.any(Function));
    expect(sources.smscCount).toBe(1);
    expect(model.smsc).toHaveLength(1);
    expect(model.smsc[0]).toMatchObject({
      id: 'carrier-a',
      type: 'smpp',
      host: 'smpp.carrier-a.example',
      port: 2775,
      username: 'jkannel_prod',
      passwordSecretRef: 'secret://kamex/carrier-a-password',
      systemType: 'VMA',
      bindMode: 'transceiver',
      interfaceVersion: 34,
      sourceAddrTon: 5,
      destAddrNpi: 1,
      windowSize: 20,
      throughput: 50,
      keepaliveSeconds: 30,
      reconnectDelaySeconds: 10,
      waitAckSeconds: 60,
    });
    // Every read carries an explicit tenant predicate on top of RLS.
    for (const call of client.query.mock.calls) {
      expect(String(call[0])).toContain('tenant_id = $1');
      expect((call[1] as unknown[])[0]).toBe('7');
    }
  });

  it('scopes to the tenant via app.tenant_id and an explicit predicate', async () => {
    const { database, client } = withRows([smscRow()]);
    await new ConfigurationModelBuilder(database).build(actor);
    const smscQuery = client.query.mock.calls.find((call: any[]) =>
      String(call[0]).includes('FROM smsc_definitions'),
    )!;
    expect(String(smscQuery[0])).toMatch(/WHERE\s+tenant_id = \$1/);
    expect(smscQuery[1]).toEqual(['7']);
  });

  it('excludes soft-deleted rows in SQL and reports disabled/archived exclusions', async () => {
    const { database, client } = withRows([
      smscRow(),
      smscRow({ engine_id: 'switched-off', enabled: false }),
      smscRow({ engine_id: 'gone', lifecycle_state: 'archived' }),
      smscRow({ engine_id: 'parked', lifecycle_state: 'disabled' }),
    ]);
    const { model, sources } = await new ConfigurationModelBuilder(database).build(actor);

    expect(model.smsc.map((entry) => entry.id)).toEqual(['carrier-a']);
    expect(sources.excluded).toEqual([
      { engineId: 'switched-off', reason: 'disabled' },
      { engineId: 'gone', reason: 'lifecycle_state=archived' },
      { engineId: 'parked', reason: 'lifecycle_state=disabled' },
    ]);
    const smscQuery = client.query.mock.calls.find((call: any[]) =>
      String(call[0]).includes('FROM smsc_definitions'),
    )!;
    expect(String(smscQuery[0])).toContain('deleted_at IS NULL');
  });

  it('can include inactive SMSCs for a what-if preview', async () => {
    const { database } = withRows([smscRow({ engine_id: 'switched-off', enabled: false })]);
    const { model } = await new ConfigurationModelBuilder(database).build(actor, {
      includeInactive: true,
    });
    expect(model.smsc.map((entry) => entry.id)).toEqual(['switched-off']);
  });

  it('composes the smsbox, sendsms-user, sms-service and dlr-storage groups', async () => {
    const { database } = withRows([smscRow()]);
    const { model } = await new ConfigurationModelBuilder(database).build(actor);
    expect(model.smsbox).toEqual({
      bearerboxHost: 'kamex-bearerbox',
      sendsmsPort: 13013,
      logLevel: 1,
    });
    expect(model.sendsmsUsers).toEqual([
      { username: 'jkannel', passwordSecretRef: 'secret://kamex/sendsms-password' },
    ]);
    // maxMessages 0 suppresses the canned auto-reply. Without it Kannel answers
    // every inbound message with this `text` as a real, billable MT.
    expect(model.smsServices).toEqual([
      { keyword: 'default', text: 'No service specified', maxMessages: 0 },
    ]);
    expect(model.dlrStorage).toEqual({ type: 'internal' });
    expect(model.adminSecretRef).toBe('secret://kamex/admin-password');
  });

  it('prefers a system_settings override over the environment and the default', async () => {
    process.env.KAMEX_ADMIN_PORT = '14000';
    process.env.KAMEX_BEARERBOX_HOST = 'from-env';
    const { database } = withRows(
      [smscRow()],
      [
        { key: 'gateway.admin_port', value: 13100 },
        { key: 'gateway.log_level', value: 3 },
      ],
    );
    const { model, sources } = await new ConfigurationModelBuilder(database).build(actor);
    expect(model.adminPort).toBe(13100);
    expect(model.logLevel).toBe(3);
    expect(model.smsbox?.bearerboxHost).toBe('from-env');
    expect(sources.settingsApplied).toEqual(
      expect.arrayContaining(['gateway.admin_port', 'gateway.log_level', 'KAMEX_BEARERBOX_HOST']),
    );
  });

  it('derives the SQLBox connection from the deployment environment only', async () => {
    const { database } = withRows([smscRow()]);
    expect(
      (await new ConfigurationModelBuilder(database).build(actor)).model.sqlbox,
    ).toBeUndefined();
    process.env.KAMEX_SQLBOX_DATABASE_URL = 'postgresql://u:p@postgres:5432/jkannel';
    expect((await new ConfigurationModelBuilder(database).build(actor)).model.sqlbox).toEqual({
      enabled: true,
      // SQLBox's own service name, separate from `host` (its PostgreSQL). The
      // smsbox group is pointed at this, never at bearerbox.
      serviceHost: 'kamex-sqlbox',
      host: 'postgres',
      port: 5432,
      database: 'jkannel',
      usernameEnv: 'JKANNEL_SQLBOX_USER',
      passwordEnv: 'JKANNEL_SQLBOX_PASSWORD',
    });
  });

  /**
   * The bypass this guards against is invisible in operation: an smsbox wired
   * straight to bearerbox still sends fine, and the only symptom is that
   * `sent_sms` stops being written — taking message history and MO ingest
   * (which sweeps that table) with it, silently.
   */
  describe('smsbox upstream', () => {
    it('points the smsbox at SQLBox, not bearerbox, when SQLBox is deployed', async () => {
      const { database } = withRows([smscRow()]);
      process.env.KAMEX_SQLBOX_DATABASE_URL = 'postgresql://u:p@postgres:5432/jkannel';
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      expect(model.smsbox?.bearerboxHost).toBe('kamex-sqlbox');
    });

    it('keeps pointing at bearerbox when SQLBox is not in the topology', async () => {
      const { database } = withRows([smscRow()]);
      delete process.env.KAMEX_SQLBOX_DATABASE_URL;
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      expect(model.smsbox?.bearerboxHost).toBe('kamex-bearerbox');
    });

    it('refuses an explicit override that would route around SQLBox', async () => {
      const { database } = withRows([smscRow()]);
      process.env.KAMEX_SQLBOX_DATABASE_URL = 'postgresql://u:p@postgres:5432/jkannel';
      process.env.KAMEX_BEARERBOX_HOST = 'kamex-bearerbox';
      await expect(new ConfigurationModelBuilder(database).build(actor)).rejects.toThrow(
        /bypasses SQLBox/,
      );
    });

    it('accepts an explicit override that AGREES with the topology', async () => {
      const { database } = withRows([smscRow()]);
      process.env.KAMEX_SQLBOX_DATABASE_URL = 'postgresql://u:p@postgres:5432/jkannel';
      process.env.KAMEX_BEARERBOX_HOST = 'kamex-sqlbox';
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      expect(model.smsbox?.bearerboxHost).toBe('kamex-sqlbox');
    });
  });

  describe('MO push service', () => {
    it('suppresses the canned auto-reply by default and renders no post-url', async () => {
      const { database } = withRows([smscRow()]);
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      expect(model.smsServices).toEqual([
        { keyword: 'default', text: 'No service specified', maxMessages: 0 },
      ]);
    });

    it('renders a catch-all post-url, still with the reply suppressed, when configured', async () => {
      const { database } = withRows([smscRow()]);
      process.env.KAMEX_MO_PUSH_URL = 'http://jkannel-backend:3000/api/v1/mo/inbound';
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      const [service] = model.smsServices!;
      expect(service.postUrl).toBe(
        'http://jkannel-backend:3000/api/v1/mo/inbound?' + MO_PUSH_QUERY,
      );
      // Without this the "reply" would be the endpoint's HTTP response body —
      // a JSON envelope SMSed back to the subscriber.
      expect(service.maxMessages).toBe(0);
      expect(service.catchAll).toBe(true);
    });

    it('rejects a push URL that already carries a query string', async () => {
      const { database } = withRows([smscRow()]);
      process.env.KAMEX_MO_PUSH_URL = 'http://backend:3000/mo?x=1';
      await expect(new ConfigurationModelBuilder(database).build(actor)).rejects.toThrow(
        /must not contain a query string/,
      );
    });

    it('rejects a push URL that is not absolute http(s)', async () => {
      const { database } = withRows([smscRow()]);
      process.env.KAMEX_MO_PUSH_URL = '/api/v1/mo/inbound';
      await expect(new ConfigurationModelBuilder(database).build(actor)).rejects.toThrow(
        /absolute http\(s\) URL/,
      );
    });
  });

  describe('connection resilience columns (migration 041)', () => {
    it('reads the resilience and routing columns onto the model', async () => {
      const { database } = withRows([
        smscRow({
          connection_count: 4,
          connection_timeout_seconds: 120,
          wait_ack_expire_action: 1,
          retry_on_auth_failure: true,
          preferred_smsc_ids: ['carrier-a'],
          denied_prefixes: ['1900', '1976'],
        }),
      ]);
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      expect(model.smsc[0]).toMatchObject({
        connectionCount: 4,
        connectionTimeoutSeconds: 120,
        waitAckExpireAction: 1,
        retryOnAuthFailure: true,
        preferredSmscIds: ['carrier-a'],
        deniedPrefixes: ['1900', '1976'],
      });
    });

    it('selects the new columns in the SMSC query', async () => {
      const { database, client } = withRows([smscRow()]);
      await new ConfigurationModelBuilder(database).build(actor);
      const sql = String(
        client.query.mock.calls.find((call: any[]) =>
          String(call[0]).includes('FROM smsc_definitions'),
        )![0],
      );
      for (const column of [
        'connection_count',
        'connection_timeout_seconds',
        'wait_ack_expire_action',
        'retry_on_auth_failure',
        'allowed_smsc_ids',
        'denied_smsc_ids',
        'preferred_smsc_ids',
        'allowed_prefixes',
        'denied_prefixes',
        'preferred_prefixes',
      ])
        expect(sql).toContain(column);
    });

    it('drops the column defaults so an untouched SMSC renders as it did before 041', async () => {
      const { database } = withRows([smscRow()]);
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      const [smsc] = model.smsc;
      // Empty arrays and `false` become undefined: the renderer emits nothing
      // for them, so no directive appears and no config checksum moves.
      expect(smsc.retryOnAuthFailure).toBeUndefined();
      expect(smsc.connectionTimeoutSeconds).toBeUndefined();
      expect(smsc.waitAckExpireAction).toBeUndefined();
      for (const field of [
        'allowedSmscIds',
        'deniedSmscIds',
        'preferredSmscIds',
        'allowedPrefixes',
        'deniedPrefixes',
        'preferredPrefixes',
      ] as const)
        expect(smsc[field]).toBeUndefined();
      // connection_count is NOT NULL DEFAULT 1, so it is carried as 1 — the
      // renderer omits `instances` at 1.
      expect(smsc.connectionCount).toBe(1);

      const content = new ConfigurationGeneratorService().generate(model).content;
      expect(content).not.toContain('instances');
      expect(content).not.toContain('retry =');
      expect(content).not.toContain('connection-timeout');
      expect(content).not.toContain('preferred-smsc-id');
    });

    it('renders parallel binds from the database through to the config file', async () => {
      const { database } = withRows([smscRow({ connection_count: 3 })]);
      const { model } = await new ConfigurationModelBuilder(database).build(actor);
      const content = new ConfigurationGeneratorService().generate(model).content;
      expect(content).toContain('smsc-id = carrier-a');
      expect(content).toContain('instances = 3');
      // Still one group; the engine expands it into three binds.
      expect(content.match(/group = smsc/g)).toHaveLength(1);
    });
  });

  it('produces a model the generator renders into a bindable carrier config', async () => {
    const { database } = withRows([smscRow()]);
    const { model } = await new ConfigurationModelBuilder(database).build(actor);
    const generated = new ConfigurationGeneratorService().generate(model);
    // The end of the chain the audit called broken: an SMSC created in the
    // console reaches the rendered file, with credentials as placeholders.
    expect(generated.content).toContain('smsc-id = carrier-a');
    expect(generated.content).toContain('smsc-username = jkannel_prod');
    expect(generated.content).toContain('smsc-password = ${KAMEX_CARRIER_A_PASSWORD}');
    expect(generated.content).toContain('system-type = VMA');
    expect(generated.content).toContain('transceiver-mode = 1');
    expect(generated.content).toContain('group = smsbox');
    expect(generated.content).toContain('group = sendsms-user');
    expect(generated.content).toContain('group = sms-service');
    expect(generated.content).not.toContain('secret://');
  });
});
