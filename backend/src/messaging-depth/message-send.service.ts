import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { describeMsisdnProblem, normalizeMsisdn } from '../routing-depth/msisdn';
import {
  RouteResolutionService,
  SendRouteDecision,
} from '../routing-depth/route-resolution.service';
import {
  applyRouteRule,
  type OverrideSet,
  type RouteRuleEffect,
} from '../routing-depth/route-overrides';
import { MtDedupeService } from './mt-dedupe.service';
import type { DedupeSubject } from './mt-dedupe';
import { CustomerRateLimitService } from '../customers-depth/customer-rate-limit.service';
import { MessageBlocklistService } from './message-blocklist.service';
import { ContentFilterService } from './content-filter.service';
import { ContentFilterVerdict } from './content-filter';
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
   * Engine send priority, 0 (bulk) to 3 (highest), already validated by
   * `parseMessagePriority`. Written to `send_sms.priority`, which the patched
   * sqlbox PostgreSQL driver carries into bearerbox, whose per-SMSC outbound
   * queue is a max-heap on it.
   *
   * NULL and 0 are DIFFERENT and neither is a default for the other: null means
   * "no preference" and reaches the engine as `MSG_PARAM_UNDEFINED`, while 0 is
   * the real, lowest level. Passing `?? 0` here would quietly demote every
   * unspecified message below every specified one.
   *
   * Only observable when a backlog exists: with an idle bind and a sub-second
   * drain, nothing is ever queued long enough to reorder.
   */
  priority?: number | null;
  /**
   * Deferred delivery + expiry, already parsed and validated by
   * `parseMessageSchedule`. Resolved into `send_sms.deferred` /
   * `send_sms.validity` (relative minutes) at the instant of the INSERT, which
   * is what the engine's time base requires.
   *
   * A FUTURE `scheduledAt` never reaches this service: it is held by
   * {@link ScheduledSendService} and released here at the scheduled instant, by
   * which time the offset has collapsed to 0. What arrives here is either a
   * schedule whose instant has come, or one carrying only `validityMinutes` —
   * and validity IS honoured by real SMPP carriers, so it is still written onto
   * the engine row. See message-scheduling.ts.
   */
  schedule?: MessageSchedule | null;

  /**
   * Invoked INSIDE the send transaction, with the same client, immediately
   * after the engine submission and the audit row — the last thing before
   * COMMIT. Throwing from it rolls the ENTIRE send back: no quota consumed, no
   * debit posted, no decision claiming a send that did not happen.
   *
   * It exists so a caller can record the fact of the send atomically with the
   * send itself. The scheduled-send release uses it to flip its hold from
   * `releasing` to `released` in the same commit, which is what makes a
   * crash mid-release non-duplicating: a hold left in `releasing` provably did
   * not send, so retrying it is safe.
   */
  onSubmitted?: (
    client: PoolClient,
    submitted: { sqlId: string; decisionId: string },
  ) => Promise<void>;
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

type DecisionOutcome = 'routed' | 'explicit' | 'rerouted' | 'rejected' | 'dropped';

/**
 * Folds a content-filter verdict into the decision record: the deciding rule's
 * identity, and its sentence appended to the running reason. Applied for an
 * ALLOW match too, so an operator can see that a message went out because a
 * specific exemption rule permitted it, not merely because nothing stopped it.
 */
function contentDecision(verdict: ContentFilterVerdict): Partial<DecisionRecord> {
  const decided = verdict.decidedBy;
  if (!decided) return {};
  return { contentRuleId: decided.ruleId, contentRuleName: decided.ruleName };
}

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
  /**
   * The content-filter rule that decided this message's fate, when one did.
   * Recorded structurally as well as in `reason` so "which rule stopped this?"
   * is a query rather than a substring search through prose.
   */
  contentRuleId: string | null;
  contentRuleName: string | null;
  /**
   * What the routing rule rewrote, as `{field: {from, to}}` (migration 052).
   *
   * Structural, not prose, because the question after the fact is "the customer
   * says they sent from URASMS and the subscriber saw 7077" and that has to be
   * answerable by query. Only the LENGTH of a replaced body is stored — see
   * route-overrides.ts.
   */
  appliedOverrides?: OverrideSet | null;
  /** The rule that dropped this message, when one did. */
  droppedByRule?: string | null;
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
 *   3b. content filtering — body / sender ID / recipient / per-SMSC keyword
 *      rules (content-filter.service.ts). Runs here when no rule is
 *      SMSC-scoped; when one is, it runs immediately after step 4 instead,
 *      because an SMSC-scoped rule cannot be judged before the carrier is
 *      known. Either way it is before anything is consumed or spooled.
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
    private readonly contentFilter: ContentFilterService,
    // Optional so the existing tests can construct the service without it, and
    // so a deployment that has not applied migration 053 keeps working. Absent
    // means suppression OFF, which is the pre-053 behaviour — the right way to
    // fail for a control whose failure mode is refusing legitimate traffic.
    private readonly dedupe?: MtDedupeService,
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
            fallback_used, outcome, reason, available_smsc_ids, candidates_considered, trace, created_by,
            content_rule_id, content_rule_name, applied_overrides, dropped_by_rule)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
          record.contentRuleId,
          record.contentRuleName,
          // Null rather than `{}` when nothing was rewritten, so "no override"
          // and "an override we failed to capture" stay distinguishable.
          record.appliedOverrides && Object.keys(record.appliedOverrides).length
            ? JSON.stringify(record.appliedOverrides)
            : null,
          record.droppedByRule ?? null,
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
    // Reassignable, because a matched routing rule may rewrite any of the three
    // before the message is spooled (migration 052). The ORIGINAL values stay
    // available on `request` and `normalized`, which is what the audit needs.
    let destination = normalized.digits;
    const requestedSmscId = request.smscId?.trim() || null;
    let sender = request.sender ?? '';
    let body = request.text ?? '';

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
      contentRuleId: null,
      contentRuleName: null,
    };

    // Captured inside the transaction so a rollback can still report why.
    let forensic: DecisionRecord = { ...base };
    // Settled (quarantine + hit counter) after the transaction closes, so that
    // bookkeeping can never fail a send nor be rolled back with one. Held in a
    // const container rather than a reassigned `let` so the value survives the
    // rollback path without a cross-await reassignment.
    const filterOutcome: { verdict: ContentFilterVerdict | null } = { verdict: null };
    // Held outside the transaction so the rollback path can release the key.
    let dedupeSubject: DedupeSubject | null = null;
    let dedupeWindow = 0;
    let dedupeClaimed = false;

    try {
      return await this.database.tenantTransaction(actor.tenantId, async (client) => {
        // 2b. Per-customer rate limit (customers.rate_limit_per_min), first
        // because it is the cheapest refusal and the one whose whole purpose is
        // to shed work before any is done. Fails OPEN when Redis is down.
        await this.rateLimits.consumeInClient(client, actor.tenantId, request.customerId ?? null);

        // 2c. DUPLICATE CONTROL. Before the blocklist and before routing,
        // because a retry of a message we already accepted should cost nothing
        // at all — not a route lookup, not a rule evaluation, not a quota read.
        //
        // Claimed here and RELEASED on the rollback path below: a submission
        // that claims its key and is then refused (no route, no credit, blocked
        // recipient) must not leave the key held, or the operator's corrected
        // retry seconds later is rejected as a duplicate of a message that
        // never went.
        if (this.dedupe) {
          dedupeWindow = await this.dedupe.windowForInClient(client, actor.tenantId);
          if (dedupeWindow > 0) {
            dedupeSubject = {
              tenantId: actor.tenantId,
              sender,
              recipient: destination,
              text: request.text ?? '',
              foreignId: request.foreignId ?? null,
            };
            await this.dedupe.claimInClient(client, dedupeSubject, dedupeWindow);
            dedupeClaimed = true;
          }
        }

        // 3. Blocklist, BEFORE any route is chosen.
        await this.blocklist.assertAllowedInClient(client, destination, request.customerId ?? null);

        // 3b. CONTENT FILTERING — body / sender ID / recipient / per-SMSC
        // keyword rules. One cached, indexed read per tenant per cache window;
        // zero round trips on a hit. See ContentFilterService for the cost and
        // for why the evaluation point is chosen from the rule set rather than
        // hard-coded: an SMSC-scoped rule cannot be judged before the carrier
        // is known, and with first-match-wins precedence, guessing is wrong.
        const ruleSet = await this.contentFilter.loadInClient(client, actor.tenantId);
        const filterContext = {
          sender,
          recipient: destination,
          body: request.text ?? '',
          customerId: request.customerId ?? null,
        };
        if (!ruleSet.hasSmscScopedRules) {
          const verdict = this.contentFilter.evaluate(ruleSet, {
            ...filterContext,
            smscId: null,
          });
          filterOutcome.verdict = verdict;
          forensic = { ...forensic, ...contentDecision(verdict) };
          this.contentFilter.assertAllowed(verdict);
        }

        // 4. Which bind?
        const chosen = await this.chooseBind(client, actor, request, destination, requestedSmscId);
        let record: DecisionRecord = { ...forensic, ...chosen.record };
        forensic = record;

        // 4b. WHAT THE RULE DOES (migration 052). A matched rule may drop the
        // message, or rewrite its sender, recipient or body.
        //
        // Evaluated HERE — after the route is known, before entitlements are
        // consumed and before anything is spooled. A drop must not debit a
        // customer for a message that is never sent, and an overridden sender
        // must be the one the sender-ID entitlement check actually approves;
        // approving URASMS and then transmitting 7077 would make that check
        // decorative.
        const effect = chosen.effect ?? null;
        if (effect?.action === 'drop') {
          const dropped = applyRouteRule(
            { sender, recipient: destination, text: request.text ?? '' },
            effect,
            record.routeName ?? 'a routing rule',
          );
          if (dropped.decision !== 'drop') throw new Error('unreachable');
          // Recorded on `forensic`, NOT inserted here.
          //
          // This transaction is about to roll back, and a decision written
          // inside it would roll back with it — leaving exactly the silence the
          // drop was supposed to be explainable by. The catch block's
          // `recordRejection` writes it in a fresh transaction instead, which is
          // the same mechanism every other refusal on this path already uses.
          record = {
            ...record,
            outcome: 'dropped',
            reason: dropped.summary,
            droppedByRule: record.routeName ?? null,
          };
          forensic = record;
          throw new ForbiddenException(dropped.summary);
        }

        const rewritten = applyRouteRule(
          { sender, recipient: destination, text: request.text ?? '' },
          effect ?? { action: 'route' },
          record.routeName ?? 'a routing rule',
        );
        if (rewritten.decision !== 'send') throw new Error('unreachable');
        sender = rewritten.message.sender ?? '';
        destination = rewritten.message.recipient;
        body = rewritten.message.text;
        if (rewritten.summary) {
          record = {
            ...record,
            appliedOverrides: rewritten.overrides,
            reason: [record.reason, rewritten.summary].filter(Boolean).join('; '),
            trace: [...(record.trace ?? []), rewritten.summary],
          };
          forensic = record;
        }

        // 3c. The deferred half of content filtering: the carrier is now known,
        // and NOTHING has been consumed or spooled yet — route selection is a
        // pure read. A refusal here is as clean as one before routing.
        if (ruleSet.hasSmscScopedRules) {
          const verdict = this.contentFilter.evaluate(ruleSet, {
            ...filterContext,
            smscId: chosen.smscId,
          });
          filterOutcome.verdict = verdict;
          record = { ...record, ...contentDecision(verdict) };
          forensic = record;
          this.contentFilter.assertAllowed(verdict);
        }

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
          // `sender`, `destination` and `body` are the POST-override values.
          // `normalized.e164` is only used when the recipient was NOT rewritten;
          // an overridden recipient has not been through the normaliser, so
          // preferring the cached E.164 there would silently send to the
          // original number the rule was rewriting away from.
          sender,
          receiver:
            destination === normalized.digits ? (normalized.e164 ?? destination) : destination,
          text: body,
          smscId: chosen.smscId,
          dlrMask: request.dlrMask,
          dlrUrl: request.dlrUrl,
          foreignId: request.foreignId,
          priority: request.priority ?? null,
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

        // Last statement before COMMIT, deliberately: whatever the caller
        // records here is committed with the send or lost with it, never half.
        // Stamped so a later duplicate's refusal can name the message it is a
        // duplicate OF, rather than only saying that one exists.
        if (this.dedupe && dedupeSubject && dedupeWindow > 0)
          await this.dedupe.stampInClient(client, dedupeSubject, dedupeWindow, queued.sqlId);

        if (request.onSubmitted)
          await request.onSubmitted(client, { sqlId: queued.sqlId, decisionId });

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
      // Release the key this attempt claimed — but NOT when the error IS the
      // duplicate refusal, because that key belongs to the earlier submission
      // and deleting it would let the very next retry through.
      if (
        this.dedupe &&
        dedupeClaimed &&
        dedupeSubject &&
        !(error instanceof ConflictException)
      ) {
        const subject = dedupeSubject;
        const window = dedupeWindow;
        await this.database
          .tenantTransaction(actor.tenantId, (client) =>
            this.dedupe!.releaseInClient(client, subject, window),
          )
          .catch(() => undefined);
      }
      await this.recordRejection(actor, {
        ...forensic,
        // A rule that DROPPED the message keeps that outcome. Overwriting it
        // with the generic `rejected` would lose the distinction between "a
        // routing rule refused this deliberately" and "something went wrong",
        // which is precisely the question a customer asks.
        outcome: forensic.outcome === 'dropped' ? 'dropped' : 'rejected',
        messageRef: null,
        reason: forensic.reason
          ? `${forensic.reason}; refused: ${String((error as Error).message ?? error)}`
          : `refused: ${String((error as Error).message ?? error)}`,
      });
      throw error;
    } finally {
      // Content-filter bookkeeping: quarantine a regex that blew its budget and
      // bump the hit counter of a rule that blocked. Outside the transaction on
      // purpose — a blocked send rolls back, and the record of WHY it was
      // blocked must not roll back with it. Does no I/O at all on the happy
      // path (nothing matched, or an allow matched), so it is free there.
      if (filterOutcome.verdict)
        await this.contentFilter.settle(actor.tenantId, filterOutcome.verdict);
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
  ): Promise<{
    smscId: string;
    cost: number | null;
    record: Partial<DecisionRecord>;
    // What the winning rule DOES. Null for a caller-pinned bind: the caller
    // named the SMSC directly, so no rule was consulted and none may rewrite.
    effect: RouteRuleEffect | null;
  }> {
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
              effect: decision.effect ?? null,
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
        // The caller named the bind, so no rule was consulted — and a rule
        // that was never selected must not rewrite the message.
        effect: null,
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
      effect: decision.effect ?? null,
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
