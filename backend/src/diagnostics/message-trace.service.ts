import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import {
  assembleTrace,
  type AssembledTrace,
  type EngineEventInput,
  type RetryAttemptInput,
  type RouteDecisionInput,
} from './message-trace';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface MessageTraceResult {
  id: string;
  lifecycle: AssembledTrace;
  /** The raw engine rows, kept so the operator can still see the evidence. */
  events: unknown[];
  available: boolean;
  detail: string;
}

/**
 * Joins the three sources a message's history is spread across (spec §10).
 *
 * The engine rows come from SQLBox; the routing decision and the retry chain
 * come from JKANNEL's own database. Nothing had both connections, which is why
 * `message_route_decisions` — captured on every send, indexed, and genuinely
 * rich — was read by nothing.
 */
@Injectable()
export class MessageTraceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  async trace(actor: Actor, id: string, allowedSmscIds?: string[]): Promise<MessageTraceResult> {
    const probe = await this.sqlbox.probe();
    let events: unknown[] = [];
    let engineEvents: EngineEventInput[] = [];
    let detail = probe.evidence;

    if (probe.available) {
      try {
        const engine = await this.sqlbox.trace(id, allowedSmscIds);
        events = engine.events ?? [];
        engineEvents = (engine.events ?? []).map((event: Record<string, unknown>) => ({
          source: (event.source as 'send_sms' | 'sent_sms') ?? 'sent_sms',
          direction: (event.direction as string) ?? null,
          deliveryStatus: (event.deliveryStatus as string) ?? null,
          timestamp: event.timestamp ? String(event.timestamp) : null,
          smscId: (event.smscId as string) ?? null,
        }));
        detail = 'Read from the engine message store.';
      } catch (error) {
        detail = `Engine history unavailable: ${(error as Error).message}`;
      }
    }

    const { decision, retries } = await this.database.tenantTransaction(
      actor.tenantId,
      async (client) => {
        // message_ref is the sql_id we stamped; foreign_id is the same value as
        // the engine records it. Matching on either covers a message looked up
        // by whichever identifier the operator happens to have.
        const decisionRows = await client.query<Record<string, unknown>>(
          `SELECT route_name, strategy, smsc_id, requested_smsc_id, fallback_used,
                  outcome, reason, candidates_considered, content_rule_name, created_at
             FROM message_route_decisions
            WHERE message_ref = $1 OR foreign_id = $1
            ORDER BY created_at LIMIT 1`,
          [id],
        );
        const retryRows = await client.query<Record<string, unknown>>(
          `SELECT a.attempt_no, a.smsc_id, a.outcome, a.created_at
             FROM message_delivery_retry_attempts a
             JOIN message_delivery_retries r ON r.id = a.retry_id
            WHERE r.origin_message_ref = $1
            ORDER BY a.attempt_no`,
          [id],
        );
        return { decision: decisionRows.rows[0] ?? null, retries: retryRows.rows };
      },
    );

    return {
      id,
      lifecycle: assembleTrace({
        decision: decision ? toDecision(decision) : null,
        events: engineEvents,
        retries: retries.map(toRetry),
      }),
      events,
      available: probe.available,
      detail,
    };
  }
}

function toDecision(row: Record<string, unknown>): RouteDecisionInput {
  return {
    routeName: (row.route_name as string) ?? null,
    strategy: (row.strategy as string) ?? null,
    smscId: (row.smsc_id as string) ?? null,
    requestedSmscId: (row.requested_smsc_id as string) ?? null,
    fallbackUsed: Boolean(row.fallback_used),
    outcome: (row.outcome as string) ?? null,
    reason: (row.reason as string) ?? null,
    candidatesConsidered:
      row.candidates_considered === null || row.candidates_considered === undefined
        ? null
        : Number(row.candidates_considered),
    contentRuleName: (row.content_rule_name as string) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
  };
}

function toRetry(row: Record<string, unknown>): RetryAttemptInput {
  return {
    attemptNo: Number(row.attempt_no ?? 0),
    smscId: (row.smsc_id as string) ?? null,
    outcome: (row.outcome as string) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
  };
}
