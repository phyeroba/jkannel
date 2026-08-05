import { BadRequestException } from '@nestjs/common';
import { JobHandlerRegistry } from './job-registry';
import { JobsService } from './jobs.service';

const actor = { tenantId: '1', userId: 'operator' };

/** A registry with one runnable type, so submission has something valid to accept. */
function registryWith(...types: string[]): JobHandlerRegistry {
  const registry = new JobHandlerRegistry();
  for (const type of types)
    registry.register({ type, description: `test handler for ${type}`, handler: async () => ({}) });
  return registry;
}

describe('JobsService', () => {
  it('creates a queued job with idempotency metadata', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            type: 'configuration.deploy',
            status: 'queued',
            idempotency_key: 'idem-key',
          },
        ],
      });
    const service = new JobsService(
      { tenantTransaction: jest.fn((_tenant, work) => work({ query })) } as any,
      registryWith('configuration.deploy'),
    );
    await expect(
      service.create(actor, {
        type: 'configuration.deploy',
        input: { version: 'v1' },
        idempotencyKey: 'idem-key',
      }),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('replays an existing job for the same idempotency key', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ id: 'job-1', type: 'configuration.deploy', status: 'queued' }],
    });
    const service = new JobsService(
      { tenantTransaction: jest.fn((_tenant, work) => work({ query })) } as any,
      registryWith('configuration.deploy'),
    );
    await expect(
      service.create(actor, { type: 'configuration.deploy', idempotencyKey: 'idem-key' }),
    ).resolves.toMatchObject({ replayed: true, id: 'job-1' });
  });

  it('validates job type names', async () => {
    const service = new JobsService(
      { tenantTransaction: jest.fn() } as any,
      registryWith('configuration.deploy'),
    );
    await expect(service.create(actor, { type: 'Bad Job' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * The defect this queue exists to fix: a well-formed type with no executor
   * used to be written to api_jobs and left `queued` forever. It must now be
   * refused at the door, before any row is written.
   */
  it('refuses a job type that no executor is registered for, and writes nothing', async () => {
    const tenantTransaction = jest.fn();
    const service = new JobsService({ tenantTransaction } as any, registryWith('backup.create'));
    await expect(service.create(actor, { type: 'nobody.handles.this' })).rejects.toThrow(
      /No executor is registered for it/,
    );
    expect(tenantTransaction).not.toHaveBeenCalled();
  });

  it('names the supported types when rejecting an unknown one', async () => {
    const service = new JobsService(
      { tenantTransaction: jest.fn() } as any,
      registryWith('backup.create', 'backup.verify'),
    );
    await expect(service.create(actor, { type: 'nope' })).rejects.toThrow(
      /Supported types: backup.create, backup.verify/,
    );
  });

  it("stores the handler's declared max_attempts on the job row", async () => {
    const registry = new JobHandlerRegistry();
    registry.register({
      type: 'once.only',
      description: 'never retried',
      maxAttempts: 1,
      handler: async () => ({}),
    });
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'job-9', max_attempts: 1 }] });
    const service = new JobsService(
      { tenantTransaction: jest.fn((_tenant, work) => work({ query })) } as any,
      registry,
    );
    await service.create(actor, { type: 'once.only' });
    const params = query.mock.calls[0][1];
    expect(params[5]).toBe(1);
  });

  it('rejects a non-object input rather than storing garbage', async () => {
    const service = new JobsService(
      { tenantTransaction: jest.fn() } as any,
      registryWith('backup.create'),
    );
    await expect(
      service.create(actor, { type: 'backup.create', input: 'not-an-object' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exposes the registered types so a caller can discover what POST /jobs accepts', () => {
    const service = new JobsService({} as any, registryWith('backup.create'));
    expect(service.types()).toEqual([
      { type: 'backup.create', description: 'test handler for backup.create', maxAttempts: 3 },
    ]);
  });

  // -------------------------------------------------------------------------
  // Future-dated submission: the queue as a scheduler
  // -------------------------------------------------------------------------

  /**
   * `next_attempt_at` already gates the claim, so stamping it with a future
   * instant is the whole of "run this later". This is the mechanism scheduled
   * sends are built on; if it silently fell back to now(), every scheduled
   * message would go out immediately — the exact defect being fixed.
   */
  it('stamps next_attempt_at with runAt so the job is invisible until it falls due', async () => {
    const runAt = new Date('2030-01-01T09:00:00Z');
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'job-1', status: 'queued' }] });
    const service = new JobsService(
      { tenantTransaction: jest.fn((_tenant, work) => work({ query })) } as any,
      registryWith('message.scheduled.release'),
    );
    await service.create(actor, { type: 'message.scheduled.release', runAt });
    const [sql, params] = query.mock.calls[0];
    // COALESCE keeps "now" as the default for every existing caller.
    expect(sql).toContain('COALESCE($7::timestamptz, now())');
    expect(params[6]).toEqual(runAt);
  });

  it('defaults runAt to now for every caller that does not ask for a delay', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'job-1' }] });
    const service = new JobsService(
      { tenantTransaction: jest.fn((_tenant, work) => work({ query })) } as any,
      registryWith('backup.create'),
    );
    await service.create(actor, { type: 'backup.create' });
    expect(query.mock.calls[0][1][6]).toBeNull();
  });

  it('rejects a runAt that is not an instant rather than running the job immediately', async () => {
    const tenantTransaction = jest.fn();
    const service = new JobsService({ tenantTransaction } as any, registryWith('backup.create'));
    await expect(
      service.create(actor, { type: 'backup.create', runAt: 'next tuesday' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTransaction).not.toHaveBeenCalled();
  });

  /**
   * createOn exists so a domain can enqueue the job in the SAME transaction as
   * the row it acts on — a scheduled message and its releaser are committed
   * together or not at all.
   */
  it('createOn writes through a caller-supplied client, opening no transaction of its own', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'job-1' }] });
    const tenantTransaction = jest.fn();
    const service = new JobsService(
      { tenantTransaction } as any,
      registryWith('message.scheduled.release'),
    );
    await service.createOn({ query } as any, actor, { type: 'message.scheduled.release' });
    expect(tenantTransaction).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('createOn still refuses a type nothing can execute', async () => {
    const query = jest.fn();
    const service = new JobsService({} as any, registryWith('backup.create'));
    await expect(
      service.createOn({ query } as any, actor, { type: 'nobody.handles.this' }),
    ).rejects.toThrow(/No executor is registered for it/);
    expect(query).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Moving and cancelling a queued job
  // -------------------------------------------------------------------------

  it('rescheduleOn moves a queued job and returns nothing once it has been claimed', async () => {
    const service = new JobsService({} as any, registryWith('backup.create'));
    const moved = jest.fn().mockResolvedValue({ rows: [{ id: 'job-1', status: 'queued' }] });
    await expect(
      service.rescheduleOn({ query: moved } as any, 'job-1', new Date('2030-01-01T09:00:00Z')),
    ).resolves.toMatchObject({ id: 'job-1' });
    // The guard is what makes a reschedule lose the race honestly instead of
    // pretending to move a job a worker is already running.
    expect(moved.mock.calls[0][0]).toContain("status='queued'");

    const claimed = jest.fn().mockResolvedValue({ rows: [] });
    await expect(
      service.rescheduleOn({ query: claimed } as any, 'job-1', new Date('2030-01-01T09:00:00Z')),
    ).resolves.toBeUndefined();
  });

  it('cancelOn returns undefined instead of throwing when the job is no longer cancellable', async () => {
    const service = new JobsService({} as any, registryWith('backup.create'));
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(service.cancelOn({ query } as any, 'job-1')).resolves.toBeUndefined();
  });
});
