import {
  BadRequestException,
  ConflictException,
  PreconditionFailedException,
} from '@nestjs/common';

/**
 * HTTP optimistic concurrency over the `version integer NOT NULL DEFAULT 0`
 * column added by migration 027.
 *
 * `data-model/optimistic-lock.ts` already implements the database half of this
 * (a versioned UPDATE that 409s when the row moved). What was missing is the
 * HTTP half: the version was only ever exposed as a body field, so a client had
 * no standard way to say "update this only if it is still what I read".
 *
 * The contract:
 *   - a versioned read sends `ETag: "<version>"` (strong; the version is an
 *     exact identity, not a semantic equivalence)
 *   - a mutation may send `If-Match: "<version>"`, `If-Match: *`, or a
 *     comma-separated list of entity tags
 *   - a mismatch is 412 Precondition Failed; `If-Match` on a resource with no
 *     version column is a 400 rather than a silently ignored header, because
 *     silently ignoring a concurrency guard is exactly the failure mode this
 *     exists to prevent
 *   - the header is optional, so every existing client keeps working unchanged
 */

export interface VersionedRow {
  version?: number | string | null;
}

/** The strong entity tag for a row's version, e.g. `"7"`. */
export function versionEtag(version: number | string): string {
  return `"${String(version)}"`;
}

/** ETag for a row, or null when the row carries no version. */
export function rowEtag(row: VersionedRow | null | undefined): string | null {
  if (!row || row.version === undefined || row.version === null) return null;
  return versionEtag(row.version);
}

/** Splits an If-Match / If-None-Match header into its entity tags. */
export function parseEntityTags(header: string): string[] {
  return header
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function normalise(tag: string): string {
  // Accept weak tags on input; compare on the opaque value only.
  const withoutWeak = tag.startsWith('W/') ? tag.slice(2) : tag;
  return withoutWeak.replace(/^"|"$/g, '');
}

/**
 * Parses `If-Match` into the version the caller believes is current.
 * Returns undefined when the header is absent (no precondition requested) and
 * null for `*` (any existing version satisfies it).
 */
export function parseIfMatch(header: string | string[] | undefined): number | null | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw.trim()) return undefined;
  const tags = parseEntityTags(raw);
  if (tags.some((tag) => tag === '*')) return null;
  if (tags.length !== 1)
    throw new BadRequestException(
      'If-Match must carry exactly one entity tag (or *) for a versioned resource',
    );
  const value = normalise(tags[0]);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new BadRequestException(
      `Malformed If-Match entity tag "${tags[0]}": expected the resource version, e.g. If-Match: "3"`,
    );
  return parsed;
}

/**
 * Enforces `If-Match` against the row the caller is about to mutate.
 * Returns the version the update must assert (or undefined when no
 * precondition was supplied and the caller should use its own default).
 */
export function assertIfMatch(
  header: string | string[] | undefined,
  row: VersionedRow | null | undefined,
  entity = 'Resource',
): number | undefined {
  const expected = parseIfMatch(header);
  if (expected === undefined) return undefined;
  if (!row) throw new PreconditionFailedException(`${entity} no longer exists`);
  if (row.version === undefined || row.version === null)
    throw new BadRequestException(
      `${entity} does not support If-Match: it carries no version column`,
    );
  const current = Number(row.version);
  if (expected === null) return current; // If-Match: * — any current version
  if (current !== expected)
    throw new PreconditionFailedException(
      `${entity} has version ${current}, not ${expected}; reload and retry`,
    );
  return current;
}

/**
 * Sets `ETag` on a response for a versioned row. Safe to call with any object;
 * a row without a version simply gets no header.
 */
export function setEtagHeader(
  response: { setHeader?: (name: string, value: string) => void } | undefined,
  row: VersionedRow | null | undefined,
): void {
  const tag = rowEtag(row);
  if (tag && response?.setHeader) response.setHeader('etag', tag);
}

/** Thrown when a versioned UPDATE matched no row under an If-Match precondition. */
export class EtagConflictError extends ConflictException {
  constructor(entity: string) {
    super(`${entity} was modified concurrently; reload and retry`);
  }
}
