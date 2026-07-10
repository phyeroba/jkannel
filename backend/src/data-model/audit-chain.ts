import { createHash } from 'crypto';

/**
 * Pure, self-consistent reference implementation of the audit_log hash chain.
 *
 * The AUTHORITATIVE signer and verifier live in the database (migration 027:
 * data_model_audit_row_hash() + the audit_log_sign trigger +
 * data_model_verify_audit_chain()), so every insert path is covered and there is
 * a single canonical definition. This module mirrors that construction in
 * TypeScript for two uses:
 *
 *   1. Unit-testing the chaining / tamper-detection ALGORITHM without a database.
 *   2. Offline verification of an EXPORTED chain, where each row's canonical
 *      field values are already available as strings.
 *
 * The canonical form joins the row's fields with the ASCII record separator
 * (0x1e) — identical to the SQL `chr(30)` — and hashes prev_hash || canonical
 * with SHA-256. Because both build and verify here use the same {@link rowHash},
 * the algorithm is self-consistent regardless of exact field formatting.
 */

const RS = '\x1e';

/** The canonical field set of one audit row, as strings (nulls -> ''). */
export interface AuditChainRow {
  tenantId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Canonical JSON text of old_value (PG jsonb::text), or ''. */
  oldValue: string;
  /** Canonical JSON text of new_value (PG jsonb::text), or ''. */
  newValue: string;
  reason: string;
  /** ISO-8601 UTC microsecond timestamp, e.g. 2026-07-10T12:00:00.000000Z. */
  createdAt: string;
}

/** Canonical, delimiter-joined serialization of a row (excludes prev_hash). */
export function canonicalize(row: AuditChainRow): string {
  return [
    row.tenantId,
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    row.oldValue,
    row.newValue,
    row.reason,
    row.createdAt,
  ].join(RS);
}

/** row_hash = sha256(prev_hash || canonical(row)), hex-encoded. */
export function rowHash(prevHash: string | null, row: AuditChainRow): string {
  return createHash('sha256')
    .update((prevHash ?? '') + RS + canonicalize(row), 'utf8')
    .digest('hex');
}

/** One link of a materialized chain: the row plus its stored hashes. */
export interface SignedRow extends AuditChainRow {
  prevHash: string | null;
  rowHash: string;
}

export interface ChainVerification {
  ok: boolean;
  checkedRows: number;
  /** 0-based index of the first broken link, or -1 when intact. */
  firstBrokenIndex: number;
  reason?: 'prev_hash mismatch' | 'row_hash mismatch';
}

/**
 * Walks a materialized chain in order and reports the first broken link. A
 * tamper (mutated field or reordered/removed row) changes a row's recomputed
 * hash or breaks the prev_hash linkage and is detected at that row.
 */
export function verifyChain(rows: SignedRow[]): ChainVerification {
  let expectedPrev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (expectedPrev !== r.prevHash)
      return { ok: false, checkedRows: i + 1, firstBrokenIndex: i, reason: 'prev_hash mismatch' };
    if (rowHash(r.prevHash, r) !== r.rowHash)
      return { ok: false, checkedRows: i + 1, firstBrokenIndex: i, reason: 'row_hash mismatch' };
    expectedPrev = r.rowHash;
  }
  return { ok: true, checkedRows: rows.length, firstBrokenIndex: -1 };
}

/**
 * Builds a signed chain from ordered rows, computing each link's hashes. Used by
 * tests and offline exporters to produce a chain the DB verifier would accept.
 */
export function buildChain(rows: AuditChainRow[]): SignedRow[] {
  let prev: string | null = null;
  const out: SignedRow[] = [];
  for (const row of rows) {
    const hash = rowHash(prev, row);
    out.push({ ...row, prevHash: prev, rowHash: hash });
    prev = hash;
  }
  return out;
}
