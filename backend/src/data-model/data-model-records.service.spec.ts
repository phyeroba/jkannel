import { NotFoundException } from '@nestjs/common';
import { DataModelRecordsService } from './data-model-records.service';
import { OptimisticLockError } from './optimistic-lock';

const actor = { tenantId: '1', userId: 'u1' };

function makeClient(handlers: (sql: string, params: any[]) => any) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return handlers(sql, params) ?? { rowCount: 0, rows: [] };
  });
  return { query, calls };
}

function serviceWith(client: any) {
  const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
  return new DataModelRecordsService(db);
}

describe('DataModelRecordsService', () => {
  describe('list (soft-delete read path)', () => {
    it('filters to live rows with deleted_at IS NULL', async () => {
      const client = makeClient((sql) => {
        if (sql.startsWith('SELECT') && sql.includes('FROM data_model_records'))
          return { rows: [{ id: 'r1', key: 'a', version: 0 }] };
        return { rows: [] };
      });
      const service = serviceWith(client);
      const rows = await service.list(actor);
      expect(rows).toHaveLength(1);
      const select = client.calls.find((c) => c.sql.startsWith('SELECT'));
      expect(select?.sql).toContain('deleted_at IS NULL');
    });
  });

  describe('update (optimistic locking)', () => {
    it('succeeds when the expected version matches', async () => {
      const client = makeClient((sql) => {
        if (sql.includes('SELECT 1 FROM data_model_records')) return { rows: [{ '?column?': 1 }] };
        if (sql.startsWith('UPDATE data_model_records'))
          return { rowCount: 1, rows: [{ id: 'r1', key: 'a', version: 2 }] };
        return { rows: [] };
      });
      const service = serviceWith(client);
      const row = await service.update(actor, 'r1', 1, { a: 2 });
      expect(row.version).toBe(2);
      const update = client.calls.find((c) => c.sql.startsWith('UPDATE data_model_records'));
      expect(update?.sql).toContain('version = version + 1');
      expect(update?.sql).toContain('WHERE id = $1 AND version = $2');
    });

    it('throws 409 when the version is stale (row changed concurrently)', async () => {
      const client = makeClient((sql) => {
        if (sql.includes('SELECT 1 FROM data_model_records')) return { rows: [{ '?column?': 1 }] };
        if (sql.startsWith('UPDATE data_model_records')) return { rowCount: 0, rows: [] };
        return { rows: [] };
      });
      const service = serviceWith(client);
      await expect(service.update(actor, 'r1', 1, { a: 2 })).rejects.toBeInstanceOf(
        OptimisticLockError,
      );
      // No audit row written on a conflict.
      expect(client.calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(false);
    });

    it('throws 404 when the row does not exist / is already soft-deleted', async () => {
      const client = makeClient(() => ({ rows: [] }));
      const service = serviceWith(client);
      await expect(service.update(actor, 'r1', 1, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove (soft-delete)', () => {
    it('sets deleted_at and bumps version rather than hard-deleting', async () => {
      const client = makeClient((sql) => {
        if (sql.startsWith('UPDATE data_model_records'))
          return { rows: [{ id: 'r1', version: 1 }] };
        return { rows: [] };
      });
      const service = serviceWith(client);
      const removed = await service.remove(actor, 'r1');
      expect(removed).toBe(true);
      const update = client.calls.find((c) => c.sql.startsWith('UPDATE data_model_records'));
      expect(update?.sql).toContain('deleted_at = now()');
      expect(update?.sql).toContain('version = version + 1');
      expect(client.calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
    });

    it('returns false when nothing was removed', async () => {
      const client = makeClient(() => ({ rows: [] }));
      const service = serviceWith(client);
      expect(await service.remove(actor, 'r1')).toBe(false);
    });
  });
});
