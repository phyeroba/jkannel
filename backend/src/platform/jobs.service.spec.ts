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
});
