import { BadRequestException } from '@nestjs/common';
import { JobsService } from './jobs.service';

const actor = { tenantId: '1', userId: 'operator' };

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
    const service = new JobsService({
      tenantTransaction: jest.fn((_tenant, work) => work({ query })),
    } as any);
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
    const service = new JobsService({
      tenantTransaction: jest.fn((_tenant, work) => work({ query })),
    } as any);
    await expect(
      service.create(actor, { type: 'configuration.deploy', idempotencyKey: 'idem-key' }),
    ).resolves.toMatchObject({ replayed: true, id: 'job-1' });
  });

  it('validates job type names', async () => {
    const service = new JobsService({ tenantTransaction: jest.fn() } as any);
    await expect(service.create(actor, { type: 'Bad Job' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
