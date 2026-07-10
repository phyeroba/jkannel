import { BadRequestException } from '@nestjs/common';
import { GridDefinition } from './list-query';

/**
 * Opt-in keyset (cursor) pagination that layers additively on top of the shared
 * grid helper without touching the existing offset contract.
 *
 * A cursor is a base64url-encoded JSON payload { v, i } where:
 *   v = the value of the sort key on the boundary row (the last row already seen)
 *   i = that row's id, used as a deterministic tiebreaker so rows sharing the
 *       same sort value still have one total order and are never skipped/duplicated.
 *
 * The keyset predicate is the expanded (not SQL row-value) form so it behaves
 * predictably across drivers:
 *   ASC : sortExpr > v OR (sortExpr = v AND idExpr > i)
 *   DESC: sortExpr < v OR (sortExpr = v AND idExpr < i)
 *
 * Limitation: the sort key is assumed non-null (created_at, name, numeric ids).
 * NULL sort values are not ordered by this helper; endpoints needing nullable
 * sort keys should keep using offset pagination.
 */

export type CursorValue = string | number | boolean | null;

export interface CursorPayload {
  /** Sort-key value of the boundary row. */
  v: CursorValue;
  /** Id of the boundary row (tiebreaker). */
  i: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Malformed cursor');
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new BadRequestException('Malformed cursor');
  const record = parsed as Record<string, unknown>;
  const { v, i } = record;
  if (typeof i !== 'string' || !i.length) throw new BadRequestException('Malformed cursor');
  if (v !== null && !['string', 'number', 'boolean'].includes(typeof v))
    throw new BadRequestException('Malformed cursor');
  if (!('v' in record)) throw new BadRequestException('Malformed cursor');
  return { v: v as CursorValue, i };
}

export interface CursorParseOptions {
  grid: GridDefinition;
  /** Whitelisted API sort field used for the keyset when ?sort is omitted. */
  defaultSortField: string;
  defaultDirection?: 'ASC' | 'DESC';
  maxLimit?: number;
  defaultLimit?: number;
}

export interface ParsedCursorQuery {
  /** API sort field name. */
  field: string;
  /** Whitelisted SQL expression for the sort key. */
  sqlExpr: string;
  direction: 'ASC' | 'DESC';
  limit: number;
  after?: CursorPayload;
}

/** True when the caller opted into cursor pagination (?cursor present, or ?paginate=cursor). */
export function usesCursor(raw: Record<string, unknown>): boolean {
  return (
    (typeof raw.cursor === 'string' && raw.cursor.trim().length > 0) || raw.paginate === 'cursor'
  );
}

export function parseCursorQuery(
  raw: Record<string, unknown>,
  options: CursorParseOptions,
): ParsedCursorQuery {
  const { grid } = options;
  let field = options.defaultSortField;
  let direction: 'ASC' | 'DESC' = options.defaultDirection ?? 'ASC';

  if (typeof raw.sort === 'string' && raw.sort.trim()) {
    // Keyset pagination orders by a single key; use the first requested token.
    const token = raw.sort.split(',')[0].trim();
    direction = token.startsWith('-') ? 'DESC' : 'ASC';
    field = token.replace(/^-/, '');
  }

  const sqlExpr = grid.sortColumns[field];
  if (!sqlExpr)
    throw new BadRequestException(
      `Unsupported sort field "${field}" (allowed: ${Object.keys(grid.sortColumns).join(', ')})`,
    );

  const maxLimit = options.maxLimit ?? grid.maxLimit ?? 500;
  const defaultLimit = options.defaultLimit ?? grid.defaultLimit ?? 50;
  const limit = boundedLimit(raw.limit, defaultLimit, maxLimit);

  let after: CursorPayload | undefined;
  if (typeof raw.cursor === 'string' && raw.cursor.trim()) after = decodeCursor(raw.cursor.trim());

  return { field, sqlExpr, direction, limit, after };
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max)
    throw new BadRequestException(`limit must be an integer between 1 and ${max}`);
  return parsed;
}

export interface CursorSql {
  /** WHERE fragment beginning with " AND " (or empty); append after fixed predicates. */
  andWhere: string;
  orderBy: string;
  /** LIMIT clause; fetches one extra row so the caller can detect a next page. */
  limit: string;
  params: unknown[];
  /** The over-fetch count used in the LIMIT clause (query.limit + 1). */
  fetchLimit: number;
}

/**
 * Builds the keyset WHERE/ORDER BY/LIMIT fragments. `idExpr` is the SQL
 * expression for the tiebreaker id column (e.g. "id" or "s.id"). Over-fetches
 * one row so {@link buildCursorPage} can compute nextCursor.
 */
export function buildCursorSql(
  query: ParsedCursorQuery,
  idExpr: string,
  existingParams: unknown[] = [],
): CursorSql {
  const params = [...existingParams];
  const clauses: string[] = [];
  if (query.after) {
    const cmp = query.direction === 'DESC' ? '<' : '>';
    params.push(query.after.v);
    const valueRef = `$${params.length}`;
    params.push(query.after.i);
    const idRef = `$${params.length}`;
    clauses.push(
      `(${query.sqlExpr} ${cmp} ${valueRef} OR (${query.sqlExpr} = ${valueRef} AND ${idExpr} ${cmp} ${idRef}))`,
    );
  }
  const fetchLimit = query.limit + 1;
  params.push(fetchLimit);
  return {
    andWhere: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    orderBy: `ORDER BY ${query.sqlExpr} ${query.direction}, ${idExpr} ${query.direction}`,
    limit: `LIMIT $${params.length}`,
    params,
    fetchLimit,
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}

/**
 * Trims an over-fetched row set to the page size and computes nextCursor from
 * the last returned row. `select` maps a row to its sort value and id.
 */
export function buildCursorPage<T>(
  rows: T[],
  query: ParsedCursorQuery,
  select: { sortVal: (row: T) => CursorValue; id: (row: T) => string },
): CursorPage<T> {
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ v: select.sortVal(last), i: select.id(last) }) : null;
  return { items, nextCursor, limit: query.limit };
}
