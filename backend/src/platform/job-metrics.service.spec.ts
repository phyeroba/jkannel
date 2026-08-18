import { JobMetricsService } from './job-metrics.service';

const row = (overrides: Record<string, string | null> = {}) => ({
  pending: '0',
  overdue: '0',
  running: '0',
  stuck: '0',
  dead: '0',
  oldest_overdue_seconds: null,
  ...overrides,
});

const database = (answer: () => any) => ({ query: jest.fn(answer) }) as any;
const lines = (text: string) => text.split('\n');
const gauge = (text: string, name: string) =>
  lines(text).find((line) => line.startsWith(`${name} `))?.split(' ')[1];

describe('the job queue finally appears on /metrics', () => {
  it('emits a gauge for every state an alert would need', async () => {
    const service = new JobMetricsService(
      database(async () => ({
        rows: [row({ pending: '120', overdue: '7', running: '3', stuck: '1', dead: '2', oldest_overdue_seconds: '900' })],
      })),
    );
    const text = await service.render();

    expect(gauge(text, 'jkannel_job_queue_up')).toBe('1');
    expect(gauge(text, 'jkannel_jobs_pending')).toBe('120');
    expect(gauge(text, 'jkannel_jobs_overdue')).toBe('7');
    expect(gauge(text, 'jkannel_jobs_running')).toBe('3');
    expect(gauge(text, 'jkannel_jobs_stuck')).toBe('1');
    expect(gauge(text, 'jkannel_jobs_dead_lettered')).toBe('2');
    expect(gauge(text, 'jkannel_job_oldest_overdue_seconds')).toBe('900');
  });

  it('separates depth from overdue work, which is the gauge to alert on', async () => {
    // A thousand jobs scheduled for tomorrow is a healthy queue. Alerting on
    // depth would page someone for a working system.
    const service = new JobMetricsService(
      database(async () => ({ rows: [row({ pending: '1000', overdue: '0' })] })),
    );
    const text = await service.render();
    expect(gauge(text, 'jkannel_jobs_pending')).toBe('1000');
    expect(gauge(text, 'jkannel_jobs_overdue')).toBe('0');
  });

  it('counts stuck jobs separately from running ones', async () => {
    // Folded into `running`, a job whose worker died mid-execution looks like
    // healthy work in progress. That is how a wedged queue stays invisible.
    const service = new JobMetricsService(database(async () => ({ rows: [row({ running: '5', stuck: '5' })] })));
    const text = await service.render();
    expect(gauge(text, 'jkannel_jobs_running')).toBe('5');
    expect(gauge(text, 'jkannel_jobs_stuck')).toBe('5');
  });

  it('defines stuck by the same claim timeout the reaper uses', async () => {
    const previous = process.env.JOB_CLAIM_TIMEOUT_MS;
    process.env.JOB_CLAIM_TIMEOUT_MS = '120000';
    try {
      const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row()] }));
      const text = await new JobMetricsService({ query } as any).render();
      // Passed to the query, not hardcoded — a second, drifting definition of
      // "stuck" would make the gauge disagree with the reaper.
      expect(query.mock.calls[0][1]).toEqual(['120']);
      expect(gauge(text, 'jkannel_job_claim_timeout_seconds')).toBe('120');
    } finally {
      if (previous === undefined) delete process.env.JOB_CLAIM_TIMEOUT_MS;
      else process.env.JOB_CLAIM_TIMEOUT_MS = previous;
    }
  });

  it('falls back to the default timeout rather than passing NaN to an interval cast', async () => {
    const previous = process.env.JOB_CLAIM_TIMEOUT_MS;
    process.env.JOB_CLAIM_TIMEOUT_MS = 'not a number';
    try {
      const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row()] }));
      await new JobMetricsService({ query } as any).render();
      expect(query.mock.calls[0][1]).toEqual(['600']);
    } finally {
      if (previous === undefined) delete process.env.JOB_CLAIM_TIMEOUT_MS;
      else process.env.JOB_CLAIM_TIMEOUT_MS = previous;
    }
  });

  it('reads the TABLE, so a queue backing up because the worker died still reports', async () => {
    // The worker computes these numbers every cycle and throws them away. An
    // in-process counter goes silent in exactly the case that matters.
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row()] }));
    await new JobMetricsService({ query } as any).render();
    expect(String(query.mock.calls[0][0])).toContain('FROM api_jobs');
  });

  it('emits _up 0 rather than failing the whole scrape', async () => {
    const service = new JobMetricsService(
      database(async () => {
        throw new Error('connection terminated');
      }),
    );
    const text = await service.render();
    expect(gauge(text, 'jkannel_job_queue_up')).toBe('0');
    // And emits no other gauge, rather than a misleading zero for each.
    expect(text).not.toContain('jkannel_jobs_overdue');
  });

  it('never emits a negative or non-numeric gauge', async () => {
    const service = new JobMetricsService(
      database(async () => ({ rows: [row({ overdue: '-3', oldest_overdue_seconds: 'NaN' })] })),
    );
    const text = await service.render();
    expect(gauge(text, 'jkannel_jobs_overdue')).toBe('0');
    expect(gauge(text, 'jkannel_job_oldest_overdue_seconds')).toBe('0');
  });

  it('carries HELP and TYPE for every gauge it emits', async () => {
    const service = new JobMetricsService(database(async () => ({ rows: [row()] })));
    const text = await service.render();
    const emitted = lines(text).filter((line) => line.startsWith('jkannel_'));
    for (const line of emitted) {
      const name = line.split(' ')[0];
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(emitted.length).toBeGreaterThan(5);
  });
});
