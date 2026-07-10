import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Actor } from './data-model.common';

export interface AuditChainReport {
  ok: boolean;
  checkedRows: number;
  /** id of the first row whose signature is broken, or null when intact. */
  firstBrokenId: string | null;
  firstBrokenUuid: string | null;
  reason: string | null;
}

interface VerifyRow {
  ok: boolean;
  checked_rows: string | number;
  first_broken_id: string | number | null;
  first_broken_uuid: string | null;
  reason: string | null;
}

/**
 * Runtime verification of the audit_log tamper-evident hash chain.
 *
 * The chain is signed at INSERT by the audit_log_sign trigger and verified by
 * the data_model_verify_audit_chain() SQL function (both from migration 027),
 * which share one canonical hash function so they cannot drift. This service is
 * a thin wrapper that runs the verifier inside the caller's tenant transaction
 * (so row level security scopes it to their tenant) and shapes the result.
 *
 * A pure TypeScript reference of the same construction lives in audit-chain.ts
 * for offline/exported-chain verification and unit testing the algorithm.
 */
@Injectable()
export class AuditSignatureService {
  constructor(private readonly database: DatabaseService) {}

  /** Walks the caller tenant's audit chain and reports the first break. */
  async verifyChain(actor: Actor): Promise<AuditChainReport> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<VerifyRow>('SELECT * FROM data_model_verify_audit_chain($1)', [
          actor.tenantId,
        ])
      ).rows[0];
      return {
        ok: Boolean(row?.ok),
        checkedRows: Number(row?.checked_rows ?? 0),
        firstBrokenId: row?.first_broken_id != null ? String(row.first_broken_id) : null,
        firstBrokenUuid: row?.first_broken_uuid ?? null,
        reason: row?.reason ?? null,
      };
    });
  }
}
