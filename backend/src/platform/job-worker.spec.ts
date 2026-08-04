import { backoffMs, JobHandlerRegistry, PermanentJobError } from './job-registry';
import { JobWorker } from './job-worker';
import { FakeJobQueue } from './job-queue.fake';
import { JobsService } from './jobs.service';

function build(registry = new JobHandlerRegistry()) {
  const queue = new FakeJobQueue();
  const database = queue.asDatabase() as any;
  const jobs = new JobsService(database, registry);
  const worker = new JobWorker(database, jobs, registry);
  return { queue, database, jobs, registry, worker };
}

describe('backoffMs', () => {
  it('doubles per attempt and never exceeds the ceiling', () => {
    expect(backoffMs(1, 1_000, 60_000)).toBe(1_000);
    expect(backoffMs(2, 1_000, 60_000)).toBe(2_000);
    expect(backoffMs(3, 1_000, 60_000)).toBe(4_000);
    expect(backoffMs(10, 1_000, 60_000)).toBe(60_000);
    expect(backoffMs(99, 1_000, 60_000)).toBe(60_000);
  });
});

describe('claiming under concurrency', () => {
  /**
   * The property everything else rests on: two workers, one queued job, exactly
   * one claim. FOR UPDATE SKIP LOCKED means the loser skips the row rather than
   * blocking on it, so it comes back empty-handed instead of double-executing.
   */
  it('lets exactly one of two concurrent workers claim a single job', async () => {
    const { queue, jobs } = build();
    queue.seed({ id: 'job-1' });

    const [first, second] = await Promise.all([
      jobs.claimNext('1', 'worker-a'),
      jobs.claimNext('1', 'worker-b'),
    ]);

    const claims = [first, second].filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.id).toBe('job-1');
    expect(queue.find('job-1')!.status).toBe('running');
    expect(queue.find('job-1')!.attempts).toBe(1);
  });

  it('hands two concurrent workers two different jobs', async () => {
    const { queue, jobs } = build();
    queue.seed({ id: 'job-1', created_at: new Date(1).toISOString() });
    queue.seed({ id: 'job-2', created_at: new Date(2).toISOString() });

    const claimed = (
      await Promise.all([jobs.claimNext('1', 'worker-a'), jobs.claimNext('1', 'worker-b')])
    ).filter(Boolean);

    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((job) => job!.id))).toEqual(new Set(['job-1', 'job-2']));
  });

  it('does not claim a job whose backoff has not elapsed', async () => {
    const { queue, jobs } = build();
    queue.seed({ id: 'job-1', next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
    await expect(jobs.claimNext('1', 'worker-a')).resolves.toBeUndefined();
  });
});

describe('JobWorker.execute', () => {
  it('marks a job succeeded and stores the handler result', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({
      type: 'test.ok',
      description: 'succeeds',
      handler: async (context) => {
        await context.progress(50);
        return { ok: true, sawInput: context.input.value };
      },
    });
    const { queue, jobs, worker } = build(registry);
    queue.seed({ id: 'job-1', type: 'test.ok', input: { value: 42 } });

    const job = await jobs.claimNext('1', worker.workerId);
    await expect(worker.execute('1', job!)).resolves.toBe('succeeded');

    const row = queue.find('job-1')!;
    expect(row.status).toBe('succeeded');
    expect(row.progress).toBe(100);
    expect(row.result).toEqual({ ok: true, sawInput: 42 });
    expect(row.error).toBeNull();
  });

  /**
   * The headline defect: a type nobody can run must fail immediately and
   * visibly. Retrying would not conjure a handler, so it goes straight to the
   * dead-letter state with an error naming what is registered.
   */
  it('dead-letters an unregistered job type immediately, without retries', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({ type: 'test.known', description: 'x', handler: async () => ({}) });
    const { queue, jobs, worker } = build(registry);
    queue.seed({ id: 'job-1', type: 'test.orphan', max_attempts: 5 });

    const job = await jobs.claimNext('1', worker.workerId);
    await expect(worker.execute('1', job!)).resolves.toBe('dead_letter');

    const row = queue.find('job-1')!;
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(1); // no retries burned
    expect(row.error).toMatch(/No executor is registered for job type "test.orphan"/);
    expect(row.error).toMatch(/Registered types: test.known/);
    expect(row.dead_lettered_at).not.toBeNull();
  });

  it('requeues a failed job with exponential backoff while attempts remain', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({
      type: 'test.flaky',
      description: 'fails',
      maxAttempts: 3,
      handler: async () => {
        throw new Error('SMSC unreachable');
      },
    });
    const { queue, jobs, worker } = build(registry);
    queue.seed({ id: 'job-1', type: 'test.flaky', max_attempts: 3 });

    const before = Date.now();
    const job = await jobs.claimNext('1', worker.workerId);
    await expect(worker.execute('1', job!)).resolves.toBe('retry');

    const row = queue.find('job-1')!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('SMSC unreachable');
    expect(row.claimed_by).toBeNull();
    // First retry waits the base backoff, not zero.
    const delay = new Date(row.next_attempt_at).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(backoffMs(1) - 50);
  });

  it('dead-letters after the final attempt instead of retrying forever', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({
      type: 'test.doomed',
      description: 'always fails',
      maxAttempts: 2,
      handler: async () => {
        throw new Error('still broken');
      },
    });
    const { queue, jobs, worker } = build(registry);
    queue.seed({ id: 'job-1', type: 'test.doomed', max_attempts: 2 });

    // Attempt 1 -> retry
    let job = await jobs.claimNext('1', worker.workerId);
    expect(await worker.execute('1', job!)).toBe('retry');
    queue.find('job-1')!.next_attempt_at = new Date(0).toISOString();

    // Attempt 2 (== max_attempts) -> dead letter
    job = await jobs.claimNext('1', worker.workerId);
    expect(await worker.execute('1', job!)).toBe('dead_letter');

    const row = queue.find('job-1')!;
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(2);
    expect(row.error).toBe('still broken');
    expect(row.completed_at).not.toBeNull();

    // Terminal: a further drain must not pick it up again.
    await expect(jobs.claimNext('1', worker.workerId)).resolves.toBeUndefined();
  });

  it('dead-letters a PermanentJobError without burning the remaining attempts', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({
      type: 'test.badinput',
      description: 'permanent failure',
      maxAttempts: 5,
      handler: async () => {
        throw new PermanentJobError('input.backupId must be a UUID');
      },
    });
    const { queue, jobs, worker } = build(registry);
    queue.seed({ id: 'job-1', type: 'test.badinput', max_attempts: 5 });

    const job = await jobs.claimNext('1', worker.workerId);
    await expect(worker.execute('1', job!)).resolves.toBe('dead_letter');
    const row = queue.find('job-1')!;
    expect(row.attempts).toBe(1);
    expect(row.error).toBe('input.backupId must be a UUID');
  });

  it('does not report success when the job was cancelled mid-flight', async () => {
    const registry = new JobHandlerRegistry();
    let cancel: () => void = () => undefined;
    registry.register({
      type: 'test.slow',
      description: 'cancelled while running',
      handler: async () => {
        cancel();
        return { done: true };
      },
    });
    const { queue, jobs, worker } = build(registry);
    const seeded = queue.seed({ id: 'job-1', type: 'test.slow' });
    cancel = () => {
      seeded.status = 'cancelled';
    };

    const job = await jobs.claimNext('1', worker.workerId);
    const outcome = await worker.execute('1', job!);
    expect(outcome).not.toBe('succeeded');
    expect(queue.find('job-1')!.status).toBe('cancelled');
  });
});

describe('JobWorker.drainTenant', () => {
  it('drains a batch and reports what actually happened', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({ type: 'test.ok', description: 'ok', handler: async () => ({ ok: 1 }) });
    registry.register({
      type: 'test.bad',
      description: 'bad',
      maxAttempts: 1,
      handler: async () => {
        throw new Error('nope');
      },
    });
    const { queue, worker } = build(registry);
    queue.seed({ id: 'a', type: 'test.ok', created_at: new Date(1).toISOString() });
    queue.seed({ id: 'b', type: 'test.ok', created_at: new Date(2).toISOString() });
    queue.seed({
      id: 'c',
      type: 'test.bad',
      max_attempts: 1,
      created_at: new Date(3).toISOString(),
    });

    const summary = await worker.drainTenant('1');
    expect(summary.claimed).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.deadLettered).toBe(1);
    expect(queue.find('c')!.status).toBe('dead_letter');
  });

  it('requeues a job whose worker died (stale heartbeat) instead of pinning it', async () => {
    const registry = new JobHandlerRegistry();
    registry.register({ type: 'test.ok', description: 'ok', handler: async () => ({}) });
    const { queue, worker } = build(registry);
    queue.seed({
      id: 'stranded',
      type: 'test.ok',
      status: 'running',
      attempts: 1,
      max_attempts: 3,
      heartbeat_at: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const summary = await worker.drainTenant('1');
    expect(summary.requeued).toBe(1);
    // Reaped, then immediately re-claimed and run in the same cycle.
    expect(queue.find('stranded')!.status).toBe('succeeded');
  });

  it('dead-letters a stranded job that has no attempts left', async () => {
    const { queue, worker } = build();
    queue.seed({
      id: 'stranded',
      status: 'running',
      attempts: 3,
      max_attempts: 3,
      heartbeat_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const summary = await worker.drainTenant('1');
    expect(summary.deadLettered).toBe(1);
    expect(queue.find('stranded')!.status).toBe('dead_letter');
  });
});

describe('JobWorker.runCycle', () => {
  it('returns null (never a fabricated summary) when DATABASE_URL is absent', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const { worker } = build();
    await expect(worker.runCycle()).resolves.toBeNull();
    if (original !== undefined) process.env.DATABASE_URL = original;
  });

  it('is disabled under NODE_ENV=test', () => {
    const { worker } = build();
    worker.onModuleInit();
    // No timer was installed, so onModuleDestroy is a no-op and nothing leaks.
    expect(() => worker.onModuleDestroy()).not.toThrow();
  });
});
