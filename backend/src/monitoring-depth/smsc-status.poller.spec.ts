import { EngineQueueSnapshot } from '../engine/kamex.adapter';
import { EngineSnapshotCache } from './engine-snapshot.cache';
import { SmscStatusPoller } from './smsc-status.poller';

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * Fake tenant client. Only the reads the poller actually performs are modelled;
 * every write is recorded so a test can assert on what was persisted. Mirrors
 * the hand-rolled client stub style used by alert-escalation.service.spec.ts.
 */
function makeClient(options: {
  definitions?: Array<{ id: string; engine_id: string; name: string }>;
  previousState?: {
    state: string;
    consecutive_observations: number;
    failed_count: number;
  } | null;
  locked?: boolean;
}) {
  const recorded: Recorded[] = [];
  const client: any = {
    recorded,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      recorded.push({ sql, params });
      if (sql.includes('pg_try_advisory_xact_lock'))
        return { rows: [{ locked: options.locked ?? true }] };
      if (sql.includes('FROM smsc_definitions')) return { rows: options.definitions ?? [] };
      if (sql.includes('FROM smsc_bind_state'))
        return { rows: options.previousState ? [options.previousState] : [] };
      // The insert now RETURNS (xmax = 0) AS inserted so the caller can tell a
      // new incident from a re-sharpened one; a fresh insert reports inserted.
      if (sql.includes('INSERT INTO alert_instances'))
        return { rows: [{ inserted: true, id: 'a1' }], rowCount: 1 };
      if (sql.startsWith('UPDATE alert_instances')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return client;
}

function makeDatabase(client: any) {
  return {
    query: jest.fn(async () => ({ rows: [{ id: '1' }] })),
    tenantTransaction: jest.fn((_tenantId: string, work: any) => work(client)),
  } as any;
}

function snapshotWith(
  binds: Array<Partial<EngineQueueSnapshot['binds'][number]> & { engineId: string }>,
  overrides: Partial<EngineQueueSnapshot> = {},
): EngineQueueSnapshot {
  return {
    observedAt: '2026-08-04T03:00:00.000Z',
    engine: {
      status: 'running',
      version: '1.8.3',
      uptimeSeconds: 3600,
      smsQueuedOut: 4,
      smsQueuedIn: 1,
      dlrQueued: 2,
      storeSize: null,
    },
    binds: binds.map((bind) => ({
      name: bind.engineId,
      status: 'online',
      queued: 0,
      failed: 0,
      sent: 0,
      received: 0,
      outboundRate: [0, 0, 0],
      inboundRate: [0, 0, 0],
      ...bind,
    })),
    source: { status: 'ok', detail: 'Parsed from Kamex bearerbox /status.json' },
    ...overrides,
  };
}

const DEFINITIONS = [{ id: 'smsc-uuid-a', engine_id: 'local-fake', name: 'Local Fake A' }];

function findAll(recorded: Recorded[], fragment: string): Recorded[] {
  return recorded.filter((entry) => entry.sql.includes(fragment));
}

describe('SmscStatusPoller state transitions', () => {
  const now = new Date('2026-08-04T03:00:00.000Z');

  it('raises a critical alert and records history when a bind goes online -> dead', async () => {
    const client = makeClient({
      definitions: DEFINITIONS,
      previousState: { state: 'bound', consecutive_observations: 12, failed_count: 0 },
    });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    const result = await poller.runForTenant(
      '1',
      snapshotWith([{ engineId: 'local-fake', status: 'dead' }]),
      now,
    );

    expect(result.transitions).toBe(1);
    expect(result.alertsOpened).toBe(1);

    const transition = findAll(client.recorded, 'INSERT INTO smsc_bind_transitions')[0];
    expect(transition.params).toEqual(
      expect.arrayContaining(['1', 'smsc-uuid-a', 'local-fake', 'state_change', 'bound']),
    );

    const alert = findAll(client.recorded, 'INSERT INTO alert_instances')[0];
    // tenant, severity, dedupKey, summary, details
    expect(alert.params[1]).toBe('critical');
    expect(alert.params[2]).toBe('engine:bind:local-fake');
    expect(String(alert.params[3])).toContain('disconnected');

    // Every transition also produces an audit record and refreshes smsc_health.
    expect(findAll(client.recorded, 'INSERT INTO audit_log')).toHaveLength(1);
    expect(findAll(client.recorded, 'INSERT INTO smsc_health')).toHaveLength(1);
  });

  it('does not re-raise or re-record while a bind stays down (no flapping)', async () => {
    const client = makeClient({
      definitions: DEFINITIONS,
      // Already disconnected and confirmed on previous cycles.
      previousState: { state: 'disconnected', consecutive_observations: 4, failed_count: 0 },
    });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    const result = await poller.runForTenant(
      '1',
      snapshotWith([{ engineId: 'local-fake', status: 'dead' }]),
      now,
    );

    expect(result.transitions).toBe(0);
    expect(findAll(client.recorded, 'INSERT INTO smsc_bind_transitions')).toHaveLength(0);
    expect(findAll(client.recorded, 'INSERT INTO audit_log')).toHaveLength(0);
    // The alert insert is still attempted but is a no-op at the database level
    // (partial unique index), and the state row records one more observation.
    const stateWrite = findAll(client.recorded, 'INSERT INTO smsc_bind_state')[0];
    expect(stateWrite.params[5]).toBe(5); // consecutive_observations incremented
  });

  it('holds off on a transitional state until it has been confirmed', async () => {
    const client = makeClient({
      definitions: DEFINITIONS,
      previousState: { state: 'bound', consecutive_observations: 9, failed_count: 0 },
    });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    // bound -> connecting is a real transition (recorded) but a single
    // observation is not yet enough to page anyone.
    const result = await poller.runForTenant(
      '1',
      snapshotWith([{ engineId: 'local-fake', status: 'connecting' }]),
      now,
    );
    expect(result.transitions).toBe(1);
    expect(result.alertsOpened).toBe(0);
    expect(findAll(client.recorded, 'INSERT INTO alert_instances')).toHaveLength(0);
  });

  it('resolves the open alert when a bind recovers', async () => {
    const client = makeClient({
      definitions: DEFINITIONS,
      previousState: { state: 'disconnected', consecutive_observations: 6, failed_count: 0 },
    });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    const result = await poller.runForTenant(
      '1',
      snapshotWith([{ engineId: 'local-fake', status: 'online' }]),
      now,
    );
    expect(result.alertsResolved).toBeGreaterThanOrEqual(1);
    const resolve = findAll(client.recorded, "UPDATE alert_instances SET status = 'resolved'").at(
      -1,
    )!;
    expect(resolve.params[0]).toBe('engine:bind:local-fake');
  });

  it('alerts on a jump in the engine failure counter even while the bind stays bound', async () => {
    const client = makeClient({
      definitions: DEFINITIONS,
      previousState: { state: 'bound', consecutive_observations: 20, failed_count: 5 },
    });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    const result = await poller.runForTenant(
      '1',
      snapshotWith([{ engineId: 'local-fake', status: 'online', failed: 40 }]),
      now,
    );
    expect(result.transitions).toBe(1);
    const jump = findAll(client.recorded, 'INSERT INTO smsc_bind_transitions')[0];
    expect(jump.sql).toContain("'failure_jump'");
    const alert = findAll(client.recorded, 'INSERT INTO alert_instances')[0];
    expect(alert.params[2]).toBe('engine:bind-failures:local-fake');
  });
});

describe('SmscStatusPoller tenant scoping', () => {
  const now = new Date('2026-08-04T03:00:00.000Z');

  it('ignores binds the tenant does not own', async () => {
    const client = makeClient({ definitions: DEFINITIONS, previousState: null });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    const result = await poller.runForTenant(
      '1',
      snapshotWith([
        { engineId: 'local-fake', status: 'online' },
        { engineId: 'someone-elses-carrier', status: 'dead' },
      ]),
      now,
    );

    expect(result.binds).toBe(1);
    const written = findAll(client.recorded, 'INSERT INTO smsc_bind_snapshots');
    expect(written).toHaveLength(1);
    expect(written[0].params).toContain('local-fake');
    // Nothing about the other tenant's bind is persisted anywhere.
    const everything = JSON.stringify(client.recorded);
    expect(everything).not.toContain('someone-elses-carrier');
  });

  it('skips the cycle when another replica holds the advisory lock', async () => {
    const client = makeClient({ definitions: DEFINITIONS, locked: false });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());
    const result = await poller.runForTenant('1', snapshotWith([]), now);
    expect(result.skipped).toBe(true);
    expect(client.recorded).toHaveLength(1); // only the lock attempt
  });
});

describe('SmscStatusPoller when the engine is unreachable', () => {
  const now = new Date('2026-08-04T03:00:00.000Z');
  const unavailable = snapshotWith([], {
    binds: [],
    engine: {
      status: 'unknown',
      version: null,
      uptimeSeconds: null,
      smsQueuedOut: null,
      smsQueuedIn: null,
      dlrQueued: null,
      storeSize: null,
    },
    source: { status: 'unavailable', detail: 'Kamex status unavailable: fetch failed' },
  });

  it('raises one engine-level alert and never guesses that binds are dead', async () => {
    const client = makeClient({
      definitions: DEFINITIONS,
      previousState: { state: 'bound', consecutive_observations: 3, failed_count: 0 },
    });
    const poller = new SmscStatusPoller(makeDatabase(client), {} as any, new EngineSnapshotCache());

    const result = await poller.runForTenant('1', unavailable, now);

    expect(result.alertsOpened).toBe(1);
    expect(result.transitions).toBe(0);
    expect(findAll(client.recorded, 'INSERT INTO smsc_bind_transitions')).toHaveLength(0);
    expect(findAll(client.recorded, 'INSERT INTO smsc_bind_snapshots')).toHaveLength(0);
    const alert = findAll(client.recorded, 'INSERT INTO alert_instances')[0];
    expect(alert.params[2]).toBe('engine:unreachable');
    // Engine-level nullable counters are stored as NULL, never coerced to 0.
    const poll = findAll(client.recorded, 'INSERT INTO engine_poll_snapshots')[0];
    expect(poll.params[6]).toBeNull(); // sms_queued_out
    expect(poll.params[9]).toBeNull(); // store_size
  });

  it('runCycle does not throw when the adapter itself rejects', async () => {
    const client = makeClient({ definitions: DEFINITIONS });
    const cache = new EngineSnapshotCache();
    const adapter = { queueSnapshot: jest.fn().mockRejectedValue(new Error('boom')) } as any;
    const poller = new SmscStatusPoller(makeDatabase(client), adapter, cache);

    await expect(poller.runCycle(now)).resolves.toHaveLength(1);
    // The cache still learns that the engine could not be read.
    expect(cache.get()?.snapshot.source.status).toBe('unavailable');
    expect(cache.get()?.snapshot.source.detail).toContain('boom');
  });

  it('runCycle isolates a per-tenant database failure', async () => {
    const cache = new EngineSnapshotCache();
    const adapter = { queueSnapshot: jest.fn().mockResolvedValue(snapshotWith([])) } as any;
    const database: any = {
      query: jest.fn(async () => ({ rows: [{ id: '1' }, { id: '2' }] })),
      tenantTransaction: jest.fn(async (tenantId: string) => {
        if (tenantId === '1') throw new Error('deadlock detected');
        return {
          tenantId,
          binds: 0,
          transitions: 0,
          alertsOpened: 0,
          alertsResolved: 0,
          skipped: false,
        };
      }),
    };
    const poller = new SmscStatusPoller(database, adapter, cache);
    const results = await poller.runCycle(now);
    expect(results).toHaveLength(2);
    expect(results[0].skipped).toBe(true);
    expect(results[1].skipped).toBe(false);
  });
});

describe('EngineSnapshotCache', () => {
  it('reports the age of the cached snapshot', () => {
    const cache = new EngineSnapshotCache();
    expect(cache.get()).toBeNull();
    expect(cache.ageSeconds()).toBeNull();
    const at = new Date('2026-08-04T03:00:00.000Z');
    cache.set(snapshotWith([]), at);
    expect(cache.ageSeconds(new Date('2026-08-04T03:00:45.000Z'))).toBe(45);
  });
});
