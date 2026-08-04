import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { EngineAdapterRegistry } from '../engine/engine-adapter.registry';
import { KamexAdapter } from '../engine/kamex.adapter';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface SpoolQuery {
  limit?: number;
  cursor?: number;
  smscId?: string;
  query?: string;
}
export interface RerouteRequest {
  sqlIds: number[];
  targetSmscId: string;
}
/** Log filter shared by history browsing and filtered resend. */
export interface HistoryQuery {
  limit?: number;
  cursor?: number;
  smscId?: string;
  query?: string;
  /** Delivery status or group, e.g. `failed`, `pending`, `resendable`, `in-flight`. */
  status?: string;
  /** Inclusive epoch-second bounds on the engine `time` column (from `from`/`to`). */
  fromEpoch?: number;
  toEpoch?: number;
}
export interface ResendRequest {
  /** Explicit ids (sql_id or foreign_id). Mutually exclusive with `filter`. */
  ids?: string[];
  /** Resend everything matching a delivery-status filter, e.g. all failures. */
  filter?: HistoryQuery;
  targetSmscId: string;
}
export type BindOperation = 'enable' | 'disable' | 'reconnect';

/**
 * Machine-readable skip codes. SQLBox drains `send_sms` in under a second, so
 * SPOOL_ALREADY_DRAINED is the ordinary outcome of a reroute/cancel rather than
 * a fault; the UI is expected to render it as guidance, not as an error.
 */
export const SKIP_DRAINED = 'SPOOL_ALREADY_DRAINED';
export const SKIP_NOT_FOUND = 'NOT_FOUND_OR_NOT_OWNED';
export const SKIP_DLR = 'DELIVERY_REPORT_NOT_RESENDABLE';
export const SKIP_INCOMPLETE = 'SOURCE_MESSAGE_INCOMPLETE';
export const SKIP_SUBMIT_FAILED = 'SUBMIT_FAILED';
const DRAINED_REASON =
  'no longer in the spool: already handed to the engine, or not owned by your tenant. ' +
  'Resend it from the sent history instead.';

/** Cap on a filtered resend, mirroring the controller's explicit-id batch cap. */
const MAX_RESEND_BATCH = 500;

/** One entry per requested id, in request order. Success carries `sqlId`. */
export type ResendResult =
  | { id: string; sqlId: string; originalSmscId: string | null; originalStatus: string }
  | { id: string; code: string; error: string };

/** Pending spool depth for one engine SMSC id. */
export interface SpoolBucket {
  smscId: string;
  count: number;
}

/** An SMSC the caller's tenant owns, joining the engine id to the console record. */
interface TenantBind {
  engineId: string;
  smscId: string;
  smscName: string;
}

/**
 * Live message-queue console.
 *
 * The pipeline has three tiers and only two of them are addressable:
 *
 *  1. the SQLBox spool (`send_sms`) — individually addressable and mutable, so a
 *     row can be repointed at another bind ({@link reroute}) or dropped
 *     ({@link cancel}) with no engine restart. This is a true on-the-fly
 *     reroute, but it is NOT the main path: SQLBox drains this table in under a
 *     second (measured), so on a healthy system it is almost always empty and
 *     the reroute window is genuinely narrow. It earns its keep only when a
 *     backlog exists — submission bursts, a slow/paused SQLBox, or a sick bind.
 *     Expect most requested ids to come back as `skipped`;
 *
 *  2. bearerbox's internal per-SMSC queue — HONEST BOUNDARY: messages that have
 *     already been handed to bearerbox are visible ONLY as the aggregate
 *     `queued` counter in /status.json. They cannot be listed, inspected, moved
 *     or cancelled individually; the admin interface exposes no such operation
 *     and nothing in this service pretends otherwise. The supported workaround
 *     is: disable the sick bind with {@link controlBind} so it stops draining
 *     and traffic stops flowing to it, then resend the affected messages from
 *     the log against a healthy bind with {@link resend};
 *
 *  3. history (`sent_sms`) — terminal. This is the PRIMARY operator path:
 *     filter the log for failed/undelivered traffic and resend it to a
 *     different bind, which submits brand new spool rows ({@link resend}).
 *
 * Tenant isolation: the SQLBox tables are engine-owned and carry no tenant
 * column, so EVERY read and write here is constrained to the engine ids found
 * in the caller's RLS-scoped `smsc_definitions` rows. Engine-reported binds the
 * tenant does not own are omitted from the response entirely.
 */
@Injectable()
export class QueueConsoleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly kamex: KamexAdapter,
    private readonly engines: EngineAdapterRegistry,
  ) {}

  /** SMSCs owned by the tenant. Read inside a tenant transaction, so RLS applies. */
  private tenantBinds(tenantId: string): Promise<TenantBind[]> {
    return this.database.tenantTransaction(tenantId, async (client) =>
      (
        await client.query<{ id: string; engine_id: string; name: string }>(
          'SELECT id,engine_id,name FROM smsc_definitions',
        )
      ).rows.map((row) => ({
        engineId: row.engine_id,
        smscId: String(row.id),
        smscName: row.name,
      })),
    );
  }

  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    entityId: string,
    newValue: unknown,
  ) {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [
        actor.tenantId,
        actor.userId,
        action,
        'message_queue',
        entityId,
        newValue ? JSON.stringify(newValue) : null,
      ],
    );
  }

  private record(actor: Actor, action: string, entityId: string, value: unknown) {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      this.audit(client, actor, action, entityId, value),
    );
  }

  private async requireSqlbox() {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      throw new ServiceUnavailableException(`SQLBox is not available: ${probe.evidence}`);
  }

  /**
   * Resolves the tenant's engine ids and validates that `targetSmscId` is one of
   * them. Rejecting here is what stops a caller pushing traffic onto a bind
   * belonging to somebody else.
   */
  private async resolveTarget(tenantId: string, targetSmscId: string) {
    const binds = await this.tenantBinds(tenantId);
    const allowed = binds.map((bind) => bind.engineId);
    if (!allowed.includes(targetSmscId))
      throw new BadRequestException('targetSmscId is not an SMSC owned by your tenant');
    return { binds, allowed };
  }

  /**
   * Live queue state: engine totals, the tenant's binds and the spool backlog.
   * Engine unavailability is reported through `source`, never as a 5xx — the
   * database-sourced spool figures stay useful when bearerbox is down.
   */
  async live(actor: Actor) {
    const [binds, snapshot] = await Promise.all([
      this.tenantBinds(actor.tenantId),
      this.kamex.queueSnapshot(),
    ]);
    const owned = new Map(binds.map((bind) => [bind.engineId, bind]));
    const allowed = binds.map((bind) => bind.engineId);

    const probe = await this.sqlbox.probe();
    const spool: { queued: number; oldestEpoch: number | null; bySmsc: SpoolBucket[] } =
      probe.available
        ? await (async () => {
            const [summary, bySmsc] = await Promise.all([
              this.sqlbox.queueSummary(allowed),
              this.sqlbox.spoolBySmsc(allowed),
            ]);
            return { queued: summary.queued, oldestEpoch: summary.oldestEpoch, bySmsc };
          })()
        : { queued: 0, oldestEpoch: null, bySmsc: [] };

    // The engine dominates the reported status because it is the only source of
    // bind detail; a healthy engine with a dead SQLBox is merely degraded.
    const source: { status: 'ok' | 'degraded' | 'unavailable'; detail: string } =
      snapshot.source.status === 'unavailable'
        ? snapshot.source
        : !probe.available
          ? { status: 'degraded', detail: `SQLBox is not available: ${probe.evidence}` }
          : snapshot.source;

    return {
      observedAt: snapshot.observedAt,
      engine: snapshot.engine,
      // Binds the engine reports but the tenant does not own are dropped here;
      // returning them would leak another tenant's carrier topology and traffic.
      binds: snapshot.binds
        .filter((bind) => owned.has(bind.engineId))
        .map((bind) => ({
          ...bind,
          known: true,
          smscId: owned.get(bind.engineId)!.smscId,
          smscName: owned.get(bind.engineId)!.smscName,
        })),
      spool,
      source,
    };
  }

  /**
   * The message log, classified by real delivery outcome and filterable by it.
   * This is the front door of the operator flow: filter to `resendable`
   * (failed + rejected), select, then POST resend against a healthy bind.
   * `counts` covers the whole filtered scope, not just the current page.
   */
  async history(actor: Actor, query: HistoryQuery = {}) {
    await this.requireSqlbox();
    const allowed = (await this.tenantBinds(actor.tenantId)).map((bind) => bind.engineId);
    const scope = {
      smscId: query.smscId,
      query: query.query,
      // The counts must describe the same window as the page, or the "12 need
      // resending" badge would be counting rows the grid is not showing.
      fromEpoch: query.fromEpoch,
      toEpoch: query.toEpoch,
      allowedSmscIds: allowed,
      excludeDlr: true,
    };
    const [page, counts] = await Promise.all([
      this.sqlbox.list({
        ...scope,
        status: query.status,
        limit: query.limit ?? 100,
        cursor: query.cursor,
      }),
      this.sqlbox.deliveryStatusCounts(scope),
    ]);
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      total: page.items.length,
      counts,
      appliedStatus: query.status ?? null,
    };
  }

  /** Paginated view of the still-spooled (not yet injected) messages. */
  async spool(actor: Actor, query: SpoolQuery = {}) {
    await this.requireSqlbox();
    const allowed = (await this.tenantBinds(actor.tenantId)).map((bind) => bind.engineId);
    return this.sqlbox.listQueue({ ...query, allowedSmscIds: allowed });
  }

  /**
   * True on-the-fly reroute of spooled messages onto another bind.
   *
   * A row that SQLBox already drained (measured: under a second) or that the
   * tenant does not own simply does not match the UPDATE. That is the COMMON
   * outcome, so it is modelled as a first-class result, never an error: every
   * requested id comes back in `results` with a machine-readable
   * {@link SKIP_DRAINED} code the UI can turn into "already handed to the
   * engine — resend it from the log instead".
   */
  async reroute(actor: Actor, request: RerouteRequest) {
    await this.requireSqlbox();
    const { allowed } = await this.resolveTarget(actor.tenantId, request.targetSmscId);
    const moved = await this.sqlbox.rerouteSpool(request.sqlIds, request.targetSmscId, allowed);
    const affected = new Set(moved.sqlIds);
    const results = request.sqlIds.map((sqlId) =>
      affected.has(sqlId)
        ? { sqlId, rerouted: true as const }
        : {
            sqlId,
            rerouted: false as const,
            code: SKIP_DRAINED,
            reason: DRAINED_REASON,
          },
    );
    const result = {
      requested: request.sqlIds.length,
      rerouted: moved.rerouted,
      skipped: request.sqlIds.length - moved.rerouted,
      targetSmscId: request.targetSmscId,
      results,
    };
    await this.record(actor, 'queue.rerouted', request.targetSmscId, {
      requested: result.requested,
      rerouted: result.rerouted,
      skipped: result.skipped,
      targetSmscId: request.targetSmscId,
      reroutedSqlIds: moved.sqlIds,
    });
    return result;
  }

  /**
   * Drops spooled messages before SQLBox can inject them into bearerbox. Subject
   * to the same sub-second drain race as {@link reroute}, and reported the same
   * way: a per-id result rather than a failure.
   */
  async cancel(actor: Actor, sqlIds: number[]) {
    await this.requireSqlbox();
    const allowed = (await this.tenantBinds(actor.tenantId)).map((bind) => bind.engineId);
    const removed = await this.sqlbox.cancelSpool(sqlIds, allowed);
    const affected = new Set(removed.sqlIds);
    const result = {
      requested: sqlIds.length,
      cancelled: removed.cancelled,
      skipped: sqlIds.length - removed.cancelled,
      results: sqlIds.map((sqlId) =>
        affected.has(sqlId)
          ? { sqlId, cancelled: true as const }
          : { sqlId, cancelled: false as const, code: SKIP_DRAINED, reason: DRAINED_REASON },
      ),
    };
    await this.record(actor, 'queue.cancelled', String(sqlIds[0] ?? ''), {
      requested: result.requested,
      cancelled: result.cancelled,
      skipped: result.skipped,
      cancelledSqlIds: removed.sqlIds,
    });
    return result;
  }

  /**
   * Resend already-sent messages against a different bind. THE PRIMARY OPERATOR
   * PATH: because the spool drains in under a second, this — not a tier-1
   * reroute — is how traffic actually gets moved off a sick bind in practice.
   *
   * History is terminal, so nothing is moved: each id produces a NEW `send_sms`
   * row pointed at `targetSmscId`, carrying the original sender/receiver/body
   * and DLR settings but a fresh correlation id.
   *
   * Every requested id yields exactly one entry in `results`, in request order,
   * with a machine-readable `code` on failure. One bad id never aborts the
   * batch — a submit that throws is captured against its own id and the rest of
   * the batch still runs.
   */
  async resend(actor: Actor, request: ResendRequest) {
    await this.requireSqlbox();
    const { allowed } = await this.resolveTarget(actor.tenantId, request.targetSmscId);
    // Two ways in: explicit ids, or "everything matching this delivery status".
    // The filter path resolves to concrete ids first so both paths share one
    // per-id result contract and the audit records exactly what was sent.
    const { ids, rows } = request.ids?.length
      ? { ids: request.ids, rows: await this.sqlbox.findSentForResend(request.ids, allowed) }
      : await (async () => {
          const filter = request.filter ?? {};
          const page = await this.sqlbox.list({
            smscId: filter.smscId,
            query: filter.query,
            cursor: filter.cursor,
            // Default to the failures an operator most likely wants moved.
            status: filter.status ?? 'resendable',
            excludeDlr: true,
            limit: filter.limit ?? MAX_RESEND_BATCH,
            allowedSmscIds: allowed,
          });
          return { ids: page.items.map((item) => item.id), rows: page.items };
        })();
    const results: ResendResult[] = [];
    for (const id of ids) {
      // A foreign_id can match both the original MT and its DLR; prefer the real
      // message so the resend carries the original payload rather than a receipt.
      const matches = rows.filter((row) => row.id === id || row.externalRef === id);
      const source = matches.find((row) => row.direction !== 'DLR') ?? matches[0];
      if (!source) {
        // Deliberately one code for both "no such row" and "owned by another
        // tenant": distinguishing them would confirm the existence of another
        // tenant's message.
        results.push({
          id,
          code: SKIP_NOT_FOUND,
          error: 'not found in the sent history visible to your tenant',
        });
        continue;
      }
      if (source.direction === 'DLR') {
        results.push({
          id,
          code: SKIP_DLR,
          error: 'delivery reports are receipts, not messages, and cannot be resent',
        });
        continue;
      }
      if (!source.receiver || source.text === null || source.text === undefined) {
        results.push({
          id,
          code: SKIP_INCOMPLETE,
          error: 'the logged message has no receiver or body to resend',
        });
        continue;
      }
      try {
        const queued = await this.sqlbox.submit({
          sender: source.sender,
          receiver: source.receiver,
          text: source.text,
          smscId: request.targetSmscId,
          dlrMask: source.dlrMask ?? undefined,
          dlrUrl: source.dlrUrl ?? undefined,
          // New correlation id so the resend is traceable on its own and its
          // delivery reports do not collide with the original message.
          foreignId: randomUUID(),
        });
        results.push({
          id,
          sqlId: queued.sqlId,
          originalSmscId: source.smscId,
          originalStatus: source.deliveryStatus,
        });
      } catch (error) {
        results.push({ id, code: SKIP_SUBMIT_FAILED, error: (error as Error).message });
      }
    }
    const resent = results.filter((entry) => 'sqlId' in entry).length;
    const result = {
      requested: ids.length,
      resent,
      skipped: ids.length - resent,
      targetSmscId: request.targetSmscId,
      // Echoed so the caller can tell a filtered resend apart from an explicit
      // one, and see which filter actually ran.
      appliedFilter: request.ids?.length ? null : { status: 'resendable', ...request.filter },
      results,
    };
    await this.record(actor, 'queue.resent', request.targetSmscId, {
      requested: result.requested,
      resent: result.resent,
      skipped: result.skipped,
      targetSmscId: request.targetSmscId,
      appliedFilter: result.appliedFilter,
      resentIds: results.filter((entry) => 'sqlId' in entry).map((entry) => entry.id),
    });
    return result;
  }

  /**
   * Stop / start / reconnect a single bind without restarting bearerbox. This is
   * the only lever over tier-2 (messages already inside bearerbox): disabling a
   * bad bind stops it draining, after which new traffic can be rerouted in the
   * spool and already-sent traffic replayed elsewhere with {@link resend}.
   */
  async controlBind(actor: Actor, engineId: string, operation: BindOperation) {
    const binds = await this.tenantBinds(actor.tenantId);
    const bind = binds.find((entry) => entry.engineId === engineId);
    // 404 rather than 403 so the endpoint does not confirm that a bind owned by
    // another tenant exists.
    if (!bind) throw new NotFoundException('SMSC bind not found for your tenant');
    const result = await this.engines
      .smscControl(process.env.ENGINE_IMPLEMENTATION ?? 'kamex')
      .controlSmsc(operation, engineId);
    await this.record(actor, `queue.bind.${operation}`, engineId, {
      engineId,
      smscId: bind.smscId,
      operation,
      accepted: result.accepted,
      detail: result.detail,
    });
    return result;
  }
}
