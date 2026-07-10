import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface EscalationStep {
  afterMinutes: number;
  channelType: string;
  target: string;
  severity?: string;
}

/**
 * Tenant-scoped persistence for escalation policies, alert escalations, and
 * maintenance windows. Mirrors the ConsoleRepository conventions: every write
 * runs inside a tenant transaction (RLS enforced) and is audit-logged.
 */
@Injectable()
export class MonitoringDepthRepository {
  constructor(private readonly database: DatabaseService) {}

  private async inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.tenantTransaction(actor.tenantId, work);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A resource with that identity already exists');
      throw error;
    }
  }

  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    type: string,
    id: string,
    oldValue: unknown,
    newValue: unknown,
    reason?: string,
  ) {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor.tenantId,
        actor.userId,
        action,
        type,
        id,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }

  // ----- Escalation policies -------------------------------------------------

  listEscalationPolicies(actor: Actor) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            'SELECT id,name,steps,enabled,created_by,created_at,updated_at FROM escalation_policies ORDER BY enabled DESC,name',
          )
        ).rows,
    );
  }

  async getEscalationPolicy(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'SELECT id,name,steps,enabled,created_by,created_at,updated_at FROM escalation_policies WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Escalation policy not found');
      return row;
    });
  }

  async createEscalationPolicy(
    actor: Actor,
    value: { name: string; steps: EscalationStep[]; enabled?: boolean },
  ) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'INSERT INTO escalation_policies(tenant_id,name,steps,enabled,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,steps,enabled,created_by,created_at,updated_at',
          [
            actor.tenantId,
            value.name,
            JSON.stringify(value.steps),
            value.enabled ?? true,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'escalation_policy.created',
        'escalation_policy',
        row.id,
        null,
        row,
      );
      return row;
    });
  }

  async updateEscalationPolicy(
    actor: Actor,
    id: string,
    value: { name?: string; steps?: EscalationStep[]; enabled?: boolean; reason?: string },
  ) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM escalation_policies WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('Escalation policy not found');
      const row = (
        await c.query(
          `UPDATE escalation_policies
              SET name=COALESCE($2,name),
                  steps=COALESCE($3,steps),
                  enabled=COALESCE($4,enabled),
                  updated_at=now()
            WHERE id=$1
            RETURNING id,name,steps,enabled,created_by,created_at,updated_at`,
          [
            id,
            value.name ?? null,
            value.steps === undefined ? null : JSON.stringify(value.steps),
            value.enabled ?? null,
          ],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'escalation_policy.updated',
        'escalation_policy',
        id,
        old,
        row,
        value.reason,
      );
      return row;
    });
  }

  async deleteEscalationPolicy(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM escalation_policies WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('Escalation policy not found');
      await c.query('DELETE FROM alert_escalations WHERE policy_id=$1', [id]);
      await c.query('DELETE FROM escalation_policies WHERE id=$1', [id]);
      await this.audit(
        c,
        actor,
        'escalation_policy.deleted',
        'escalation_policy',
        id,
        old,
        null,
        reason,
      );
      return { id, deleted: true };
    });
  }

  listEscalationsForAlert(actor: Actor, alertId: string) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            `SELECT e.id,e.alert_id,e.policy_id,e.step_index,e.status,e.detail,e.escalated_at,p.name policy_name
               FROM alert_escalations e
               LEFT JOIN escalation_policies p ON p.id=e.policy_id
              WHERE e.alert_id=$1
              ORDER BY e.escalated_at DESC`,
            [alertId],
          )
        ).rows,
    );
  }

  // ----- Maintenance windows -------------------------------------------------

  listMaintenanceWindows(actor: Actor) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            'SELECT id,name,starts_at,ends_at,scope,reason,created_by,created_at,updated_at FROM maintenance_windows ORDER BY starts_at DESC',
          )
        ).rows,
    );
  }

  activeMaintenanceWindows(actor: Actor, now: Date = new Date()) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            'SELECT id,name,starts_at,ends_at,scope,reason FROM maintenance_windows WHERE starts_at<=$1 AND ends_at>$1 ORDER BY ends_at',
            [now],
          )
        ).rows,
    );
  }

  async getMaintenanceWindow(actor: Actor, id: string) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'SELECT id,name,starts_at,ends_at,scope,reason,created_by,created_at,updated_at FROM maintenance_windows WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Maintenance window not found');
      return row;
    });
  }

  async createMaintenanceWindow(
    actor: Actor,
    value: {
      name: string;
      startsAt: string;
      endsAt: string;
      scope?: Record<string, unknown>;
      reason?: string;
    },
  ) {
    return this.inTenant(actor, async (c) => {
      const row = (
        await c.query(
          'INSERT INTO maintenance_windows(tenant_id,name,starts_at,ends_at,scope,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,starts_at,ends_at,scope,reason,created_by,created_at,updated_at',
          [
            actor.tenantId,
            value.name,
            value.startsAt,
            value.endsAt,
            JSON.stringify(value.scope ?? {}),
            value.reason ?? null,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'maintenance_window.created',
        'maintenance_window',
        row.id,
        null,
        row,
      );
      return row;
    });
  }

  async updateMaintenanceWindow(
    actor: Actor,
    id: string,
    value: {
      name?: string;
      startsAt?: string;
      endsAt?: string;
      scope?: Record<string, unknown>;
      reason?: string;
    },
  ) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM maintenance_windows WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('Maintenance window not found');
      const row = (
        await c.query(
          `UPDATE maintenance_windows
              SET name=COALESCE($2,name),
                  starts_at=COALESCE($3,starts_at),
                  ends_at=COALESCE($4,ends_at),
                  scope=COALESCE($5,scope),
                  reason=COALESCE($6,reason),
                  updated_at=now()
            WHERE id=$1
            RETURNING id,name,starts_at,ends_at,scope,reason,created_by,created_at,updated_at`,
          [
            id,
            value.name ?? null,
            value.startsAt ?? null,
            value.endsAt ?? null,
            value.scope === undefined ? null : JSON.stringify(value.scope),
            value.reason ?? null,
          ],
        )
      ).rows[0];
      await this.audit(
        c,
        actor,
        'maintenance_window.updated',
        'maintenance_window',
        id,
        old,
        row,
        value.reason,
      );
      return row;
    });
  }

  async deleteMaintenanceWindow(actor: Actor, id: string, reason?: string) {
    return this.inTenant(actor, async (c) => {
      const old = (await c.query('SELECT * FROM maintenance_windows WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('Maintenance window not found');
      await c.query('DELETE FROM maintenance_windows WHERE id=$1', [id]);
      await this.audit(
        c,
        actor,
        'maintenance_window.deleted',
        'maintenance_window',
        id,
        old,
        null,
        reason,
      );
      return { id, deleted: true };
    });
  }

  // ----- Correlation ---------------------------------------------------------

  /** Summarises current (unresolved) alert groups by correlation_group. */
  correlationSummary(actor: Actor) {
    return this.inTenant(
      actor,
      async (c) =>
        (
          await c.query(
            `SELECT correlation_group,
                    count(*)::int AS alert_count,
                    sum(dedup_count)::int AS total_occurrences,
                    max(severity) AS max_severity,
                    min(opened_at) AS first_seen,
                    max(opened_at) AS last_seen,
                    array_agg(id::text ORDER BY opened_at DESC) AS alert_ids
               FROM alert_instances
              WHERE status <> 'resolved' AND correlation_group IS NOT NULL
              GROUP BY correlation_group
              ORDER BY alert_count DESC, last_seen DESC`,
          )
        ).rows,
    );
  }
}
