import { ServiceHealthService } from './service-health.service';

/**
 * These drive the real service against stubbed collaborators, because the
 * property that matters is not "the probe function works" but "a component
 * nobody watches is reported as unwatched rather than as healthy".
 */

const okHealth = {
  check: async () => ({
    dependencies: [
      { name: 'postgres', status: 'ok', required: true, durationMs: 3 },
      { name: 'redis', status: 'ok', required: false, durationMs: 1 },
    ],
  }),
};

const okDatabase = {
  query: async () => ({ rows: [{ overdue: '0', dead: '0', running: '2', oldest_overdue_seconds: null }] }),
};

const okEngines = {
  // "reachable", NOT "ok".
  //
  // KamexAdapter.health() only ever returns transport 'reachable' or
  // 'unreachable'. This fixture originally said 'ok' -- a value the adapter
  // cannot produce -- and the probe was written to match the fixture rather
  // than the adapter. Result: every healthy engine reported CRITICAL in
  // production, with the board's own summary saying "Start with bearerbox"
  // while bearerbox was fine and the poller was reading it every 18 seconds.
  //
  // A fixture that invents a value the real collaborator never emits is worse
  // than no test: it makes a wrong implementation look verified.
  forImplementation: () => ({ health: async () => ({ engine: 'healthy', transport: 'reachable' }) }),
};
const okSqlbox = {
  probe: async () => ({ available: true, evidence: 'tables present' }),
  queueSummary: async () => ({ queued: 0, oldestEpoch: null }),
};

/** A spool holding `queued` messages whose oldest has waited `ageSeconds`. */
const spool = (queued: number, ageSeconds: number) => ({
  probe: async () => ({ available: true, evidence: 'tables present' }),
  queueSummary: async () => ({
    queued,
    oldestEpoch: queued ? Math.round(Date.now() / 1000) - ageSeconds : null,
  }),
});
const okTelemetry = { current: () => ({ state: 'live', detail: 'Snapshot 4s old.' }) };

const build = (overrides: Record<string, any> = {}) =>
  new ServiceHealthService(
    (overrides.health ?? okHealth) as any,
    (overrides.database ?? okDatabase) as any,
    (overrides.engines ?? okEngines) as any,
    (overrides.sqlbox ?? okSqlbox) as any,
    (overrides.telemetry ?? okTelemetry) as any,
  );

const find = (board: any, name: string) => board.services.find((s: any) => s.name === name);

describe('unobserved components', () => {
  afterEach(() => {
    delete process.env.KAMEX_SENDSMS_URL;
    delete process.env.PROMETHEUS_BASE_URL;
  });

  it('reports an unprobed component as unknown, never as healthy', async () => {
    const board = await build().board();
    for (const name of ['smsbox', 'metrics-collector']) {
      const entry = find(board, name);
      expect(entry.state).toBe('unknown');
      expect(entry.observation).toBe('unobserved');
      // And says how to start watching it, rather than leaving a dead row.
      expect(entry.detail).toMatch(/Not probed: set [A-Z_]+/);
      // No timestamp: there was no observation to stamp.
      expect(entry.observedAt).toBeNull();
    }
  });

  it('counts unknown separately, so blind spots cannot read as health', async () => {
    const board = await build().board();
    expect(board.summary.unknown).toBeGreaterThan(0);
    expect(board.summary.statement).toContain('not observable');
  });
});

describe('the smsbox probe', () => {
  afterEach(() => {
    delete process.env.KAMEX_SENDSMS_URL;
    jest.restoreAllMocks();
  });

  it('treats any HTTP answer as proof the listener is alive', async () => {
    process.env.KAMEX_SENDSMS_URL = 'http://kamex-smsbox:13013';
    // Kannel answers a parameterless request with an error page. That is a
    // listener, and calling it unhealthy would fire an alarm on every poll.
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 400 } as any);
    const entry = find(await build().board(), 'smsbox');
    expect(entry.state).toBe('healthy');
    expect(entry.observation).toBe('probed');
    // But does not overclaim: a listener is not a working submission path.
    expect(entry.detail).toContain('does not prove a submission would route');
  });

  it('is critical when the listener refuses the connection', async () => {
    process.env.KAMEX_SENDSMS_URL = 'http://kamex-smsbox:13013';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const entry = find(await build().board(), 'smsbox');
    expect(entry.state).toBe('critical');
    expect(entry.detail).toContain('ECONNREFUSED');
  });
});

describe('the job worker probe', () => {
  const withJobs = (row: Record<string, string | null>) =>
    build({ database: { query: async () => ({ rows: [row] }) } });

  it('judges on overdue work, not on queue depth', async () => {
    // A thousand jobs scheduled for tomorrow is not a problem. The query only
    // counts rows whose next_attempt_at has already passed.
    const entry = find(
      await withJobs({ overdue: '0', dead: '0', running: '40', oldest_overdue_seconds: null }).board(),
      'job-worker',
    );
    expect(entry.state).toBe('healthy');
    expect(entry.detail).toContain('40 running');
  });

  it('escalates with the age of the oldest overdue job', async () => {
    const behind = find(
      await withJobs({ overdue: '3', dead: '0', running: '0', oldest_overdue_seconds: '300' }).board(),
      'job-worker',
    );
    expect(behind.state).toBe('degraded');

    const stopped = find(
      await withJobs({ overdue: '3', dead: '0', running: '0', oldest_overdue_seconds: '3600' }).board(),
      'job-worker',
    );
    expect(stopped.state).toBe('critical');
    expect(stopped.detail).toContain('not draining');
  });

  it('treats dead-lettered jobs as a degradation needing a decision', async () => {
    const entry = find(
      await withJobs({ overdue: '0', dead: '4', running: '0', oldest_overdue_seconds: null }).board(),
      'job-worker',
    );
    expect(entry.state).toBe('degraded');
    expect(entry.detail).toContain('will not retry on their own');
  });

  it('reports a stuck job — a worker that died mid-execution', async () => {
    // Counted inside `running` this looks like healthy work in progress, which
    // is how a wedged queue stays invisible.
    const entry = find(
      await withJobs({ overdue: '0', dead: '0', running: '4', stuck: '2', oldest_overdue_seconds: null }).board(),
      'job-worker',
    );
    expect(entry.state).toBe('degraded');
    expect(entry.detail).toContain('heartbeat has gone stale');
    expect(entry.detail).toContain('workers are crashing');
  });

  it('reports the stuck job ahead of an overdue backlog it probably caused', async () => {
    const entry = find(
      await withJobs({ overdue: '9', dead: '0', running: '1', stuck: '1', oldest_overdue_seconds: '3600' }).board(),
      'job-worker',
    );
    // The more specific finding wins: "a worker died" explains the backlog,
    // and "the worker is behind" does not explain the dead worker.
    expect(entry.detail).toContain('heartbeat has gone stale');
  });

  it('says unknown — not healthy — when the table cannot be read', async () => {
    const entry = find(
      await build({
        database: {
          query: async () => {
            throw new Error('connection terminated');
          },
        },
      }).board(),
      'job-worker',
    );
    expect(entry.state).toBe('unknown');
  });
});

describe('the bearerbox probe speaks the adapter’s actual vocabulary', () => {
  /** Exactly the shapes KamexAdapter.health() can return. Nothing invented. */
  const engineReturning = (health: Record<string, string>) => ({
    forImplementation: () => ({ health: async () => health }),
  });

  it('is HEALTHY on a reachable engine — the false-critical regression', async () => {
    // Shipped to production reporting critical on a perfectly healthy engine,
    // because the probe tested `transport !== 'ok'` and the adapter says
    // 'reachable'. The board then told operators to start with bearerbox while
    // the poller was reading it every 18 seconds.
    const entry = find(
      await build({ engines: engineReturning({ engine: 'healthy', transport: 'reachable' }) }).board(),
      'bearerbox',
    );
    expect(entry.state).toBe('healthy');
  });

  it('is critical only when the transport is genuinely unreachable', async () => {
    const entry = find(
      await build({ engines: engineReturning({ engine: 'unknown', transport: 'unreachable' }) }).board(),
      'bearerbox',
    );
    expect(entry.state).toBe('critical');
    expect(entry.detail).toContain('admin port did not answer');
  });

  it('degrades on a reachable engine that reports itself degraded', async () => {
    // 503 from the engine: running, but typically with no carrier bind up.
    const entry = find(
      await build({ engines: engineReturning({ engine: 'degraded', transport: 'reachable' }) }).board(),
      'bearerbox',
    );
    expect(entry.state).toBe('degraded');
  });

  it('says unknown, not critical, on a transport word it does not recognise', async () => {
    // If the adapter's vocabulary ever grows, the board must admit it cannot
    // judge rather than inventing an outage.
    const entry = find(
      await build({ engines: engineReturning({ engine: 'healthy', transport: 'something-new' }) }).board(),
      'bearerbox',
    );
    expect(entry.state).toBe('unknown');
    expect(entry.detail).toContain('unrecognised transport state');
  });
});

describe('the sqlbox probe detects a WEDGED daemon, not just readable tables', () => {
  it('is healthy when the spool is empty', async () => {
    const entry = find(await build().board(), 'sqlbox');
    expect(entry.state).toBe('healthy');
    expect(entry.detail).toContain('nothing is waiting to be drained');
  });

  it('is healthy when a small backlog is draining normally', async () => {
    const entry = find(await build({ sqlbox: spool(12, 2) }).board(), 'sqlbox');
    expect(entry.state).toBe('healthy');
    expect(entry.detail).toContain('draining normally');
  });

  it('is CRITICAL when the oldest spooled message has waited minutes', async () => {
    // THE REAL INCIDENT: bearerbox was recreated, sqlbox never reconnected,
    // sending stopped — and both the container healthcheck (`kill -0 1`) and
    // the old table-readability probe reported healthy throughout.
    const entry = find(await build({ sqlbox: spool(430, 1800) }).board(), 'sqlbox');
    expect(entry.state).toBe('critical');
    expect(entry.detail).toContain('430 message(s) are spooled');
    expect(entry.detail).toContain('not injecting into bearerbox');
    // And names the fix, because the operator's next question is "so what".
    expect(entry.detail).toContain('Restarting sqlbox');
  });

  it('degrades before it fails, so a busy bind is not an outage', async () => {
    const entry = find(await build({ sqlbox: spool(50, 120) }).board(), 'sqlbox');
    expect(entry.state).toBe('degraded');
    expect(entry.detail).toContain('check bind health before assuming sqlbox is at fault');
  });

  it('is critical when the message store cannot be read at all', async () => {
    const entry = find(
      await build({
        sqlbox: {
          probe: async () => ({ available: false, evidence: 'tables not created' }),
          queueSummary: async () => ({ queued: 0, oldestEpoch: null }),
        },
      }).board(),
      'sqlbox',
    );
    expect(entry.state).toBe('critical');
    expect(entry.detail).toContain('tables not created');
  });

  it('does not upgrade a partial answer to a clean bill of health', async () => {
    // Tables readable but the queue unmeasurable: a stall would go undetected
    // while that is true, and the row has to say so rather than report healthy.
    const entry = find(
      await build({
        sqlbox: {
          probe: async () => ({ available: true, evidence: 'tables present' }),
          queueSummary: async () => {
            throw new Error('relation "send_sms" does not exist');
          },
        },
      }).board(),
      'sqlbox',
    );
    expect(entry.state).toBe('degraded');
    expect(entry.detail).toContain('would not be detected');
  });
});

describe('dependency attribution on the assembled board', () => {
  it('names the database as the cause when bearerbox is down with it', async () => {
    const board = await build({
      health: {
        check: async () => ({
          dependencies: [
            { name: 'postgres', status: 'unhealthy', required: true, detail: 'connection refused' },
            { name: 'redis', status: 'ok', required: false, durationMs: 1 },
          ],
        }),
      },
      engines: {
        forImplementation: () => ({ health: async () => ({ engine: 'unhealthy', transport: 'unreachable' }) }),
      },
    }).board();

    expect(find(board, 'database').state).toBe('critical');
    expect(find(board, 'bearerbox').rootCause).toBe('database');
    // The operator is sent to the one thing worth fixing first.
    expect(board.summary.rootFailures).toContain('database');
    expect(board.summary.rootFailures).not.toContain('bearerbox');
  });

  it('degrades rather than fails on a lost cache, which does not stop traffic', async () => {
    const board = await build({
      health: {
        check: async () => ({
          dependencies: [
            { name: 'postgres', status: 'ok', required: true, durationMs: 2 },
            { name: 'redis', status: 'unhealthy', required: false, detail: 'timed out' },
          ],
        }),
      },
    }).board();
    expect(find(board, 'cache').state).toBe('degraded');
    expect(board.summary.critical).toBe(0);
  });

  it('reports a skipped dependency as unobserved, not as passing', async () => {
    const board = await build({
      health: {
        check: async () => ({
          dependencies: [
            { name: 'postgres', status: 'ok', required: true, durationMs: 2 },
            { name: 'redis', status: 'skipped', required: false, detail: 'REDIS_URL is not set' },
          ],
        }),
      },
    }).board();
    expect(find(board, 'cache').state).toBe('unknown');
    expect(find(board, 'cache').observation).toBe('unobserved');
  });
});

describe('a single service view', () => {
  it('carries the resolved dependencies and dependents, not just their names', async () => {
    const detail = await build().service('bearerbox');
    expect(detail?.dependencies.map((d: any) => d.name)).toEqual(['database']);
    expect(detail?.dependents.map((d: any) => d.name).sort()).toEqual([
      'engine-poller',
      'smsbox',
      'sqlbox',
    ]);
    // Each carries its own state, so the screen can say which dependency is
    // the problem without a second round trip.
    expect(detail?.dependencies[0].state).toBe('healthy');
  });

  it('returns null for a name that is not in the register', async () => {
    expect(await build().service('nonexistent')).toBeNull();
  });
});
