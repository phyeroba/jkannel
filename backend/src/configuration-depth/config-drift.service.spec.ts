import { readFile } from 'node:fs/promises';
import { ConfigurationDiffService } from '../configuration/configuration-diff.service';
import { ConfigDriftService } from './config-drift.service';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
const mockedReadFile = readFile as unknown as jest.Mock;

const actor = { tenantId: '7', userId: 'user-1' };

/** Fake DatabaseService whose tenantTransaction runs work() against a query stub. */
function fakeDatabase(handler: (sql: string, params: unknown[]) => { rows: any[] }) {
  const client = { query: jest.fn((sql: string, params: unknown[] = []) => handler(sql, params)) };
  return {
    client,
    database: {
      tenantTransaction: (_tenantId: string, work: (c: any) => Promise<any>) => work(client),
    } as any,
  };
}

const deployedRow = (rendered: string) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  scope: 'gateway',
  version_number: 3,
  content: { rendered },
});

describe('ConfigDriftService', () => {
  const diff = new ConfigurationDiffService();
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KAMEX_CONFIG_PATH = '/var/lib/jkannel/kamex.conf';
  });

  it('reports inSync when the live file matches the deployed render', async () => {
    const rendered = 'group = core\nadmin-port = 13000\n';
    mockedReadFile.mockResolvedValue(rendered);
    const { database } = fakeDatabase((sql) =>
      sql.includes('configuration_versions') ? { rows: [deployedRow(rendered)] } : { rows: [] },
    );
    const result = await new ConfigDriftService(database, diff).check(actor);
    expect(result.inSync).toBe(true);
    expect(result.deployedChecksum).toBe(result.liveChecksum);
    expect(result.differences).toHaveLength(0);
    expect(result.deployedVersion).toMatchObject({ versionNumber: 3, scope: 'gateway' });
  });

  it('detects drift and returns only changed lines', async () => {
    mockedReadFile.mockResolvedValue('group = core\nadmin-port = 14000\n');
    const { database } = fakeDatabase((sql) =>
      sql.includes('configuration_versions')
        ? { rows: [deployedRow('group = core\nadmin-port = 13000\n')] }
        : { rows: [] },
    );
    const result = await new ConfigDriftService(database, diff).check(actor);
    expect(result.inSync).toBe(false);
    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.differences.every((line) => line.kind !== 'unchanged')).toBe(true);
  });

  it('returns undetermined (inSync=null) when no version is deployed', async () => {
    mockedReadFile.mockResolvedValue('group = core\n');
    const { database } = fakeDatabase(() => ({ rows: [] }));
    const result = await new ConfigDriftService(database, diff).check(actor);
    expect(result.inSync).toBeNull();
    expect(result.deployedVersion).toBeNull();
    expect(result.note).toMatch(/no deployed configuration version/i);
  });

  it('returns undetermined (inSync=null) when the live file is missing', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    const { database } = fakeDatabase((sql) =>
      sql.includes('configuration_versions')
        ? { rows: [deployedRow('group = core\n')] }
        : { rows: [] },
    );
    const result = await new ConfigDriftService(database, diff).check(actor);
    expect(result.inSync).toBeNull();
    expect(result.liveChecksum).toBeNull();
    expect(result.note).toMatch(/no live engine config file/i);
  });

  it('recordCheck persists a config_drift_checks row and returns its id', async () => {
    mockedReadFile.mockResolvedValue('group = core\n');
    const { database, client } = fakeDatabase((sql) => {
      if (sql.includes('configuration_versions')) return { rows: [deployedRow('group = core\n')] };
      if (sql.includes('INSERT INTO config_drift_checks'))
        return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] };
      return { rows: [] };
    });
    const result = await new ConfigDriftService(database, diff).recordCheck(actor);
    expect(result.checkId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(result.inSync).toBe(true);
    const insertCall: any[] | undefined = client.query.mock.calls.find((c: any[]) =>
      String(c[0]).includes('INSERT INTO config_drift_checks'),
    );
    expect(insertCall).toBeDefined();
    const insertParams = (insertCall ?? [])[1] as unknown[];
    expect(insertParams[0]).toBe('7');
  });
});
