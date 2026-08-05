import { KamexAdapter } from './kamex.adapter';

/**
 * `reconnect` used to issue `start-smsc` — the identical call as `enable` — so
 * reconnecting an already-bound SMSC did nothing and recorded a success. These
 * tests hold the fix: the bind must be STOPPED and STARTED, and the result must
 * report the states that were actually observed rather than assert a cycle it
 * never saw.
 */

interface StatusScript {
  /** Bind status returned by /status.json, consumed one entry per poll. */
  statuses: Array<string | null>;
  /** Admin endpoints that should answer with a refusal. */
  refuse?: string[];
}

function makeAdapter(script: StatusScript) {
  const commands: string[] = [];
  let statusPolls = 0;
  const fetchMock = jest.fn(async (input: URL) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname === '/status.json') {
      const entry = script.statuses[Math.min(statusPolls, script.statuses.length - 1)];
      statusPolls += 1;
      if (entry === null) return { ok: false, status: 503, text: async () => '' } as any;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'running',
          sms: {},
          dlr: {},
          smscs: [{ id: 'carrier-a', name: 'Carrier A', status: entry }],
        }),
      } as any;
    }
    commands.push(url.pathname);
    if (script.refuse?.includes(url.pathname))
      return { ok: true, status: 200, text: async () => 'Could not start smsc' } as any;
    return { ok: true, status: 200, text: async () => `${url.pathname} accepted` } as any;
  });
  (globalThis as any).fetch = fetchMock;
  return {
    adapter: new KamexAdapter(),
    commands,
    get statusPolls() {
      return statusPolls;
    },
  };
}

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.KAMEX_BASE_URL = 'http://kamex.test';
  process.env.KAMEX_ADMIN_PASSWORD = 'admin';
  process.env.KAMEX_STATUS_PASSWORD = 'status';
  // Real budgets are 5s/10s; shortened here so the "never came back" paths do
  // not spend fifteen seconds proving they gave up.
  process.env.KAMEX_RECONNECT_STOP_TIMEOUT_MS = '60';
  process.env.KAMEX_RECONNECT_START_TIMEOUT_MS = '60';
  process.env.KAMEX_RECONNECT_POLL_MS = '10';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('reconnect actually cycles the bind', () => {
  it('issues stop-smsc THEN start-smsc, not start alone', async () => {
    const { adapter, commands } = makeAdapter({
      statuses: ['online', 'dead', 'dead', 'online'],
    });
    await adapter.controlSmsc('reconnect', 'carrier-a');

    expect(commands).toEqual(['/stop-smsc', '/start-smsc']);
  });

  it('reports the states it observed across the cycle', async () => {
    const { adapter } = makeAdapter({ statuses: ['online', 'dead', 'dead', 'online'] });
    const result = await adapter.controlSmsc('reconnect', 'carrier-a');

    expect(result.states).toMatchObject({
      before: 'online',
      afterStop: 'dead',
      afterStart: 'online',
      cycleVerified: true,
    });
    expect(result.detail).toContain('online -> dead -> online');
    expect(result.detail).toContain('observed to drop and be re-established');
  });

  it('does NOT claim a verified cycle when the bind never went off-line', async () => {
    // Every poll says online: bearerbox took both commands but we never saw the
    // drop, so the result must say so rather than record a clean success.
    const { adapter } = makeAdapter({ statuses: ['online'] });
    const result = await adapter.controlSmsc('reconnect', 'carrier-a');

    expect(result.states?.cycleVerified).toBe(false);
    expect(result.detail).toContain('WARNING');
    expect(result.detail).toContain('never observed off-line');
  });

  it('says the cycle could not be verified when /status.json is unavailable', async () => {
    const { adapter, commands } = makeAdapter({ statuses: [null] });
    const result = await adapter.controlSmsc('reconnect', 'carrier-a');

    // The commands still go out — an unobservable engine is not a reason to
    // refuse to act — but nothing is claimed about the result.
    //
    // /health is filtered out: a failed authenticated read now triggers one
    // unauthenticated /health probe to tell "engine down" from "our password is
    // wrong". It is deliberately excluded here because it carries no password
    // and so cannot contribute to the engine's auth-failure penalty — this
    // assertion is about which ADMIN commands were issued.
    expect(commands.filter((url) => !url.includes('/health'))).toEqual([
      '/stop-smsc',
      '/start-smsc',
    ]);
    expect(result.states?.cycleVerified).toBe(false);
    expect(result.detail).toContain('could NOT be verified');
  });

  it('fails loudly when bearerbox refuses either half of the cycle', async () => {
    const stop = makeAdapter({ statuses: ['online'], refuse: ['/stop-smsc'] });
    await expect(stop.adapter.controlSmsc('reconnect', 'carrier-a')).rejects.toThrow(
      /reconnect \(stop\)/,
    );
    // The start must not be issued after a failed stop.
    expect(stop.commands).toEqual(['/stop-smsc']);

    const start = makeAdapter({ statuses: ['online', 'dead'], refuse: ['/start-smsc'] });
    await expect(start.adapter.controlSmsc('reconnect', 'carrier-a')).rejects.toThrow(
      /reconnect \(start\)/,
    );
  });
});

describe('enable and disable are unchanged single commands', () => {
  it('enable issues start-smsc only', async () => {
    const { adapter, commands } = makeAdapter({ statuses: ['online'] });
    const result = await adapter.controlSmsc('enable', 'carrier-a');
    expect(commands).toEqual(['/start-smsc']);
    expect(result.states).toBeUndefined();
    expect(result.accepted).toBe(true);
  });

  it('disable issues stop-smsc only', async () => {
    const { adapter, commands } = makeAdapter({ statuses: ['dead'] });
    await adapter.controlSmsc('disable', 'carrier-a');
    expect(commands).toEqual(['/stop-smsc']);
  });

  it('surfaces the engine’s refusal text rather than a bare "failed"', async () => {
    const { adapter } = makeAdapter({ statuses: ['dead'], refuse: ['/start-smsc'] });
    await expect(adapter.controlSmsc('enable', 'carrier-a')).rejects.toThrow(
      /Could not start smsc/,
    );
  });

  it('refuses to act at all when the admin endpoint is not configured', async () => {
    const { adapter } = makeAdapter({ statuses: ['online'] });
    delete process.env.KAMEX_ADMIN_PASSWORD;
    await expect(adapter.controlSmsc('enable', 'carrier-a')).rejects.toThrow(
      /administrative endpoint is not configured/,
    );
  });
});
