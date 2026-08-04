import { AlertEvaluatorService } from '../monitoring/alert-evaluator.service';
import { AlertRuleEvaluatorScheduler, labelKey } from './alert-rule-evaluator.scheduler';
import { MaintenanceWindowService } from './maintenance-window.service';

const NOW = new Date('2026-08-04T03:00:00.000Z');

interface Recorded {
  sql: string;
  params: unknown[];
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    name: 'Queue depth',
    metric: 'smsc.queued',
    operator: 'gt',
    threshold: '5000',
    sustain_seconds: 300,
    severity: 'critical',
    enabled: true,
    ...overrides,
  };
}

/** Builds a run of samples spanning `spanSeconds` back from NOW. */
function series(values: number[], labels: Record<string, string>, spanSeconds = 300) {
  const step = spanSeconds / Math.max(1, values.length - 1);
  return values.map((value, index) => ({
    metric: 'smsc.queued',
    value,
    labels,
    observed_at: new Date(NOW.getTime() - (spanSeconds - index * step) * 1000).toISOString(),
  }));
}

function makeScheduler(options: {
  rules?: Array<Record<string, unknown>>;
  samples?: unknown[];
  windows?: unknown[];
  locked?: boolean;
}) {
  const recorded: Recorded[] = [];
  const client: any = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      recorded.push({ sql, params });
      if (sql.includes('pg_try_advisory_xact_lock'))
        return { rows: [{ locked: options.locked ?? true }] };
      if (sql.includes('FROM alert_rules')) return { rows: options.rules ?? [] };
      if (sql.includes('FROM maintenance_windows')) return { rows: options.windows ?? [] };
      if (sql.includes('FROM metric_samples')) return { rows: options.samples ?? [] };
      if (sql.includes('INSERT INTO alert_instances')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('UPDATE alert_instances')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const database: any = {
    query: jest.fn(async () => ({ rows: [{ id: '1' }] })),
    tenantTransaction: (_tenantId: string, work: any) => work(client),
  };
  const scheduler = new AlertRuleEvaluatorScheduler(
    database,
    new AlertEvaluatorService(),
    new MaintenanceWindowService(),
  );
  return { scheduler, recorded, client };
}

const inserts = (recorded: Recorded[]) =>
  recorded.filter((entry) => entry.sql.includes('INSERT INTO alert_instances'));

describe('AlertRuleEvaluatorScheduler', () => {
  it('fires a rule whose threshold is sustained and opens an alert instance', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule()],
      samples: series([6000, 6100, 6200, 6400], { smsc: 'local-fake' }),
    });

    const outcomes = await scheduler.runForTenant('1', NOW);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ state: 'firing', opened: true, value: 6400 });
    const insert = inserts(recorded)[0];
    // tenant, ruleId, severity, dedupKey, summary, details
    expect(insert.params[1]).toBe('rule-1');
    expect(insert.params[2]).toBe('critical');
    expect(insert.params[3]).toBe('rule:rule-1:smsc=local-fake');
    expect(String(insert.params[4])).toContain('smsc.queued on local-fake gt 5000');
    expect(JSON.parse(String(insert.params[5]))).toMatchObject({
      kind: 'rule_threshold',
      smsc: 'local-fake',
      observed: 6400,
    });
  });

  it('does not fire a rule whose samples are below the threshold', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule()],
      samples: series([10, 12, 9, 11], { smsc: 'local-fake' }),
    });
    const outcomes = await scheduler.runForTenant('1', NOW);
    expect(outcomes[0]).toMatchObject({ state: 'inactive', opened: false });
    expect(inserts(recorded)).toHaveLength(0);
  });

  it('does not fire while the threshold is crossed but not yet sustained', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule()],
      // Only the last few seconds of a 300s sustain window breach the
      // threshold, so the latest sample is over but the run is not continuous.
      samples: [
        {
          metric: 'smsc.queued',
          value: 10,
          labels: { smsc: 'local-fake' },
          observed_at: new Date(NOW.getTime() - 280_000).toISOString(),
        },
        {
          metric: 'smsc.queued',
          value: 12,
          labels: { smsc: 'local-fake' },
          observed_at: new Date(NOW.getTime() - 120_000).toISOString(),
        },
        {
          metric: 'smsc.queued',
          value: 9000,
          labels: { smsc: 'local-fake' },
          observed_at: new Date(NOW.getTime() - 5_000).toISOString(),
        },
      ],
    });
    const outcomes = await scheduler.runForTenant('1', NOW);
    expect(outcomes[0].state).toBe('pending');
    expect(outcomes[0].opened).toBe(false);
    expect(inserts(recorded)).toHaveLength(0);
  });

  it('evaluates each bind independently rather than mashing labels together', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule()],
      samples: [
        ...series([6000, 6100, 6200], { smsc: 'local-fake' }),
        ...series([1, 2, 3], { smsc: 'local-fake-b' }),
      ],
    });
    const outcomes = await scheduler.runForTenant('1', NOW);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.labels.smsc === 'local-fake')?.state).toBe('firing');
    expect(outcomes.find((o) => o.labels.smsc === 'local-fake-b')?.state).toBe('inactive');
    expect(inserts(recorded)).toHaveLength(1);
  });

  it('fires immediately for a rule with no sustain window (the console default)', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule({ sustain_seconds: 0, metric: 'smsc.bind.up', operator: 'lt', threshold: '1' })],
      samples: [
        {
          metric: 'smsc.bind.up',
          value: 0,
          labels: { smsc: 'local-fake' },
          observed_at: new Date(NOW.getTime() - 5_000).toISOString(),
        },
      ],
    });
    const outcomes = await scheduler.runForTenant('1', NOW);
    expect(outcomes[0].opened).toBe(true);
    expect(inserts(recorded)).toHaveLength(1);
  });

  it('resolves the open instance once the metric goes clear', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule()],
      samples: series([10, 11, 12], { smsc: 'local-fake' }),
    });
    await scheduler.runForTenant('1', NOW);
    const resolve = recorded.find((entry) => entry.sql.startsWith('UPDATE alert_instances'))!;
    expect(resolve.params[0]).toBe('rule:rule-1:smsc=local-fake');
  });

  it('reports honestly when a rule names a metric nothing produces', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule({ metric: 'invented.metric' })],
      samples: [],
    });
    const outcomes = await scheduler.runForTenant('1', NOW);
    expect(outcomes[0].reason).toContain("no samples for metric 'invented.metric'");
    expect(inserts(recorded)).toHaveLength(0);
  });

  it('suppresses opening (but still evaluates) inside a maintenance window', async () => {
    const { scheduler, recorded } = makeScheduler({
      rules: [rule()],
      samples: series([6000, 6100, 6200, 6400], { smsc: 'local-fake' }),
      windows: [
        {
          id: 'w1',
          name: 'planned',
          starts_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
          ends_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
          scope: { smscs: ['local-fake'] },
        },
      ],
    });
    const outcomes = await scheduler.runForTenant('1', NOW);
    expect(outcomes[0]).toMatchObject({ state: 'firing', suppressed: true, opened: false });
    expect(inserts(recorded)).toHaveLength(0);
  });

  it('skips the tenant when another replica holds the advisory lock', async () => {
    const { scheduler, recorded } = makeScheduler({ rules: [rule()], locked: false });
    expect(await scheduler.runForTenant('1', NOW)).toEqual([]);
    expect(recorded).toHaveLength(1);
  });

  it('isolates a per-tenant failure inside runCycle', async () => {
    const database: any = {
      query: jest.fn(async () => ({ rows: [{ id: '1' }] })),
      tenantTransaction: jest.fn(async () => {
        throw new Error('relation "metric_samples" does not exist');
      }),
    };
    const scheduler = new AlertRuleEvaluatorScheduler(
      database,
      new AlertEvaluatorService(),
      new MaintenanceWindowService(),
    );
    await expect(scheduler.runCycle(NOW)).resolves.toEqual([{ tenantId: '1', outcomes: [] }]);
  });
});

describe('labelKey', () => {
  it('is stable regardless of key order', () => {
    expect(labelKey({ b: '2', a: '1' })).toBe(labelKey({ a: '1', b: '2' }));
    expect(labelKey({})).toBe('');
  });
});
