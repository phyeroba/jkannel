import { BadRequestException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { describeMsisdnProblem, normalizeMsisdn } from '../routing-depth/msisdn';
import {
  RouteResolutionService,
  SendRouteDecision,
} from '../routing-depth/route-resolution.service';
import { CustomerRateLimitService } from '../customers-depth/customer-rate-limit.service';
import { MessageBlocklistService } from './message-blocklist.service';
import { SendEntitlementsService } from './send-entitlements.service';
import { MessageSchedule, engineScheduleColumns } from './message-scheduling';

export interface Actor {
  tenantId: string;
  userId: string;
}

export type SendChannel = 'console' | 'api' | 'bulk' | 'replay' | 'system';

export interface SendRequest {
  sender: string;
  receiver: string;
  text: string;
  /**
   * Engine-level bind (`smsc_definitions.engine_id`). OPTIONAL: when omitted the
   * routing engine chooses, which is the entire point of gap G2.
   */
  smscId?: string | null;
  dlrMask?: number;
  dlrUrl?: string;
  foreignId?: string;
  /** Customer the traffic is attributed to and entitlement-checked against. */
  customerId?: string | null;
  /** Which send path this is; recorded on the decision. */
  channel: SendChannel;
  /** Ledger / decision correlation (bulk job id, replayed message id, ...). */
  reference?: string | null;
  /** Operator hint for `operator`-typed routes. */
  operator?: string | null;
  /**
   * Replay semantics: when the pinned bind is not currently healthy, let the
   * routing engine pick a live one instead of re-submitting to a dead SMSC.
   */
  rerouteIfUnavailable?: boolean;
  /** Per-message charge override; otherwise the route's cost, else the default. */
  cost?: number | null;
  /**
   * Deferred delivery + expiry, already parsed and validated by
   * {@link parseMessageSchedule}. Resolved into `send_sms.deferred` /
   * `send_sms.validity` (relative minutes) at the instant of the INSERT, which
   * is what the engine's time base requires.
   *
   * A deferral is a request to the CARRIER, not a hold: nothing in JKANNEL or
   * Kannel keeps the message back. Read message-scheduling.ts before telling a
   * user their message is "scheduled".
   */
  schedule?: MessageSchedule | null;
}

export interface SendResult {
  sqlId: string;
  status: string;
  source: string;
  /** Bind the message was actually submitted through. */
  smscId: string;
  /** Canonical digits-only destination the routing/blocklist decision used. */
  destination: string;
  routeId: string | null;
  routeName: string | null;
  strategy: string | null;
  fallbackUsed: boolean;
  outcome: DecisionOutcome;
  reason: string;
  decisionId: string | null;
  customerId: string | null;
  /** Amount debited from the customer's balance, 0 when unbilled. */
  charged: number;
  /**
   * Instant the caller asked for delivery at, echoed back so the console can
   * show what was actually requested. null = as soon as possible.
   */
  scheduledAt: string | null;
  /** `send_sms.deferred` as written (relative minutes), or null. */
  deferredMinutes: number | null;
  /** `send_sms.validity` as written (relative minutes), or null. */
  validityMinutes: number | null;
}

type DecisionOutcome = 'routed' | 'explicit' | 'rerouted' | 'rejected';

interface DecisionRecord {
  customerId: string | null;
  messageRef: string | null;
  foreignId: string | null;
  channel: SendChannel;
  sender: string | null;
  destination: string;
  destinationRaw: string;
  routeId: string | null;
  routeName: string | null;
  strategy: string | null;
  smscId: string | null;
  requestedSmscId: string | null;
  fallbackUsed: boolean;
  outcome: DecisionOutcome;
  reason: string;
  availableSmscIds: string[];
  candidatesConsidered: number;
  trace: string[];
}

/**
 * THE send path.
 *
 * Before this existed there were four production send paths and every one of
 * them took the target SMSC straight from its caller, so the routing engine
 * decided nothing, entitlements enforced nothing and no decision was ever
 * recorded. This service is the single funnel they now share, and it performs,
 * in order, the steps `ROUTING_ENGINE_SPEC_04` asks for:
 *
 *   1. validate the destination (shared E.164 normaliser)
 *   2. identify the customer (explicit, or from the API key) and enforce its
 *      per-minute send rate (`customers.rate_limit_per_min`) — a control the
 *      per-API-key limiter cannot provide, because one customer may hold many
 *      keys and each would stay inside its own budget
 *   3. blacklist / whitelist / DND
 *   4. select the route — deployed routes only, against live bind health, with
 *      failover — unless the caller pinned a bind
 *   5. enforce entitlements: sender-ID approval, customer route binding, quota,
 *      credit
 *   6. submit to the engine
 *   7. audit the decision (`message_route_decisions`)
 *
 * ATOMICITY. Steps 3-7 run inside ONE tenant transaction, and the engine
 * submission happens as the last statement inside it. If the submission throws,
 * the transaction rolls back: no quota consumed, no debit posted, no decision
 * claiming a send that did not happen. The one seam that cannot be closed is
 * the COMMIT itself — SQLBox is a separate database, so a failure between a
 * successful spool insert and the COMMIT would leave a sent message with no
 * debit. It is ordered to make that window as small as possible and is called
 * out here rather than papered over.
 *
 * A REFUSAL IS NEVER A SUCCESS. Every rejection throws a specific 4xx and, on a
 * best-effort basis, records an `outcome='rejected'` decision row in a separate
 * transaction so the refusal is visible to an operator even though the send
 * transaction rolled back.
 */
@Injectable()
export class MessageSendService {
  /** Per-tenant monotonic counter making round-robin / load-balance rotate. */
  private readonly rotation = new Map<string, number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly routing: RouteResolutionService,
    private readonly entitlements: SendEntitlementsService,
    private readonly blocklist: MessageBlocklistService,
    private readonly rateLimits: CustomerRateLimitService,
  ) {}

  private nextRotation(tenantId: string): number {
    const next = ((this.rotation.get(tenantId) ?? 0) + 1) % 1_000_000;
    this.rotation.set(tenantId, next);
    return next;
  }

  /** Engine-level SMSC ids the tenant owns (RLS-scoped smsc_definitions). */
  private async tenantSmscScope(client: PoolClient): Promise<string[]> {
    return (
      await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
    ).rows.map((row) => row.engine_id);
  }

  private async insertDecision(
    client: PoolClient,
    actor: Actor,
    record: DecisionRecord,
  ): Promise<string> {
    const row = (
      await client.query<{ id: string }>(
        `INSERT INTO message_route_decisions
           (tenant_id, customer_id, message_ref, foreign_id, channel, sender, destination,
            destination_raw, route_id, route_name, strategy, smsc_id, requested_smsc_id,
            fallback_used, outcome, reason, available_smsc_ids, candidates_considered, trace, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id::text`,
        [
          actor.tenantId,
          record.customerId,
          record.messageRef,
          record.foreignId,
          record.channel,
          record.sender,
          record.destination,
          record.destinationRaw,
          record.routeId,
          record.routeName,
          record.strategy,
          record.smscId,
          record.requestedSmscId,
          record.fallbackUsed,
          record.outcome,
          record.reason,
          record.availableSmscIds,
          record.candidatesConsidered,
          JSON.stringify(record.trace),
          actor.userId,
        ],
      )
    ).rows[0];
    return row.id;
  }

  /**
   * Records a refused send in its own transaction, because the transaction that
   * discovered the refusal is being rolled back. Never throws: losing the
   * forensic record must not change the error the caller sees.
   */
  private async recordRejection(actor: Actor, record: DecisionRecord): Promise<void> {
    try {
      await this.database.tenantTransaction(actor.tenantId, (client) =>
        this.insertDecision(client, actor, record),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'could not record send rejection',
          tenantId: actor.tenantId,
          error: String((error as Error).message ?? error),
        }),
      );
    }
  }

  /**
   * Submits one message. `smscId` optional; when omitted the routing engine
   * decides and the submission FAILS with a clear error if nothing matched —
   * an arbitrary bind is never picked.
   */
  async send(actor: Actor, request: SendRequest): Promise<SendResult> {
    const normalized = normalizeMsisdn(request.receiver);
    if (!normalized.digits) throw new BadRequestException(describeMsisdnProblem(normalized));
    const destination = normalized.digits;
    const requestedSmscId = request.smscId?.trim() || null;
    const sender = request.sender ?? '';

    const base: DecisionRecord = {
      customerId: request.customerId ?? null,
      messageRef: null,
      foreignId: request.foreignId ?? null,
      channel: request.channel,
      sender: sender || null,
      destination,
      destinationRaw: request.receiver,
      routeId: null,
      routeName: null,
      strategy: null,
      smscId: null,
      requestedSmscId,
      fallbackUsed: false,
      outcome: 'rejected',
      reason: '',
      availableSmscIds: [],
      candidatesConsidered: 0,
      trace: [],
    };

    // Captured inside the transaction so a rollback can still report why.
    let forensic: DecisionRecord = { ...base };

    try {
      return await this.database.tenantTransaction(actor.tenantId, async (client) => {
        // 2b. Per-customer rate limit (customers.rate_limit_per_min), first
        // because it is the cheapest refusal and the one whose whole purpose is
        // to shed work before any is done. Fails OPEN when Redis is down.
        await this.rateLimits.consumeInClient(client, actor.tenantId, request.customerId ?? null);

        // 3. Blocklist, BEFORE any route is chosen.
        await this.blocklist.assertAllowedInClient(client, destination, request.customerId ?? null);

        // 4. Which bind?
        const chosen = await this.chooseBind(client, actor, request, destination, requestedSmscId);
        const record: DecisionRecord = { ...forensic, ...chosen.record };
        forensic = record;

        // 5. Entitlements, in THIS transaction.
        const outcome = await this.entitlements.consumeInClient(client, actor, {
          customerId: request.customerId ?? null,
          sender,
          smscId: chosen.smscId,
          routeId: record.routeId,
          count: 1,
          cost: request.cost ?? chosen.cost,
          reference: request.reference ?? request.foreignId ?? null,
        });

        // 7a. Record the decision before submitting so the row exists even if
        // the engine insert is the thing that fails (it is then rolled back
        // together with everything else).
        const decisionId = await this.insertDecision(client, actor, {
          ...record,
          messageRef: null,
        });

        // 6. Submit. Last statement in the transaction (see class doc).
        // The deferral offset is resolved HERE rather than when the request was
        // parsed: sqlbox anchors `deferred` to its own pickup time, so the
        // offset has to be measured from as close to the INSERT as possible.
        // For a bulk campaign that gap is minutes, not milliseconds.
        const columns = engineScheduleColumns(request.schedule);
        const queued = await this.sqlbox.submit({
          sender,
          receiver: normalized.e164 ?? destination,
          text: request.text,
          smscId: chosen.smscId,
          dlrMask: request.dlrMask,
          dlrUrl: request.dlrUrl,
          foreignId: request.foreignId,
          deferredMinutes: columns.deferredMinutes,
          validityMinutes: columns.validityMinutes,
        });

        await client.query('UPDATE message_route_decisions SET message_ref=$2 WHERE id=$1', [
          decisionId,
          queued.sqlId,
        ]);
        await client.query(
          'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            actor.tenantId,
            actor.userId,
            'message.submitted',
            'message',
            queued.sqlId,
            JSON.stringify({
              channel: request.channel,
              smscId: chosen.smscId,
              routeId: record.routeId,
              customerId: request.customerId ?? null,
              charged: outcome.charged,
              destination,
              scheduledAt:
                request.schedule?.scheduledAtMs != null
                  ? new Date(request.schedule.scheduledAtMs).toISOString()
                  : null,
              deferredMinutes: columns.deferredMinutes,
              validityMinutes: columns.validityMinutes,
            }),
            record.reason,
          ],
        );

        return {
          sqlId: queued.sqlId,
          status: queued.status,
          source: queued.source,
          smscId: chosen.smscId,
          destination,
          routeId: record.routeId,
          routeName: record.routeName,
          strategy: record.strategy,
          fallbackUsed: record.fallbackUsed,
          outcome: record.outcome,
          reason: record.reason,
          decisionId,
          customerId: outcome.customerId,
          charged: outcome.charged,
          scheduledAt:
            request.schedule?.scheduledAtMs != null
              ? new Date(request.schedule.scheduledAtMs).toISOString()
              : null,
          deferredMinutes: columns.deferredMinutes,
          validityMinutes: columns.validityMinutes,
        };
      });
    } catch (error) {
      await this.recordRejection(actor, {
        ...forensic,
        outcome: 'rejected',
        messageRef: null,
        reason: forensic.reason
          ? `${forensic.reason}; refused: ${String((error as Error).message ?? error)}`
          : `refused: ${String((error as Error).message ?? error)}`,
      });
      throw error;
    }
  }

  /**
   * Resolves the bind for one message: an explicit one (validated, optionally
   * re-routed when it is down) or the routing engine's choice.
   */
  private async chooseBind(
    client: PoolClient,
    actor: Actor,
    request: SendRequest,
    destination: string,
    requestedSmscId: string | null,
  ): Promise<{ smscId: string; cost: number | null; record: Partial<DecisionRecord> }> {
    if (requestedSmscId) {
      const allowed = await this.tenantSmscScope(client);
      if (!allowed.includes(requestedSmscId))
        throw new BadRequestException('smscId must reference one of your tenant’s SMSCs');

      if (request.rerouteIfUnavailable) {
        const { available } = await this.routing.availability(client);
        if (!available.includes(requestedSmscId)) {
          const decision = await this.resolveRoute(client, actor, request, destination);
          if (decision.smscId)
            return {
              smscId: decision.smscId,
              cost: decision.cost,
              record: this.fromDecision(decision, 'rerouted', requestedSmscId, {
                prefix: `pinned bind ${requestedSmscId} is not bound`,
              }),
            };
        }
      }

      return {
        smscId: requestedSmscId,
        cost: null,
        record: {
          smscId: requestedSmscId,
          requestedSmscId,
          outcome: 'explicit',
          reason: `explicit smscId supplied by the caller (${request.channel})`,
          trace: [`caller pinned bind ${requestedSmscId}`],
        },
      };
    }

    const decision = await this.resolveRoute(client, actor, request, destination);
    if (!decision.smscId) {
      // Never silently pick an arbitrary bind.
      throw new BadRequestException(
        `No route is available for ${destination}: ${decision.reason}. ` +
          'Deploy a matching route or supply an explicit smscId.',
      );
    }
    return {
      smscId: decision.smscId,
      cost: decision.cost,
      record: this.fromDecision(decision, 'routed', null),
    };
  }

  private resolveRoute(
    client: PoolClient,
    actor: Actor,
    request: SendRequest,
    destination: string,
  ): Promise<SendRouteDecision> {
    return this.routing.resolveInClient(client, {
      msisdn: destination,
      sender: request.sender ?? null,
      operator: request.operator ?? null,
      customerId: request.customerId ?? null,
      rotation: this.nextRotation(actor.tenantId),
    });
  }

  private fromDecision(
    decision: SendRouteDecision,
    outcome: DecisionOutcome,
    requestedSmscId: string | null,
    extra: { prefix?: string } = {},
  ): Partial<DecisionRecord> {
    const health = decision.healthAssumed
      ? 'bind health unobserved, every enabled bind assumed available'
      : null;
    const reason = [extra.prefix, decision.reason, health].filter(Boolean).join('; ');
    return {
      smscId: decision.smscId,
      requestedSmscId,
      routeId: decision.routeId,
      routeName: decision.routeName,
      strategy: decision.strategy,
      fallbackUsed: decision.fallbackUsed,
      outcome,
      reason,
      availableSmscIds: decision.availableSmscIds,
      candidatesConsidered: decision.candidatesConsidered,
      trace: decision.trace,
    };
  }
}
