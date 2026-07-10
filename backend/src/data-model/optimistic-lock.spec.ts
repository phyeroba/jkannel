import { ConflictException } from '@nestjs/common';
import { OptimisticLockError, assertVersionMatched, versionedUpdate } from './optimistic-lock';

describe('optimistic-lock', () => {
  describe('assertVersionMatched', () => {
    it('passes when a row was updated', () => {
      expect(() => assertVersionMatched(1, 'Widget')).not.toThrow();
    });

    it('throws a 409 ConflictException when zero rows matched (stale version)', () => {
      expect(() => assertVersionMatched(0, 'Widget')).toThrow(OptimisticLockError);
      expect(() => assertVersionMatched(0, 'Widget')).toThrow(ConflictException);
    });

    it('throws when rowCount is null', () => {
      expect(() => assertVersionMatched(null, 'Widget')).toThrow(OptimisticLockError);
    });
  });

  describe('versionedUpdate', () => {
    const sql = 'UPDATE t SET v=$3, version=version+1 WHERE id=$1 AND version=$2 RETURNING *';

    it('returns the updated row when the expected version matched', async () => {
      const client: any = {
        query: jest.fn(async () => ({ rowCount: 1, rows: [{ id: 'a', version: 2 }] })),
      };
      const row = await versionedUpdate<any>(client, 'Widget', sql, ['a', 1, 'x']);
      expect(row).toEqual({ id: 'a', version: 2 });
      expect(client.query).toHaveBeenCalledWith(sql, ['a', 1, 'x']);
    });

    it('throws OptimisticLockError when the expected version was stale', async () => {
      const client: any = { query: jest.fn(async () => ({ rowCount: 0, rows: [] })) };
      await expect(versionedUpdate(client, 'Widget', sql, ['a', 1, 'x'])).rejects.toBeInstanceOf(
        OptimisticLockError,
      );
    });
  });
});
