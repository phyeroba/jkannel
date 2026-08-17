import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { EVENT_KINDS, OperationalEventsService } from '../diagnostics/operational-events.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

/**
 * The impact an operator is shown BEFORE confirming (spec §1.1, UC-SMSC-01).
 *
 * UC-SMSC-01's UI requirement is blunt: "Confirmation dialog must show impact,
 * not just 'Are you sure?'". So impact is computed server-side and returned as
 * data — the console cannot be the only thing that knows what an action costs,
 * because then a script or a second client does not know at all.
 */
export interface ActionImpact {
  operation: string;
  subject: string;
  /** One sentence stating what will happen. */
  summary: string;
  /** Specific consequences, each already true of this system right now. */
  consequences: string[];
  /** Messages currently queued behind this object, when known. */
  queuedMessages: number | null;
  /** True when the action requires a typed reason. */
  reasonRequired: boolean;
  /** Set when the action cannot proceed at all. */
  blockedReason: string | null;
}

const MIN_REASON = 3;

/** Operations disruptive enough to demand a reason (§1.1, §16). */
const REASON_REQUIRED = new Set(['reconnect', 'disable', 'suspend', 'resume', 'failover']);

@Injectable()
export class SafeControlService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: OperationalEventsService,
  ) {}

  /** Validates a reason, or throws with a message naming what is missing. */
  static requireReason(operation: string, reason: unknown): string | null {
    if (!REASON_REQUIRED.has(operation)) return typeof reason === 'string' ? reason.trim() : null;
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < MIN_REASON)
      throw new BadRequestException(
        `${operation} requires a reason of at least ${MIN_REASON} characters. It is recorded in ` +
          'the audit trail and is what makes this action explicable afterwards.',
      );
    if (text.length > 500) throw new BadRequestException('reason must be at most 500 characters');
    return text;
  }

  /**
   * What an operation will cost, computed before it runs.
   *
   * Every consequence here is derived from current state rather than written as
   * a generic warning. "This will drop 412 queued messages" is an argument; "this
   * may be disruptive" is noise an operator learns to click through.
   */
  async describeImpact(actor: Actor, smscId: string, operation: string): Promise<ActionImpact> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT s.engine_id, s.name, s.enabled, s.connection_count,
                s.traffic_suspended_at, b.state, b.queued_count,
                (SELECT count(*) FROM routing_rules r
                  WHERE r.target_smsc_id = s.id OR r.fallback_smsc_id = s.id) AS route_count
           FROM smsc_definitions s
           LEFT JOIN smsc_bind_state b ON b.smsc_id = s.id
          WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
        [smscId],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('SMSC not found');

      const label = String(row.name ?? row.engine_id);
      const queued = row.queued_count === null ? null : Number(row.queued_count);
      const routes = Number(row.route_count ?? 0);
      const suspended = Boolean(row.traffic_suspended_at);
      const connections = Math.max(1, Number(row.connection_count ?? 1));
      const consequences: string[] = [];
      let summary = '';
      let blockedReason: string | null = null;

      switch (operation) {
        case 'reconnect':
          summary = `Reconnect ${label}: the bind is dropped and re-established.`;
          consequences.push(
            connections > 1
              ? `All ${connections} parallel connections on this SMSC are cycled together — the engine cannot restart one of them.`
              : 'The connection is closed and rebuilt.',
          );
          if (queued && queued > 0)
            consequences.push(
              `${queued} message(s) are queued on this bind. Messages already handed to the ` +
                'carrier and awaiting acknowledgement may be re-sent, so duplicates are possible.',
            );
          if (routes > 0)
            consequences.push(
              `${routes} route(s) target this SMSC. Traffic on them pauses until the bind is back.`,
            );
          break;
        case 'disable':
          summary = `Disable ${label}: it is removed from the generated engine configuration.`;
          consequences.push(
            'This is a configuration change, not a pause — the engine is redeployed without ' +
              'this SMSC. To stop traffic temporarily and reversibly, suspend it instead.',
          );
          if (routes > 0)
            consequences.push(`${routes} route(s) reference it and will have no target on it.`);
          break;
        case 'suspend':
          summary = `Suspend traffic on ${label}: JKANNEL stops submitting new messages to it.`;
          consequences.push(
            'The bind stays connected and the queue stays visible. Nothing is deployed, and ' +
              'resuming takes effect immediately.',
          );
          consequences.push(
            'Messages already in the engine continue to be delivered; this holds NEW submissions only.',
          );
          if (suspended) blockedReason = 'Traffic on this SMSC is already suspended.';
          break;
        case 'resume':
          summary = `Resume traffic on ${label}.`;
          consequences.push('New submissions start flowing to this SMSC again immediately.');
          if (!suspended) blockedReason = 'Traffic on this SMSC is not suspended.';
          break;
        default:
          summary = `${operation} on ${label}.`;
      }

      return {
        operation,
        subject: label,
        summary,
        consequences,
        queuedMessages: queued,
        reasonRequired: REASON_REQUIRED.has(operation),
        blockedReason,
      };
    });
  }

  /** Suspend or resume new submissions. Reversible, and not a deployment. */
  async setSuspended(actor: Actor, smscId: string, suspended: boolean, reason: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE smsc_definitions
            SET traffic_suspended_at = $3,
                traffic_suspended_by = $4,
                traffic_suspended_reason = $5,
                updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2 AND deleted_at IS NULL
          RETURNING engine_id, name, traffic_suspended_at`,
        [
          smscId,
          actor.tenantId,
          suspended ? new Date() : null,
          suspended ? actor.userId : null,
          suspended ? reason : null,
        ],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('SMSC not found');

      await this.audit(client, actor, suspended ? 'smsc.suspended' : 'smsc.resumed', smscId, {
        reason,
      });
      await this.events.recordOn(client, actor, {
        kind: suspended ? EVENT_KINDS.smscSuspended : EVENT_KINDS.smscResumed,
        severity: suspended ? 'warning' : 'info',
        summary: `${suspended ? 'Suspended' : 'Resumed'} traffic on ${row.name ?? row.engine_id}: ${reason}`,
        detail: { reason, actor: actor.userId },
        subjectType: 'smsc',
        subjectId: String(row.engine_id),
      });
      return {
        smscId,
        engineId: String(row.engine_id),
        suspended,
        suspendedAt: row.traffic_suspended_at ?? null,
      };
    });
  }

  /**
   * Move a route's traffic to another SMSC, deliberately (UC-RTE-02).
   *
   * Distinct from `fallback_smsc_id`, which the selector consults on its own
   * when the target is unhealthy. This holds even while the primary looks
   * fine — because the carrier asked, or because the operator does not trust it
   * yet — and it is visible and reversible rather than an edit to the route.
   */
  async failOver(actor: Actor, routeId: string, toSmscId: string, reason: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const route = (
        await client.query<Record<string, unknown>>(
          'SELECT id::text, name, target_smsc_id::text FROM routing_rules WHERE id = $1::uuid',
          [routeId],
        )
      ).rows[0];
      if (!route) throw new NotFoundException('Route not found');

      const target = (
        await client.query<Record<string, unknown>>(
          `SELECT s.id::text, s.engine_id, s.name, s.traffic_suspended_at, b.state
             FROM smsc_definitions s
             LEFT JOIN smsc_bind_state b ON b.smsc_id = s.id
            WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
          [toSmscId],
        )
      ).rows[0];
      if (!target) throw new NotFoundException('Target SMSC not found');

      if (route.target_smsc_id === toSmscId)
        throw new BadRequestException(
          'That is already this route’s target. A failover to the current target would appear ' +
            'in the audit trail as a change that did not happen.',
        );
      // UC-RTE-02: "If alternate target is unhealthy or lacks capacity, block or
      // strongly warn according to policy." A suspended target is a definite
      // block — moving traffic onto something an operator has deliberately
      // stopped is never what was meant.
      if (target.traffic_suspended_at)
        throw new BadRequestException(
          `Traffic on ${target.name ?? target.engine_id} is suspended, so it cannot receive a failover. ` +
            'Resume it first, or choose another target.',
        );

      await client.query(
        `UPDATE route_failovers SET ended_at = now(), ended_by = $2,
                end_reason = 'Superseded by a new failover'
          WHERE route_id = $1::uuid AND ended_at IS NULL`,
        [routeId, actor.userId],
      );
      const created = (
        await client.query<Record<string, unknown>>(
          `INSERT INTO route_failovers
             (tenant_id, route_id, from_smsc_id, to_smsc_id, reason, started_by)
           VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6)
           RETURNING id::text, started_at`,
          [
            actor.tenantId,
            routeId,
            (route.target_smsc_id as string) ?? null,
            toSmscId,
            reason,
            actor.userId,
          ],
        )
      ).rows[0];

      await this.audit(client, actor, 'route.failover', routeId, {
        to: toSmscId,
        from: route.target_smsc_id,
        reason,
      });
      await this.events.recordOn(client, actor, {
        kind: EVENT_KINDS.routeFailover,
        severity: 'warning',
        summary: `Route ${route.name} manually failed over to ${target.name ?? target.engine_id}: ${reason}`,
        detail: { reason, from: route.target_smsc_id, to: toSmscId, actor: actor.userId },
        subjectType: 'route',
        subjectId: String(route.id),
      });
      return {
        id: String(created.id),
        routeId,
        toSmscId,
        startedAt: created.started_at,
        // Stated because "the route configuration still says X" is the first
        // thing an operator notices afterwards and would otherwise read as a
        // failed action.
        note:
          'The route’s configured target is unchanged; this override sits on top of it and can ' +
          'be reverted without editing the route.',
      };
    });
  }

  /** Ends an active override; the route reverts to its configured target. */
  async revertFailover(actor: Actor, routeId: string, reason: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE route_failovers SET ended_at = now(), ended_by = $2, end_reason = $3
          WHERE route_id = $1::uuid AND ended_at IS NULL
          RETURNING id::text, to_smsc_id::text`,
        [routeId, actor.userId, reason],
      );
      if (!rows[0]) throw new NotFoundException('No active failover on this route');
      await this.audit(client, actor, 'route.failover.reverted', routeId, { reason });
      await this.events.recordOn(client, actor, {
        kind: EVENT_KINDS.routeFailover,
        severity: 'info',
        summary: `Manual failover reverted on route ${routeId}: ${reason}`,
        detail: { reason, actor: actor.userId },
        subjectType: 'route',
        subjectId: routeId,
      });
      return { routeId, reverted: true };
    });
  }

  /** Active overrides, so the console can always show the real active path. */
  async activeFailovers(actor: Actor) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.id::text, f.route_id::text, r.name AS route_name,
                f.from_smsc_id::text, f.to_smsc_id::text,
                t.engine_id AS to_engine_id, t.name AS to_name,
                f.reason, f.started_by, f.started_at
           FROM route_failovers f
           JOIN routing_rules r ON r.id = f.route_id
           LEFT JOIN smsc_definitions t ON t.id = f.to_smsc_id
          WHERE f.ended_at IS NULL
          ORDER BY f.started_at DESC`,
      );
      return { items: rows };
    });
  }

  private async audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    entityId: string,
    value: unknown,
  ) {
    await client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor.tenantId,
        actor.userId,
        action,
        action.startsWith('route') ? 'route' : 'smsc',
        entityId,
        JSON.stringify(value),
        (value as { reason?: string })?.reason ?? null,
      ],
    );
  }
}
