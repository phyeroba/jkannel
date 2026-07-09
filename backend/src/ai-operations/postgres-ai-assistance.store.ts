import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AssistanceActor, AssistanceRecord, AssistanceStore } from './ai-operations.types';
@Injectable()
export class PostgresAiAssistanceStore implements AssistanceStore {
  constructor(private readonly database: DatabaseService) {}
  async save(actor: AssistanceActor, record: AssistanceRecord) {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await client.query(
        `INSERT INTO ai_assistance_requests(id,tenant_id,requested_by,question,evidence,result,status,risk,confidence,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          record.id,
          actor.tenantId,
          actor.userId,
          record.question,
          JSON.stringify(record.evidence),
          JSON.stringify(record),
          record.status,
          record.risk,
          record.confidence,
          record.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason,correlation_id) VALUES($1,$2,'ai.assistance.requested','ai_assistance',$3,$4,'Explicit opt-in local analysis',$5)`,
        [
          actor.tenantId,
          actor.userId,
          record.id,
          JSON.stringify({
            status: record.status,
            confidence: record.confidence,
            risk: record.risk,
            model: record.model,
          }),
          actor.correlationId ?? null,
        ],
      );
    });
  }
  async find(actor: AssistanceActor, id: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<{ result: AssistanceRecord }>(
          `SELECT result FROM ai_assistance_requests WHERE id=$1 AND tenant_id=$2`,
          [id, actor.tenantId],
        )
      ).rows[0];
      return row?.result;
    });
  }
  async approve(
    actor: AssistanceActor,
    id: string,
    decision: 'approve' | 'reject',
    reason: string,
  ) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<{ result: AssistanceRecord }>(
          `SELECT result FROM ai_assistance_requests WHERE id=$1 AND tenant_id=$2 AND status='approval_required' FOR UPDATE`,
          [id, actor.tenantId],
        )
      ).rows[0];
      if (!row) return undefined;
      const updated: AssistanceRecord = {
        ...row.result,
        status: decision === 'approve' ? 'approved' : 'rejected',
        approvedBy: actor.userId,
        approvedAt: new Date().toISOString(),
      };
      await client.query(
        `UPDATE ai_assistance_requests SET result=$3,status=$4,decision_reason=$5,decided_by=$6,decided_at=now() WHERE id=$1 AND tenant_id=$2`,
        [id, actor.tenantId, JSON.stringify(updated), updated.status, reason, actor.userId],
      );
      await client.query(
        `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason,correlation_id) VALUES($1,$2,$3,'ai_assistance',$4,$5,$6,$7)`,
        [
          actor.tenantId,
          actor.userId,
          `ai.assistance.${updated.status}`,
          id,
          JSON.stringify({ status: updated.status }),
          reason,
          actor.correlationId ?? null,
        ],
      );
      return updated;
    });
  }
}
