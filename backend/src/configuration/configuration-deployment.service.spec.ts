import { BadGatewayException } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ConfigurationDeploymentService } from './configuration-deployment.service';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  rename: jest.fn(),
  writeFile: jest.fn(),
}));

const mockedReadFile = readFile as unknown as jest.Mock;
const mockedWriteFile = writeFile as unknown as jest.Mock;
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

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KAMEX_CONFIG_PATH = '/var/lib/jkannel/kamex.conf';
    process.env.KAMEX_VALIDATOR_URL = 'http://kamex-validator:8080';
    process.env.KAMEX_VALIDATOR_TOKEN = 'token';
    process.env.KAMEX_BASE_URL = 'http://kamex-bearerbox:13000';
    process.env.KAMEX_ADMIN_PASSWORD = 'admin-pw';
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
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
    const restored = mockedWriteFile.mock.calls.map((call: any[]) => call[1]);
    expect(restored).toContainEqual(Buffer.from('# previous good config\n'));
    expect(mockedRename).toHaveBeenCalledTimes(2);
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
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});
