import { ConflictException } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

const actor = { tenantId: '1', userId: 'operator' };

describe('IdempotencyService', () => {
  it('hashes equivalent requests deterministically', () => {
    const service = new IdempotencyService({} as any);
    expect(service.hashRequest('post', '/jobs', { type: 'x' })).toBe(
      service.hashRequest('POST', '/jobs', { type: 'x' }),
    );
    expect(service.hashRequest('POST', '/jobs', { type: 'x' })).not.toBe(
      service.hashRequest('POST', '/jobs', { type: 'y' }),
    );
  });

  it('replays a completed record for the same key and hash', async () => {
    const database = {
      tenantTransaction: jest.fn((_tenant, work) =>
        work({
          query: jest.fn().mockResolvedValue({
            rows: [
              {
                id: 'abc',
                request_hash: 'hash',
                status: 'completed',
                response_status: 200,
                response_body: { ok: true },
              },
            ],
          }),
        }),
      ),
    };
    const service = new IdempotencyService(database as any);
    await expect(service.begin(actor, 'retry-key', 'POST', '/jobs', 'hash')).resolves.toMatchObject(
      { replayed: true, response_body: { ok: true } },
    );
  });

  it('rejects key reuse with a different request body', async () => {
    const database = {
      tenantTransaction: jest.fn((_tenant, work) =>
        work({
          query: jest
            .fn()
            .mockResolvedValue({ rows: [{ id: 'abc', request_hash: 'old', status: 'completed' }] }),
        }),
      ),
    };
    const service = new IdempotencyService(database as any);
    await expect(service.begin(actor, 'retry-key', 'POST', '/jobs', 'new')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
