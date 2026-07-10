import { ConflictException } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';

/**
 * Optimistic concurrency control for the `version integer NOT NULL DEFAULT 0`
 * column added to mutable core tables in migration 027.
 *
 * The update pattern is:
 *
 *   UPDATE <table>
 *      SET <changes>, version = version + 1, updated_at = now()
 *    WHERE id = $id AND version = $expectedVersion [AND deleted_at IS NULL]
 *   RETURNING ...
 *
 * If the row was modified (or removed) since the caller read it, its stored
 * version no longer equals $expectedVersion, zero rows update, and the caller
 * must surface a 409 so the client reloads and retries. {@link OptimisticLockError}
 * is a {@link ConflictException} (HTTP 409).
 */
export class OptimisticLockError extends ConflictException {
  constructor(entity: string) {
    super(`${entity} was modified concurrently; reload and retry`);
  }
}

/**
 * Asserts that a versioned UPDATE affected a row. Pass the driver `rowCount`
 * (or the length of the RETURNING rows). Zero => stale version => 409.
 */
export function assertVersionMatched(rowCount: number | null, entity: string): void {
  if (!rowCount || rowCount <= 0) throw new OptimisticLockError(entity);
}

/**
 * Runs a versioned UPDATE and returns the updated row, throwing
 * {@link OptimisticLockError} when the expected version did not match.
 *
 * `sql` MUST contain `WHERE id = $1 AND version = $2` (or equivalent) and a
 * `RETURNING` clause; `params` supplies the bind values. This is a thin,
 * reusable wrapper so every module applies the same conflict semantics.
 */
export async function versionedUpdate<T extends QueryResultRow>(
  client: PoolClient,
  entity: string,
  sql: string,
  params: unknown[],
): Promise<T> {
  const result = await client.query<T>(sql, params);
  assertVersionMatched(result.rowCount, entity);
  return result.rows[0];
}
