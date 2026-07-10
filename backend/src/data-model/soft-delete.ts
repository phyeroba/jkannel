import { PoolClient, QueryResultRow } from 'pg';

/**
 * Soft-delete convention for the `deleted_at timestamptz` (nullable) column
 * added to mutable core tables in migration 027.
 *
 *   - deleted_at IS NULL      => the row is live.
 *   - deleted_at IS NOT NULL  => the row is soft-deleted (hidden from normal
 *                                reads, retained for history / audit).
 *
 * This complements — it does not replace — the pre-existing status-based
 * archiving (e.g. customers.status = 'archived'). Status expresses a business
 * lifecycle; deleted_at expresses "logically removed". A read path that wants
 * only live rows appends {@link LIVE_ONLY}. Soft-deleting is itself a versioned
 * update (see optimistic-lock.ts), so a soft-delete also bumps `version`.
 */

/** SQL predicate selecting only live (non-soft-deleted) rows. */
export const LIVE_ONLY = 'deleted_at IS NULL';

/**
 * Appends the live-only predicate to an existing WHERE fragment, or returns it
 * standalone. `existing` should NOT include the `WHERE` keyword.
 *
 *   whereLive('tenant_id = $1')  => 'tenant_id = $1 AND deleted_at IS NULL'
 *   whereLive()                  => 'deleted_at IS NULL'
 */
export function whereLive(existing?: string): string {
  return existing && existing.trim() ? `${existing} AND ${LIVE_ONLY}` : LIVE_ONLY;
}

/**
 * Soft-deletes a live row by id, bumping its version, and returns the updated
 * row (or undefined if it was not found / already soft-deleted). Callers pass
 * the table name (a trusted constant, never user input) plus the id.
 */
export async function softDeleteById<T extends QueryResultRow>(
  client: PoolClient,
  table: string,
  id: string,
): Promise<T | undefined> {
  const result = await client.query<T>(
    `UPDATE ${table}
        SET deleted_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [id],
  );
  return result.rows[0];
}
