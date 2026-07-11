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

  it('rejects a genuinely in-flight processing record as concurrent', async () => {
    const database = {
      tenantTransaction: jest.fn((_tenant, work) =>
        work({
          query: jest.fn().mockResolvedValue({
            rows: [
              {
                id: 'abc',
                request_hash: 'hash',
                status: 'processing',
                updated_at: new Date().toISOString(), // fresh -> still in flight
              },
            ],
          }),
        }),
      ),
    };
    const service = new IdempotencyService(database as any);
    await expect(service.begin(actor, 'retry-key', 'POST', '/jobs', 'hash')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('reclaims a stale processing record so a retry can proceed', async () => {
    const query = jest
      .fn()
      // SELECT ... FOR UPDATE -> a processing record last touched long ago
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'abc',
            request_hash: 'hash',
            status: 'processing',
            updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          },
        ],
      })
      // UPDATE ... RETURNING -> the reclaimed, fresh processing record
      .mockResolvedValueOnce({
        rows: [{ id: 'abc', request_hash: 'hash', status: 'processing' }],
      });
    const database = { tenantTransaction: jest.fn((_t, work) => work({ query })) };
    const service = new IdempotencyService(database as any);
    const record = await service.begin(actor, 'retry-key', 'POST', '/jobs', 'hash');
    expect(record.replayed).toBeFalsy();
    expect(record.status).toBe('processing');
    // Second call is the reclaiming UPDATE.
    expect(query.mock.calls[1][0]).toMatch(
      /UPDATE api_idempotency_records SET status='processing'/,
    );
  });

  it('reclaims a failed record immediately regardless of age', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'abc',
            request_hash: 'hash',
            status: 'failed',
            updated_at: new Date().toISOString(), // recent, but failed -> reclaimable
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'abc', request_hash: 'hash', status: 'processing' }] });
    const database = { tenantTransaction: jest.fn((_t, work) => work({ query })) };
    const service = new IdempotencyService(database as any);
    await expect(service.begin(actor, 'retry-key', 'POST', '/jobs', 'hash')).resolves.toMatchObject(
      { status: 'processing' },
    );
  });

  it('fail() marks a processing record failed', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const database = { tenantTransaction: jest.fn((_t, work) => work({ query })) };
    const service = new IdempotencyService(database as any);
    await service.fail(actor, 'abc');
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='failed'"), ['abc']);
  });
});
