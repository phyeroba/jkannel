import { BadRequestException } from '@nestjs/common';
import { GridDefinition } from './list-query';

/**
 * Optional ?fields=a,b,c response projection. Additive and safe by default:
 * when no fields are requested the full object is returned unchanged.
 *
 * The requested fields are whitelist-validated. Consistent with parseListQuery's
 * treatment of unknown sort/filter fields, an unknown field is rejected with a
 * 400 by default (strict). Pass { strict: false } to silently drop unknown
 * fields instead (they are never projected either way, so nothing can leak).
 */

export interface FieldSelectionOptions {
  /** Reject unknown fields with a 400 (default true). When false, ignore them. */
  strict?: boolean;
}

/**
 * Parses ?fields into a validated, de-duplicated, order-preserving list.
 * Returns null when no projection was requested (=> return all fields).
 */
export function parseFieldSelection(
  raw: unknown,
  allowed: readonly string[],
  options: FieldSelectionOptions = {},
): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const strict = options.strict ?? true;
  const allowedSet = new Set(allowed);
  const requested = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (!requested.length) return null;

  const selected: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const field of requested) {
    if (!allowedSet.has(field)) {
      unknown.push(field);
      continue;
    }
    if (!seen.has(field)) {
      seen.add(field);
      selected.push(field);
    }
  }
  if (unknown.length && strict)
    throw new BadRequestException(
      `Unsupported field(s) "${unknown.join(', ')}" (allowed: ${[...allowedSet].join(', ')})`,
    );
  // Every requested field was unknown and dropped (non-strict): fall back to all.
  return selected.length ? selected : null;
}

/** Trims one object to the selected fields. `null` selection returns it unchanged. */
export function projectFields<T extends object>(obj: T, fields: string[] | null): Partial<T> {
  if (!fields) return obj;
  const source = obj as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) projected[field] = source[field];
  }
  return projected as Partial<T>;
}

/** Trims each object in a list to the selected fields. */
export function projectItems<T extends object>(
  items: T[],
  fields: string[] | null,
): Array<Partial<T>> {
  if (!fields) return items;
  return items.map((item) => projectFields(item, fields));
}

/**
 * Convenience: the selectable field whitelist derived from a grid definition
 * (the union of its sort and filter field names). Useful where the returned
 * object keys line up with the grid's API field names; endpoints whose output
 * columns differ should pass their own explicit allow-list instead.
 */
export function gridSelectableFields(grid: GridDefinition): string[] {
  return [...new Set([...Object.keys(grid.sortColumns), ...Object.keys(grid.filterColumns)])];
}
