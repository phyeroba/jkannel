import { BadRequestException } from '@nestjs/common';
import { SqlboxListOptions, isKnownStatusToken } from '../engine/kamex-sqlbox.repository';

/**
 * THE message filter contract, in one place.
 *
 * The grid (`GET /messages`) and both exports (`export.csv`, `export.pdf`) used
 * to each assemble their own option object, and the CSV export simply left the
 * status filter out. An operator who filtered the grid to "failed" and clicked
 * Export got a file containing everything — silently the wrong rows, which is
 * strictly worse than an export that refuses.
 *
 * Every message endpoint now calls {@link parseMessageFilters}, so "the export
 * matches the screen" is a structural property rather than a promise: there is
 * only one parser, and a filter it cannot honour is a 400 for all three routes
 * rather than a quietly broader result set for one of them.
 *
 * Unknown values are rejected for the same reason. A typo'd `status=faield` used
 * to be dropped on the floor and return every message; it now names the problem.
 */

export interface MessageFilterLimits {
  /** Applied when the caller supplies no `limit`. */
  defaultLimit: number;
  /** Hard ceiling; a larger `limit` is a 400, never a silent truncation. */
  maxLimit: number;
}

/** Exactly the filters both the grid and the exports honour. */
export type MessageFilters = Pick<
  SqlboxListOptions,
  | 'limit'
  | 'cursor'
  | 'query'
  | 'status'
  | 'deliveryStatus'
  | 'smscId'
  | 'direction'
  | 'fromEpoch'
  | 'toEpoch'
>;

/** The query parameters this parser reads, for documentation and error text. */
export const MESSAGE_FILTER_PARAMS = [
  'limit',
  'cursor',
  'query',
  'status',
  'deliveryStatus',
  'smscId',
  'direction',
  'from',
  'to',
] as const;

const DIRECTIONS = ['MO', 'MT', 'DLR'] as const;

/**
 * ISO 8601 calendar date, optionally with a time and a UTC offset.
 * Deliberately strict: `Date.parse` accepts a great deal of non-ISO input
 * (`"March 3"`, `"2026/08/04"`) and quietly resolves it, which would make a
 * mistyped range look like it worked.
 */
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== '';

/**
 * ISO 8601 -> epoch seconds. A value with no offset is read as UTC (the engine
 * stores UTC epochs, and letting the server's local zone decide would make the
 * same request mean different things on different hosts).
 */
export function parseInstant(value: unknown, name: string): number | undefined {
  if (!present(value)) return undefined;
  if (typeof value !== 'string')
    throw new BadRequestException(
      `${name} must be an ISO 8601 date-time string (e.g. 2026-08-04T09:00:00Z)`,
    );
  const raw = value.trim();
  const match = ISO_8601.exec(raw);
  if (!match)
    throw new BadRequestException(
      `${name} must be an ISO 8601 date-time (e.g. 2026-08-04T09:00:00Z or 2026-08-04); received "${raw}"`,
    );
  // A date-only value is UTC midnight by specification. A date-TIME with no
  // offset is pinned to UTC here so the same request cannot mean two different
  // instants on two hosts in different zones.
  const hasTime = match[4] !== undefined;
  const spaced = raw.replace(' ', 'T');
  const normalized = !hasTime || match[8] ? spaced : `${spaced}Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed))
    throw new BadRequestException(`${name} is not a real date-time: "${raw}"`);
  // Date.parse accepts 2026-02-31 by rolling over; reject that rather than
  // answering for a day the caller did not ask about.
  const rolled = new Date(parsed);
  if (
    rolled.getUTCFullYear() !== Number(match[1]) ||
    rolled.getUTCMonth() + 1 !== Number(match[2]) ||
    rolled.getUTCDate() !== Number(match[3])
  )
    throw new BadRequestException(`${name} is not a real calendar date: "${raw}"`);
  return Math.floor(parsed / 1000);
}

function parseBoundedInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!present(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

/**
 * Validates a status expression against the vocabulary the repository actually
 * understands, so an unrecognised token is a 400 rather than a filter that is
 * dropped and an answer that is too broad.
 */
function parseStatusExpression(value: unknown, name: string): string | undefined {
  if (!present(value)) return undefined;
  const tokens = (Array.isArray(value) ? value : String(value).split(','))
    .map((token) => String(token).trim())
    .filter(Boolean);
  if (!tokens.length) return undefined;
  const unsupported = tokens.filter((token) => !isKnownStatusToken(token));
  if (unsupported.length)
    throw new BadRequestException(
      `${name} contains unsupported value(s): ${unsupported.join(', ')}. ` +
        'Use sent, dlr/delivery_report, delivered, failed, rejected, buffered, accepted, ' +
        'pending, unknown, or the groups resendable / in-flight.',
    );
  return tokens.join(',');
}

/**
 * Parses and validates the message filter set. Throws a 400 naming the exact
 * problem for anything it cannot honour; never returns a partially applied
 * filter set.
 */
export function parseMessageFilters(q: any = {}, limits: MessageFilterLimits): MessageFilters {
  const query = q ?? {};

  const fromEpoch = parseInstant(query.from, 'from');
  const toEpoch = parseInstant(query.to, 'to');
  if (fromEpoch !== undefined && toEpoch !== undefined && fromEpoch > toEpoch)
    throw new BadRequestException(
      `from must not be after to (from="${String(query.from).trim()}", to="${String(query.to).trim()}")`,
    );

  let direction: 'MO' | 'MT' | 'DLR' | undefined;
  if (present(query.direction)) {
    const candidate = String(query.direction).trim().toUpperCase();
    if (!(DIRECTIONS as readonly string[]).includes(candidate))
      throw new BadRequestException(
        `direction must be one of ${DIRECTIONS.join(', ')}; received "${String(query.direction).trim()}"`,
      );
    direction = candidate as 'MO' | 'MT' | 'DLR';
  }

  return {
    limit: parseBoundedInt(query.limit, 'limit', 1, limits.maxLimit, limits.defaultLimit),
    cursor: present(query.cursor)
      ? parseBoundedInt(query.cursor, 'cursor', 1, Number.MAX_SAFE_INTEGER, 0)
      : undefined,
    query: present(query.query) ? String(query.query).trim() : undefined,
    status: parseStatusExpression(query.status, 'status'),
    deliveryStatus: parseStatusExpression(query.deliveryStatus, 'deliveryStatus'),
    smscId: present(query.smscId) ? String(query.smscId).trim() : undefined,
    direction,
    fromEpoch,
    toEpoch,
  };
}

/** Human-readable rendering of an applied filter set, for an export's header. */
export function describeMessageFilters(filters: MessageFilters): string | undefined {
  const parts: string[] = [];
  if (filters.query) parts.push(`query="${filters.query}"`);
  if (filters.smscId) parts.push(`smscId=${filters.smscId}`);
  if (filters.direction) parts.push(`direction=${filters.direction}`);
  if (filters.status) parts.push(`status=${filters.status}`);
  if (filters.deliveryStatus) parts.push(`deliveryStatus=${String(filters.deliveryStatus)}`);
  if (filters.fromEpoch !== undefined)
    parts.push(`from=${new Date(filters.fromEpoch * 1000).toISOString()}`);
  if (filters.toEpoch !== undefined)
    parts.push(`to=${new Date(filters.toEpoch * 1000).toISOString()}`);
  return parts.length ? parts.join(', ') : undefined;
}
