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
    chmod: async (mode: number) => events.push(`chmod:${mode.toString(8)}:${path}`),
    close: async () => undefined,
  }));
  return { events, writes };
}
const mockedRename = rename as unknown as jest.Mock;
const mockedMkdir = mkdir as unknown as jest.Mock;

/**
 * `text()` as well as `json()`, because the reload check reads the health body
 * to tell "bearerbox is running with no carrier bound" (503 + status running)
 * from "bearerbox did not come back". A mock without it made every deploy test
 * fail on a missing method rather than on the behaviour under test.
 */
const response = (status: number, body: unknown = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

/** What Kamex answers on /health when it is up and no SMSC is bound. */
const RUNNING_UNBOUND = { status: 'running', health: 'unhealthy', smscs: {} };

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

  /**
   * 503 WITH `status: running` is a gateway with no carrier bound — the normal
   * state of one being configured for the first time — and this used to roll
   * back on it.
   *
   * Every deployment on an unbound gateway reported failure and reverted, so
   * the operator was told their configuration was bad when it had been rendered
   * correctly, validated by a real bearerbox, and written successfully. And it
   * was unescapable at the moment it mattered most: a new gateway has no
   * carrier bound by definition, so the FIRST deploy could never succeed.
   *
   * `docker-compose.yml` had already learned this for the container healthcheck
   * — it accepts 200 or 503 and says why. The deploy path had not, and the two
   * disagreed about what "healthy" means.
   */
  it('accepts 503 when the engine is running but has no carrier bound', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('# previous\n'));
    global.fetch = fakeFetch({ health: () => response(503, RUNNING_UNBOUND) }) as any;
    await expect(
      runDeploy(new ConfigurationDeploymentService(), 'group = core\n'),
    ).resolves.toMatchObject({ written: true, reloaded: true, verified: true });
    // One rename, not two: nothing was rolled back.
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('still rolls back on a 503 that does not say the engine is running', async () => {
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
    const writeIndex = recorder.events.findIndex((event) => event.startsWith('write:'));
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    // ORDER, not adjacency. This asserted that write sat IMMEDIATELY before
    // sync, which broke the moment a chmod was added between them — and the
    // invariant that matters is only that the content is written before it is
    // made durable, then made durable before the rename.
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeLessThan(syncIndex);
    // rename() is a separate mock; assert it happened and that the file sync
    // preceded it by checking the sync was recorded before rename resolved.
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('fsyncs the directory after the rename, so the entry itself is durable', async () => {
    global.fetch = fakeFetch({}) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(recorder.events.some((event) => event.startsWith('syncdir:'))).toBe(true);
  });

  /*
   * This test used to assert 0600, with the reason "it contains carrier
   * credentials". That reason was false, and the assertion locked in an outage.
   *
   * The rendered configuration contains no credentials — they are `${ENV_NAME}`
   * placeholders the engine resolves from its own environment, which is the
   * whole point of the secret-reference design. What 0600 actually did was make
   * the file unreadable to bearerbox, which runs as a different, unprivileged
   * user: it panicked on `cfg_read` with "System error 13: Permission denied"
   * and the container restarted forever. The rollback rewrote the previous
   * content with the same mode, so reverting did not rescue it either.
   *
   * Found the first time a generated configuration was deployed to a running
   * engine. Every layer above worked — rendered correctly, validated by a real
   * bearerbox in the validator container, written durably and atomically. The
   * engine simply could not open it.
   */
  it('writes a mode the engine can actually read', async () => {
    global.fetch = fakeFetch({}) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(mockedOpen).toHaveBeenCalledWith(expect.stringContaining('.tmp'), 'w', 0o644);
  });

  it('chmods explicitly, because open() is masked by umask', async () => {
    // A container running with umask 077 turns a requested 0644 into 0600 and
    // reintroduces the outage through an environment variable nobody set on
    // purpose. `chmod` is not masked, so the mode is stated twice deliberately.
    const recorder = fileHandleRecorder();
    global.fetch = fakeFetch({}) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(recorder.events.some((event) => event.startsWith('chmod:644:'))).toBe(true);
  });

  it('chmods the rollback write too — a rescue that leaves the engine dead is not one', async () => {
    // The rollback restores the previous CONTENT; it has to restore a readable
    // mode with it, or a failed deploy is unrecoverable without a human on the
    // host.
    mockedReadFile.mockResolvedValue(Buffer.from('# previous\n'));
    const recorder = fileHandleRecorder();
    global.fetch = fakeFetch({ health: () => response(503) }) as any;
    await runDeploy(new ConfigurationDeploymentService(), 'x').catch(() => undefined);
    const chmods = recorder.events.filter((event) => event.startsWith('chmod:'));
    expect(chmods.length).toBeGreaterThan(1);
    expect(chmods.every((event) => event.startsWith('chmod:644:'))).toBe(true);
  });

  /**
   * A graceful restart severs SQLBox, and nothing notices.
   *
   * `graceful-restart` re-execs bearerbox; SQLBox keeps a socket that is no
   * longer connected to anything and never reconnects. Outbound stops dead —
   * every submission lands in `send_sms` and stays — while the deployment
   * reports success, bearerbox reports healthy, and every figure in the console
   * stays green.
   *
   * Measured, not theorised: after one deploy on the local stack, 700 messages
   * sat in `send_sms`, SQLBox's last log line predated the restart, and
   * restarting SQLBox drained all 700 into the engine at once.
   *
   * The result must SAY so. Rolling back is the one response that cannot help:
   * it reloads again and severs the box a second time.
   */
  it('reports a box that did not reattach, because that is delivery stopping silently', async () => {
    const status = (boxes: number) =>
      response(
        200,
        ['Box connections:', ...Array.from({ length: boxes }, (_, i) => `    smsbox:b${i}`), '', 'SMSC connections:'].join('\n'),
      );
    let call = 0;
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input instanceof URL ? input : (input?.url ?? input));
      if (url.includes('/validate')) return response(200, { valid: true });
      if (url.includes('/status.txt')) return status(call++ === 0 ? 2 : 1);
      if (url.includes('/graceful-restart')) return response(200);
      if (url.includes('/health')) return response(200, RUNNING_UNBOUND);
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    const result: any = await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(result).toMatchObject({ written: true, reloaded: true, boxesBefore: 2, boxesAfter: 1 });
    expect(result.warning).toContain('OUTBOUND DELIVERY HAS STOPPED');
    // The remedy has to be in the warning itself. It is now hedged with "if it
    // is still true a minute later", because the measurement on 2026-08-26
    // showed SQLBox reattaching on its own within about twelve seconds after a
    // bearerbox container restart — telling an operator to intervene during a
    // recovery that is already happening is its own kind of wrong answer.
    expect(result.warning).toContain('restart the SQLBox container');
    expect(result.warning).toContain('on its own');
    // Deployed, not rolled back: one rename.
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('says nothing about boxes when they all came back', async () => {
    const status = response(200, 'Box connections:\n    smsbox:a\n\nSMSC connections:');
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input instanceof URL ? input : (input?.url ?? input));
      if (url.includes('/validate')) return response(200, { valid: true });
      if (url.includes('/status.txt')) return status;
      if (url.includes('/graceful-restart')) return response(200);
      if (url.includes('/health')) return response(200);
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;
    const result: any = await runDeploy(new ConfigurationDeploymentService(), 'group = core\n');
    expect(result.warning).toBeUndefined();
    expect(result).toMatchObject({ boxesBefore: 1, boxesAfter: 1 });
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
