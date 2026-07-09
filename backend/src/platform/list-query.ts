import { BadRequestException } from '@nestjs/common';

/**
 * Shared grid query support: every list endpoint accepts
 *   search   free-text, matched case-insensitively against defined columns
 *   sort     comma-separated fields, "-" prefix for descending (e.g. "-created_at,name")
 *   filter.<field>=<value> exact-match filters against whitelisted columns
 *   limit / offset pagination (responses carry total row counts)
 *
 * Only whitelisted fields are accepted, and all values travel as bind
 * parameters, so callers can never inject SQL through grid options.
 */
export interface GridDefinition {
  /** SQL expressions searched with ILIKE when ?search= is provided. */
  searchColumns: string[];
  /** API sort field -> SQL expression. */
  sortColumns: Record<string, string>;
  /** API filter field -> SQL expression. */
  filterColumns: Record<string, string>;
  /** Applied when no sort is requested; must be a safe literal. */
  defaultOrderBy: string;
  maxLimit?: number;
  defaultLimit?: number;
}

export interface ParsedListQuery {
  search?: string;
  sort: Array<{ field: string; direction: 'ASC' | 'DESC' }>;
  filters: Array<{ field: string; value: string }>;
  limit: number;
  offset: number;
}

export function parseListQuery(
  raw: Record<string, unknown>,
  grid: GridDefinition,
): ParsedListQuery {
  const search =
    typeof raw.search === 'string' && raw.search.trim() ? raw.search.trim() : undefined;

  const sort: ParsedListQuery['sort'] = [];
  if (typeof raw.sort === 'string' && raw.sort.trim()) {
    for (const token of raw.sort.split(',')) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const direction = trimmed.startsWith('-') ? 'DESC' : 'ASC';
      const field = trimmed.replace(/^-/, '');
      if (!grid.sortColumns[field])
        throw new BadRequestException(
          `Unsupported sort field "${field}" (allowed: ${Object.keys(grid.sortColumns).join(', ')})`,
        );
      sort.push({ field, direction });
    }
  }

  const filters: ParsedListQuery['filters'] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('filter.')) continue;
    const field = key.slice('filter.'.length);
    if (!grid.filterColumns[field])
      throw new BadRequestException(
        `Unsupported filter field "${field}" (allowed: ${Object.keys(grid.filterColumns).join(', ')})`,
      );
    if (typeof value === 'string' && value.trim()) filters.push({ field, value: value.trim() });
  }

  const maxLimit = grid.maxLimit ?? 500;
  const limit = boundedNumber(raw.limit, grid.defaultLimit ?? 50, 1, maxLimit, 'limit');
  const offset = boundedNumber(raw.offset, 0, 0, 5_000_000, 'offset');
  return { search, sort, filters, limit, offset };
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

export interface GridSql {
  /** WHERE fragment beginning with AND (or empty); append after fixed predicates. */
  andWhere: string;
  orderBy: string;
  limitOffset: string;
  params: unknown[];
}

export function buildGridSql(
  query: ParsedListQuery,
  grid: GridDefinition,
  existingParams: unknown[] = [],
): GridSql {
  const params = [...existingParams];
  const clauses: string[] = [];
  if (query.search && grid.searchColumns.length) {
    params.push(`%${query.search}%`);
    const reference = `$${params.length}`;
    clauses.push(
      `(${grid.searchColumns.map((column) => `${column}::text ILIKE ${reference}`).join(' OR ')})`,
    );
  }
  for (const filter of query.filters) {
    params.push(filter.value);
    clauses.push(`${grid.filterColumns[filter.field]}::text = $${params.length}`);
  }
  const orderBy = query.sort.length
    ? `ORDER BY ${query.sort
        .map((entry) => `${grid.sortColumns[entry.field]} ${entry.direction}`)
        .join(', ')}`
    : `ORDER BY ${grid.defaultOrderBy}`;
  params.push(query.limit);
  const limitClause = `LIMIT $${params.length}`;
  params.push(query.offset);
  const offsetClause = `OFFSET $${params.length}`;
  return {
    andWhere: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    orderBy,
    limitOffset: `${limitClause} ${offsetClause}`,
    params,
  };
}
