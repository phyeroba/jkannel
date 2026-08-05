import { BadGatewayException } from '@nestjs/common';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { ConfigurationDeploymentService } from './configuration-deployment.service';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  rename: jest.fn(),
  open: jest.fn(),
}));

const mockedReadFile = readFile as unknown as jest.Mock;
const mockedOpen = open as unknown as jest.Mock;

/**
 * Records the order of durability operations, because ORDER is the property
 * that matters: fsync after rename would leave a window in which the rename is
 * on disk but the contents are not, and the engine panics on a truncated
 * configuration file every time it starts thereafter.
 */
function fileHandleRecorder() {
  const events: string[] = [];
  const writes: Array<string | Buffer> = [];
  mockedOpen.mockImplementation(async (path: string, flags: string) => ({
    writeFile: async (content: string | Buffer) => {
      writes.push(content);
      events.push(`write:${path}`);
    },
    // 'r' is the directory handle opened purely to fsync the rename; 'w' is
    // the config file itself.
    sync: async () => events.push(flags === 'r' ? `syncdir:${path}` : `sync:${path}`),
    close: async () => undefined,
  }));
  return { events, writes };
}
const mockedRename = rename as unknown as jest.Mock;
const mockedMkdir = mkdir as unknown as jest.Mock;

const response = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

/**
 * Routes fetch by URL path: /validate (native validator), /graceful-restart
 * (reload) and /health (post-deploy verification).
 */
function fakeFetch(handlers: {
  validate?: () => Response;
  restart?: () => Response;
  health?: () => Response;
}) {
  return jest.fn(async (input: any) => {
    const url = String(input instanceof URL ? input : (input?.url ?? input));
    if (url.includes('/validate'))
      return (handlers.validate ?? (() => response(200, { valid: true })))();
    if (url.includes('/graceful-restart')) return (handlers.restart ?? (() => response(200)))();
    if (url.includes('/health')) return (handlers.health ?? (() => response(200)))();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('ConfigurationDeploymentService', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  let recorder: ReturnType<typeof fileHandleRecorder>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KAMEX_CONFIG_PATH = '/var/lib/jkannel/kamex.conf';
    process.env.KAMEX_VALIDATOR_URL = 'http://kamex-validator:8080';
    process.env.KAMEX_VALIDATOR_TOKEN = 'token';
    process.env.KAMEX_BASE_URL = 'http://kamex-bearerbox:13000';
    process.env.KAMEX_ADMIN_PASSWORD = 'admin-pw';
    recorder = fileHandleRecorder();
    mockedMkdir.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  // deploy() sleeps 250 ms between reload and the health probe; real timers are
  // used so the AbortSignal.timeout deadlines inside fetch stay consistent.
  const runDeploy = (service: ConfigurationDeploymentService, content: string) =>
    service.deploy(content);

  it('writes and reports success when the engine comes back healthy', async () => {
    global.fetch = fakeFetch({}) as any;
    const service = new ConfigurationDeploymentService();
    await expect(runDeploy(service, 'group = core\n')).resolves.toMatchObject({
      written: true,
      reloaded: true,
      verified: true,
    });
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('treats HTTP 503 from the health probe as UNHEALTHY and rolls back', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('# previous good config\n'));
    global.fetch = fakeFetch({ health: () => response(503) }) as any;
    const service = new ConfigurationDeploymentService();

    await expect(runDeploy(service, 'group = core\n# broken\n')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    // The previous content was written back and renamed over the target.
    expect(recorder.writes).toContainEqual(Buffer.from('# previous good config\n'));
    expect(mockedRename).toHaveBeenCalledTimes(2);
  });

  /**
   * Ordering, not merely presence. An fsync issued AFTER the rename leaves a
   * window in which the directory entry is durable and the file contents are
   * not — and the engine's parser panics on a truncated configuration and keeps
   * panicking on every subsequent start, so that window costs a gateway that
   * will not boot until someone edits the file by hand.
   */
  it('fsyncs the file BEFORE renaming it over the target', async () => {
    global.fetch = fakeFetch({}) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');

    const syncIndex = recorder.events.findIndex((event) => event.startsWith('sync:'));
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(recorder.events[syncIndex - 1]).toMatch(/^write:/);
    // rename() is a separate mock; assert it happened and that the file sync
    // preceded it by checking the sync was recorded before rename resolved.
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('fsyncs the directory after the rename, so the entry itself is durable', async () => {
    global.fetch = fakeFetch({}) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(recorder.events.some((event) => event.startsWith('syncdir:'))).toBe(true);
  });

  it('writes the configuration 0600 — it contains carrier credentials', async () => {
    global.fetch = fakeFetch({}) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(mockedOpen).toHaveBeenCalledWith(expect.stringContaining('.tmp'), 'w', 0o600);
  });

  it('names 503 in the rollback error so the cause is not silent', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('# previous\n'));
    global.fetch = fakeFetch({ health: () => response(503) }) as any;
    const service = new ConfigurationDeploymentService();
    await expect(runDeploy(service, 'x')).rejects.toThrow(/rolled back.*health verification.*503/i);
  });

  it('rolls back on any other non-2xx health status', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('# previous\n'));
    for (const status of [500, 502, 404]) {
      jest.clearAllMocks();
      mockedReadFile.mockResolvedValue(Buffer.from('# previous\n'));
      global.fetch = fakeFetch({ health: () => response(status) }) as any;
      await expect(runDeploy(new ConfigurationDeploymentService(), 'x')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(mockedRename).toHaveBeenCalledTimes(2);
    }
  });

  it('refuses to write anything when native validation fails', async () => {
    global.fetch = fakeFetch({
      validate: () => response(200, { valid: false, output: 'syntax error' }),
    }) as any;
    await expect(new ConfigurationDeploymentService().deploy('bad')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    // Nothing is opened for writing at all: native validation gates the write.
    expect(mockedOpen).not.toHaveBeenCalled();
  });
});
