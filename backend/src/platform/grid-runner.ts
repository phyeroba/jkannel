import { BadRequestException } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import {
  buildCursorPage,
  buildCursorSql,
  CursorValue,
  parseCursorQuery,
  usesCursor,
} from './cursor';
import { parseFieldSelection, projectItems } from './field-selection';
import { buildGridSql, buildGridWhere, GridDefinition, parseListQuery } from './list-query';

/**
 * One grid runner for every list endpoint.
 *
 * The platform already had three good primitives that almost nothing used:
 * `list-query.ts` (search/sort/filter/limit/offset), `cursor.ts` (keyset
 * pagination) and `field-selection.ts` (`?fields=` projection). Each repository
 * hand-rolled the first and ignored the other two, so cursor pagination and
 * field projection reached 1 of 18 grids.
 *
 * `runGrid` composes all three behind the shape those hand-rolled helpers
 * already had, so a repository adopts every primitive by delegating its private
 * `grid()` body to this function — one line, no controller change, no route
 * change, and the existing `{items,total,limit,offset}` contract preserved.
 *
 * Behaviour:
 *   - default: offset pagination, exactly as before (`total` from a window count)
 *   - `?cursor=<c>` or `?paginate=cursor`: keyset pagination, `nextCursor` set,
 *     `total` null (a keyset page deliberately does not pay for a count)
 *   - `?fields=a,b`: whitelist-validated projection applied to every row
 *
 * Cursor pagination is only offered when the caller supplies `idExpr` (the SQL
 * expression for the tiebreaker id). Asking for a cursor on a grid that has not
 * opted in is a 400 rather than a silent fall back to offset paging — the
 * caller would otherwise page incorrectly and never know.
 *
 * ---------------------------------------------------------------------------
 * ADOPTION STATUS (G18)
 * ---------------------------------------------------------------------------
 * Adopted:
 *   backup-dr/backup-dr.repository.ts      2 grids (backups, schedules)
 *   platform/jobs.service.ts               1 grid  (jobs)
 *   reporting-depth/report-definitions.repository.ts  1 grid — pre-existing
 *                                          bespoke cursor implementation, works
 *                                          but does not route through here yet.
 *
 * Remaining, each a ONE-LINE change: replace the body of the repository's
 * private `grid()` with a delegation to `runGrid`, exactly as
 * backup-dr.repository.ts:149 now does. Every call site of that private method
 * gains cursor + ?fields= with no further edit.
 *
 *   console/console.repository.ts:187            -> 8 grids, 10 call sites
 *     (alerts, alertRules, users, invitations, configurations, auditEvents,
 *      notifications, reportSnapshots). It already takes a
 *      { select, from, where, params } body, which is the GridSource shape —
 *      pass it straight through and add `{ idExpr: 'id' }` (or the aliased id
 *      for the joined grids, e.g. 'a.id' for alerts).
 *   platform-console/platform-console.repository.ts:86 -> 3 grids
 *     (apiGatewayClients, plugins, backups). Its (baseWhere, baseParams)
 *     arguments map onto GridSource.where / GridSource.params.
 *   customers/customers.repository.ts:106        -> 1 grid (customers)
 *   routing-depth/routing-depth.repository.ts:273 -> 1 grid (routes). Inlined
 *     rather than factored into a private grid(); wrap the SELECT in a
 *     GridSource and keep the post-query target hydration on `page.items`.
 *   configuration-depth/config-templates.repository.ts:190 -> 1 grid
 *     (templates). Also inlined; keep the ensureBuiltins() call before runGrid.
 *
 * Not converted here because those modules are owned by other work in flight.
 * ---------------------------------------------------------------------------
 */

export interface GridSource {
  /** e.g. "SELECT a, b, c" — no trailing comma. */
  select: string;
  /** e.g. "FROM widgets w JOIN owners o ON ..." */
  from: string;
  /** Fixed predicate beginning with "WHERE ..." applied before grid filters. */
  where?: string;
  /** Bind values already consumed by `where`; grid params continue after them. */
  params?: unknown[];
}

export interface GridRunnerOptions {
  /**
   * SQL expression for the row id used as the keyset tiebreaker (e.g. "id" or
   * "w.id"). Supplying it enables `?cursor=`/`?paginate=cursor` on this grid.
   */
  idExpr?: string;
  /** Keyset sort used when the caller does not pass ?sort. */
  cursorDefaultSort?: { field: string; direction?: 'ASC' | 'DESC' };
  /**
   * Whitelist for `?fields=`. Defaults to the plain column names discoverable
   * from the grid definition (see {@link defaultSelectableFields}).
   */
  selectableFields?: readonly string[];
  /** Reject unknown ?fields with 400 (default true, matching parseFieldSelection). */
  strictFields?: boolean;
}

/**
 * A single response shape for both pagination modes, so a client never has to
 * branch on which one it got and no field silently changes meaning:
 *   offset mode -> total/offset are numbers, nextCursor is null
 *   cursor mode -> total/offset are null, nextCursor is a string or null
 */
export interface GridResult<T> {
  items: Array<Partial<T>>;
  total: number | null;
  limit: number;
  offset: number | null;
  nextCursor: string | null;
  pagination: 'offset' | 'cursor';
}

/** Executes SQL and returns rows. Usually `(sql, params) => client.query(...).then(r => r.rows)`. */
export type GridExecutor = <R extends QueryResultRow>(
  sql: string,
  params: unknown[],
) => Promise<R[]>;

const PLAIN_COLUMN = /^[a-z_][a-z0-9_]*$/;

/**
 * The `?fields=` whitelist inferred from a grid definition: every sort/filter/
 * search expression that is a plain (optionally alias-qualified) column name,
 * reduced to the key the row will actually carry, plus `id`.
 *
 * Inferring from SQL expressions rather than from the API field names matters:
 * grid definitions map camelCase API names (`startedAt`) to snake_case columns
 * (`started_at`), and the projection runs against row keys.
 */
export function defaultSelectableFields(grid: GridDefinition): string[] {
  const expressions = [
    ...Object.values(grid.sortColumns),
    ...Object.values(grid.filterColumns),
    ...grid.searchColumns,
  ];
  const fields = new Set<string>(['id']);
  for (const expression of expressions) {
    const bare = expression.trim().split('.').pop() ?? '';
    if (PLAIN_COLUMN.test(bare)) fields.add(bare);
  }
  return [...fields];
}

export async function runGrid<T extends QueryResultRow>(
  source: GridSource,
  grid: GridDefinition,
  rawQuery: Record<string, unknown>,
  execute: GridExecutor,
  options: GridRunnerOptions = {},
): Promise<GridResult<T>> {
  const fields = parseFieldSelection(
    rawQuery.fields,
    options.selectableFields ?? defaultSelectableFields(grid),
    { strict: options.strictFields ?? true },
  );

  if (usesCursor(rawQuery)) {
    if (!options.idExpr)
      throw new BadRequestException(
        'Cursor pagination is not available on this endpoint; use limit/offset instead.',
      );
    return runCursorGrid<T>(source, grid, rawQuery, execute, options, fields);
  }
  return runOffsetGrid<T>(source, grid, rawQuery, execute, fields);
}

async function runOffsetGrid<T extends QueryResultRow>(
  source: GridSource,
  grid: GridDefinition,
  rawQuery: Record<string, unknown>,
  execute: GridExecutor,
  fields: string[] | null,
): Promise<GridResult<T>> {
  const parsed = parseListQuery(rawQuery, grid);
  const fragments = buildGridSql(parsed, grid, source.params ?? []);
  const where = composeWhere(source.where, fragments.andWhere);
  const sql = `${source.select}, count(*) OVER() AS __total ${source.from} ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
  const rows = await execute<T & { __total: string }>(sql, fragments.params);
  const total = rows.length ? Number(rows[0].__total) : 0;
  const items = rows.map(({ __total, ...row }) => row as unknown as T);
  return {
    items: projectItems(items, fields),
    total,
    limit: parsed.limit,
    offset: parsed.offset,
    nextCursor: null,
    pagination: 'offset',
  };
}

async function runCursorGrid<T extends QueryResultRow>(
  source: GridSource,
  grid: GridDefinition,
  rawQuery: Record<string, unknown>,
  execute: GridExecutor,
  options: GridRunnerOptions,
  fields: string[] | null,
): Promise<GridResult<T>> {
  const idExpr = options.idExpr!;
  const parsed = parseCursorQuery(rawQuery, {
    grid,
    defaultSortField: options.cursorDefaultSort?.field ?? firstSortField(grid),
    defaultDirection: options.cursorDefaultSort?.direction ?? 'DESC',
  });
  // Grid search/filter predicates are reused verbatim so a cursor page filters
  // identically to an offset page. buildGridWhere emits the predicate only (no
  // ORDER BY / LIMIT / OFFSET), which is exactly what keyset paging needs.
  const listParsed = parseListQuery({ ...rawQuery, sort: undefined, limit: undefined }, grid);
  const filter = buildGridWhere(listParsed, grid, source.params ?? []);
  const keyset = buildCursorSql(parsed, idExpr, filter.params);

  const where = composeWhere(source.where, `${filter.andWhere}${keyset.andWhere}`);
  // Sort value and id travel as dedicated aliases so the cursor can be computed
  // for any sort expression, not only for plain columns present in the SELECT.
  const sql =
    `${source.select}, ${parsed.sqlExpr} AS __cursor_sort, ${idExpr} AS __cursor_id ` +
    `${source.from} ${where} ${keyset.orderBy} ${keyset.limit}`;

  const rows = await execute<T & { __cursor_sort: CursorValue; __cursor_id: string }>(
    sql,
    keyset.params,
  );
  const page = buildCursorPage(rows, parsed, {
    sortVal: (row) => normaliseCursorValue(row.__cursor_sort),
    id: (row) => String(row.__cursor_id),
  });
  const items = page.items.map(({ __cursor_sort, __cursor_id, ...row }) => row as unknown as T);
  return {
    items: projectItems(items, fields),
    total: null,
    limit: page.limit,
    offset: null,
    nextCursor: page.nextCursor,
    pagination: 'cursor',
  };
}

/** Dates come back from pg as Date objects; a cursor must round-trip as JSON. */
function normaliseCursorValue(value: unknown): CursorValue {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return String(value);
}

function composeWhere(fixed: string | undefined, andWhere: string): string {
  if (fixed) return `${fixed}${andWhere}`;
  return andWhere ? `WHERE ${andWhere.slice(' AND '.length)}` : '';
}

function firstSortField(grid: GridDefinition): string {
  const first = Object.keys(grid.sortColumns)[0];
  if (!first)
    throw new BadRequestException('This grid defines no sortable field, so it cannot be cursored.');
  return first;
}
