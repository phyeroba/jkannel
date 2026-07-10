import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Actor, audit } from './data-model.common';
import { versionedUpdate } from './optimistic-lock';
import { whereLive, softDeleteById } from './soft-delete';

export interface DataModelRecord {
  id: string;
  key: string;
  value: Record<string, unknown>;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, key, value, version, created_by, created_at, updated_at';

/**
 * Reference implementation that exercises the migration-027 data-model
 * conventions end-to-end against the owned `data_model_records` table:
 *
 *   - Soft-delete: {@link list}/{@link get} read only live rows (deleted_at IS
 *     NULL via {@link whereLive}); {@link remove} sets deleted_at instead of
 *     hard-deleting and bumps version.
 *   - Optimistic locking: {@link update} takes the client's expected version and
 *     uses {@link versionedUpdate}; a stale version yields HTTP 409.
 *
 * Every mutation is audited (which also feeds the audit hash chain).
 */
@Injectable()
export class DataModelRecordsService {
  constructor(private readonly database: DatabaseService) {}

  /** Lists live records for the tenant (soft-deleted rows are excluded). */
  async list(actor: Actor): Promise<DataModelRecord[]> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const rows = (
        await client.query<DataModelRecord>(
          `SELECT ${COLUMNS} FROM data_model_records WHERE ${whereLive()} ORDER BY key`,
        )
      ).rows;
      return rows;
    });
  }

  /** Fetches one live record or throws 404. */
  async get(actor: Actor, id: string): Promise<DataModelRecord> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<DataModelRecord>(
          `SELECT ${COLUMNS} FROM data_model_records WHERE id = $1 AND ${whereLive()}`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Record not found');
      return row;
    });
  }

  /** Creates a record (version starts at 0). */
  async create(
    actor: Actor,
    input: { key: string; value?: Record<string, unknown> },
  ): Promise<DataModelRecord> {
    if (!input.key?.trim()) throw new BadRequestException('key is required');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<DataModelRecord>(
          `INSERT INTO data_model_records (tenant_id, key, value, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING ${COLUMNS}`,
          [actor.tenantId, input.key.trim(), JSON.stringify(input.value ?? {}), actor.userId],
        )
      ).rows[0];
      await audit(client, actor, 'data_model_record.created', 'data_model_record', row.id, row);
      return row;
    });
  }

  /**
   * Optimistically-locked update. `expectedVersion` is the version the client
   * last read; if the row changed since (or was soft-deleted), zero rows match
   * and {@link versionedUpdate} throws a 409.
   */
  async update(
    actor: Actor,
    id: string,
    expectedVersion: number,
    value: Record<string, unknown>,
  ): Promise<DataModelRecord> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
      throw new BadRequestException('expectedVersion must be a non-negative integer');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      // Distinguish "not found" from "version conflict" for a clearer error.
      const exists = (
        await client.query(`SELECT 1 FROM data_model_records WHERE id = $1 AND ${whereLive()}`, [
          id,
        ])
      ).rows[0];
      if (!exists) throw new NotFoundException('Record not found');
      const row = await versionedUpdate<DataModelRecord>(
        client,
        'Record',
        `UPDATE data_model_records
            SET value = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND deleted_at IS NULL
          RETURNING ${COLUMNS}`,
        [id, expectedVersion, JSON.stringify(value)],
      );
      await audit(client, actor, 'data_model_record.updated', 'data_model_record', row.id, row);
      return row;
    });
  }

  /** Soft-deletes a record (sets deleted_at, bumps version). Returns true if removed. */
  async remove(actor: Actor, id: string): Promise<boolean> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const removed = await softDeleteById<DataModelRecord>(client, 'data_model_records', id);
      if (removed)
        await audit(client, actor, 'data_model_record.deleted', 'data_model_record', id, null);
      return Boolean(removed);
    });
  }
}
