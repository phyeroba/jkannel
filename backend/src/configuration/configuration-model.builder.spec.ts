import { ConfigurationModelBuilder } from './configuration-model.builder';
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

/** A row shaped like smsc_definitions after migration 029, with column defaults. */
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
    expect(model.smsServices).toEqual([{ keyword: 'default', text: 'No service specified' }]);
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
      host: 'postgres',
      port: 5432,
      database: 'jkannel',
      usernameEnv: 'JKANNEL_SQLBOX_USER',
      passwordEnv: 'JKANNEL_SQLBOX_PASSWORD',
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
