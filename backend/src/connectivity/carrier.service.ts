import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  collectConfigValueProblems,
  formatConfigValueProblem,
} from '../configuration/config-value-safety';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface CarrierInput {
  name: string;
  countryCode?: string | null;
  networkCode?: string | null;
  status?: 'active' | 'suspended' | 'retired';
  notes?: string | null;
}

export interface CarrierRow {
  id: string;
  name: string;
  country_code: string | null;
  network_code: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Health rolled up from the SMSCs beneath a carrier.
 *
 * The vocabulary is §3.3's, and the fourth value is the one that matters:
 * *"Unknown: telemetry stale or insufficient; never represent unknown as
 * healthy."* A carrier whose binds we cannot currently observe is `unknown`,
 * not `healthy` — the absence of a failure report is not a success report.
 */
export type CarrierHealth = 'healthy' | 'degraded' | 'critical' | 'unknown';

export interface CarrierSummary extends CarrierRow {
  smscCount: number;
  bindsHealthy: number;
  bindsTotal: number;
  /** Binds whose state has never been observed. Drives `unknown`. */
  bindsUnobserved: number;
  health: CarrierHealth;
  queuedMessages: number;
  failedMessages: number;
  /** Sum of configured per-SMSC TPS ceilings, or null when none is configured. */
  capacityTps: number | null;
  observedTps: number | null;
  utilisation: number | null;
  openAlerts: number;
}

const STATUSES = ['active', 'suspended', 'retired'];

/**
 * Bind states that count as serving traffic. Taken from the engine's own
 * vocabulary (monitoring-depth/engine-bind-state.ts) rather than re-derived,
 * so this cannot drift from what the poller writes.
 */
const HEALTHY_BIND_STATES = ['bound'];

@Injectable()
export class CarrierService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Validates operator input.
   *
   * `name` goes through the engine-configuration safety rules even though a
   * carrier name is never itself rendered into a Kannel file. It is displayed
   * everywhere and is a natural thing to paste a stray newline into, and having
   * one validation vocabulary across operator-typed identifiers is worth more
   * than the few characters this rejects.
   */
  validate(input: CarrierInput): string[] {
    const errors: string[] = [];
    const name = (input.name ?? '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name must be at most 120 characters');
    if (input.countryCode && !/^[A-Z]{2}$/.test(input.countryCode))
      errors.push('countryCode must be a two-letter ISO 3166-1 alpha-2 code, uppercase');
    // Leading zeros are significant in an MNC, so this is text and stays text.
    if (input.networkCode && !/^[0-9]{4,6}$/.test(input.networkCode))
      errors.push('networkCode must be 4-6 digits (MCC+MNC)');
    if (input.status && !STATUSES.includes(input.status))
      errors.push(`status must be one of ${STATUSES.join(', ')}`);
    for (const problem of collectConfigValueProblems([
      ['name', name],
      ['notes', input.notes],
    ]))
      errors.push(formatConfigValueProblem(problem));
    return errors;
  }

  async list(actor: Actor): Promise<CarrierSummary[]> {
    return this.database.tenantTransaction(actor.tenantId, async (client) =>
      this.summaries(client, actor.tenantId, null),
    );
  }

  async get(actor: Actor, id: string): Promise<CarrierSummary> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const [summary] = await this.summaries(client, actor.tenantId, id);
      if (!summary) throw new NotFoundException('Carrier not found');
      return summary;
    });
  }

  /**
   * The aggregation read model (§4.1).
   *
   * One query rather than a query per carrier: an estate of thirty carriers
   * would otherwise issue thirty-one round trips to paint one register, and the
   * register is polled.
   *
   * Every figure here is DERIVED at read time from the telemetry tables the
   * poller already maintains. None of it is stored on `carriers`, because a
   * stored copy can disagree with its own source and there is no way for an
   * operator to tell which of the two is lying.
   */
  private async summaries(
    client: PoolClient,
    tenantId: string,
    onlyId: string | null,
  ): Promise<CarrierSummary[]> {
    const params: unknown[] = [tenantId];
    let filter = '';
    if (onlyId) {
      params.push(onlyId);
      filter = ` AND c.id = $${params.length}::uuid`;
    }
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT c.id::text, c.name, c.country_code, c.network_code, c.status, c.notes,
              c.created_at, c.updated_at,
              count(s.id) FILTER (WHERE s.id IS NOT NULL)                      AS smsc_count,
              count(b.smsc_id) FILTER (WHERE b.state = ANY($${params.length + 1}))  AS binds_healthy,
              count(s.id) FILTER (WHERE s.id IS NOT NULL AND s.enabled)        AS binds_total,
              count(s.id) FILTER (WHERE s.enabled AND b.state IS NULL)         AS binds_unobserved,
              COALESCE(sum(b.queued_count), 0)                                 AS queued_messages,
              COALESCE(sum(b.failed_count), 0)                                 AS failed_messages,
              sum(s.tps) FILTER (WHERE s.tps IS NOT NULL)                      AS capacity_tps,
              (SELECT count(*) FROM alert_instances a
                WHERE a.tenant_id = c.tenant_id AND a.resolved_at IS NULL
                  AND a.dedup_key = ANY(
                    SELECT 'engine:bind:' || s2.engine_id FROM smsc_definitions s2
                     WHERE s2.carrier_id = c.id AND s2.deleted_at IS NULL))    AS open_alerts,
              -- Observed throughput, summed across the carrier's binds from the
              -- LATEST snapshot of each. smsc_bind_snapshots has carried this
              -- since the poller was built; observedTps was hardcoded null here
              -- because nothing read it, not because it was unavailable.
              --
              -- NULL when no bind has ever been sampled, so the console can say
              -- "unknown" rather than reporting an unobserved carrier as idle.
              (SELECT sum(latest.outbound_rate) FROM smsc_definitions s3
                 CROSS JOIN LATERAL (
                   SELECT n.outbound_rate FROM smsc_bind_snapshots n
                    WHERE n.smsc_id = s3.id ORDER BY n.observed_at DESC LIMIT 1
                 ) latest
                WHERE s3.carrier_id = c.id AND s3.deleted_at IS NULL)          AS observed_tps,
              (SELECT sum(latest.inbound_rate) FROM smsc_definitions s4
                 CROSS JOIN LATERAL (
                   SELECT n.inbound_rate FROM smsc_bind_snapshots n
                    WHERE n.smsc_id = s4.id ORDER BY n.observed_at DESC LIMIT 1
                 ) latest
                WHERE s4.carrier_id = c.id AND s4.deleted_at IS NULL)          AS observed_tps_in,
              -- The newest bind transition across every SMSC this carrier owns:
              -- §4.1's "last connectivity event".
              (SELECT concat_ws(' ', t.engine_id, t.to_state,
                                to_char(t.observed_at, 'YYYY-MM-DD HH24:MI'))
                 FROM smsc_bind_transitions t
                 JOIN smsc_definitions s5 ON s5.id = t.smsc_id
                WHERE s5.carrier_id = c.id AND s5.deleted_at IS NULL
                ORDER BY t.observed_at DESC LIMIT 1)                           AS last_event
         FROM carriers c
         LEFT JOIN smsc_definitions s
                ON s.carrier_id = c.id AND s.deleted_at IS NULL
         LEFT JOIN smsc_bind_state b
                ON b.smsc_id = s.id
        WHERE c.tenant_id = $1 AND c.deleted_at IS NULL${filter}
        GROUP BY c.id
        ORDER BY c.name`,
      [...params, HEALTHY_BIND_STATES],
    );

    return rows.map((row) => {
      const smscCount = Number(row.smsc_count ?? 0);
      const bindsTotal = Number(row.binds_total ?? 0);
      const bindsHealthy = Number(row.binds_healthy ?? 0);
      const bindsUnobserved = Number(row.binds_unobserved ?? 0);
      const capacityTps = row.capacity_tps === null ? null : Number(row.capacity_tps);
      // Postgres returns SUM() over zero rows as NULL, which is exactly the
      // distinction wanted here: no bind sampled yet, rather than sampled at 0.
      const numberOrNull = (value: unknown) =>
        value === null || value === undefined ? null : Number(value);
      const observedTps = numberOrNull(row.observed_tps);
      return {
        id: String(row.id),
        name: String(row.name),
        country_code: (row.country_code as string) ?? null,
        network_code: (row.network_code as string) ?? null,
        status: String(row.status),
        notes: (row.notes as string) ?? null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        smscCount,
        bindsHealthy,
        bindsTotal,
        bindsUnobserved,
        health: carrierHealth({ bindsTotal, bindsHealthy, bindsUnobserved, smscCount }),
        queuedMessages: Number(row.queued_messages ?? 0),
        failedMessages: Number(row.failed_messages ?? 0),
        capacityTps,
        // Summed from the latest snapshot of each bind. NULL — not 0 — when no
        // bind has ever been sampled: "we have never looked" and "there is no
        // traffic" are different claims and the console renders them
        // differently.
        observedTps,
        observedTpsIn: numberOrNull(row.observed_tps_in),
        // Only a ratio when both halves are real. A utilisation computed
        // against a null numerator would read as 0% — a carrier at rest —
        // when the truth is that nothing was measured.
        utilisation:
          observedTps !== null && capacityTps !== null && capacityTps > 0
            ? observedTps / capacityTps
            : null,
        lastEvent: (row.last_event as string) ?? null,
        openAlerts: Number(row.open_alerts ?? 0),
      };
    });
  }

  async create(actor: Actor, input: CarrierInput): Promise<CarrierRow> {
    const errors = this.validate(input);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<CarrierRow>(
        `INSERT INTO carriers(tenant_id,name,country_code,network_code,status,notes,created_by)
         VALUES($1,$2,$3,$4,COALESCE($5,'active'),$6,$7)
         RETURNING id::text,name,country_code,network_code,status,notes,created_at,updated_at`,
        [
          actor.tenantId,
          input.name.trim(),
          input.countryCode ?? null,
          input.networkCode ?? null,
          input.status ?? null,
          input.notes ?? null,
          actor.userId,
        ],
      );
      await this.audit(client, actor, 'carrier.created', rows[0].id, input);
      return rows[0];
    });
  }

  async update(actor: Actor, id: string, input: Partial<CarrierInput>): Promise<CarrierRow> {
    const errors = this.validate({ name: 'placeholder', ...input } as CarrierInput).filter(
      // `name` is optional on an update; only validate it when supplied.
      (error) => input.name !== undefined || !error.startsWith('name'),
    );
    if (errors.length) throw new BadRequestException(errors.join('; '));
    // The SET clause is built from the keys actually PRESENT on the request,
    // not with COALESCE($n, column).
    //
    // COALESCE cannot express "clear this field": passing null to mean "leave
    // it alone" and passing null to mean "erase it" are the same value, so the
    // erase silently becomes a no-op and the endpoint returns 200 with the old
    // value still in place. An operator correcting a wrong network code would
    // be told it worked.
    const assignments: string[] = [];
    const params: unknown[] = [actor.tenantId, id];
    const set = (column: string, value: unknown) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (input.name !== undefined) set('name', input.name.trim());
    if (input.countryCode !== undefined) set('country_code', input.countryCode);
    if (input.networkCode !== undefined) set('network_code', input.networkCode);
    if (input.status !== undefined) set('status', input.status);
    if (input.notes !== undefined) set('notes', input.notes);
    if (!assignments.length) throw new BadRequestException('No fields to update');

    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<CarrierRow>(
        `UPDATE carriers SET ${assignments.join(', ')}, updated_at = now()
         WHERE id = $2::uuid AND tenant_id = $1 AND deleted_at IS NULL
         RETURNING id::text,name,country_code,network_code,status,notes,created_at,updated_at`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Carrier not found');
      await this.audit(client, actor, 'carrier.updated', id, input);
      return rows[0];
    });
  }

  /**
   * Soft delete. The SMSCs beneath survive with `carrier_id` cleared by the
   * foreign key's ON DELETE SET NULL — except this never actually deletes the
   * row, so the FK does not fire and the link has to be cleared explicitly.
   *
   * Both halves are in one transaction: an SMSC pointing at a deleted carrier
   * would vanish from the register (which filters deleted carriers out) while
   * still existing, which is the worst of both.
   */
  async remove(actor: Actor, id: string): Promise<{ id: string; smscsUnassigned: number }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const cleared = await client.query(
        'UPDATE smsc_definitions SET carrier_id = NULL WHERE carrier_id = $1::uuid',
        [id],
      );
      const { rowCount } = await client.query(
        'UPDATE carriers SET deleted_at = now() WHERE id = $1::uuid AND deleted_at IS NULL',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Carrier not found');
      await this.audit(client, actor, 'carrier.deleted', id, {
        smscsUnassigned: cleared.rowCount ?? 0,
      });
      return { id, smscsUnassigned: cleared.rowCount ?? 0 };
    });
  }

  /**
   * Attach or detach one SMSC. Returns the SMSC's new owner, or null.
   *
   * `expectedCarrierId` guards a detach against the carrier it was issued from.
   * Without it, `DELETE /carriers/A/smscs/X` detaches X from whatever carrier
   * currently holds it — so a stale browser tab showing carrier A, opened
   * before X was moved to carrier B, silently unfiles it from B instead. The
   * audit row would record a detach that looked entirely correct.
   */
  async assignSmsc(
    actor: Actor,
    smscId: string,
    carrierId: string | null,
    expectedCarrierId?: string,
  ): Promise<{ smscId: string; carrierId: string | null }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      if (carrierId) {
        const { rowCount } = await client.query(
          'SELECT 1 FROM carriers WHERE id = $1::uuid AND deleted_at IS NULL',
          [carrierId],
        );
        if (!rowCount) throw new NotFoundException('Carrier not found');
      }
      // Both the ownership check and the write are one statement, so the row
      // cannot be reassigned between reading it and updating it.
      const predicate = expectedCarrierId ? ' AND carrier_id = $3::uuid' : '';
      const params: unknown[] = [smscId, carrierId];
      if (expectedCarrierId) params.push(expectedCarrierId);
      const { rowCount } = await client.query(
        `UPDATE smsc_definitions SET carrier_id = $2, updated_at = now()
          WHERE id = $1::uuid AND deleted_at IS NULL${predicate}`,
        params,
      );
      if (!rowCount)
        throw new NotFoundException(
          expectedCarrierId
            ? 'SMSC not found on this carrier — it may have been moved since this page was loaded'
            : 'SMSC not found',
        );
      await this.audit(client, actor, 'carrier.smsc_assigned', smscId, { carrierId });
      return { smscId, carrierId };
    });
  }

  /** SMSCs with no carrier — surfaced, never guessed at. */
  async unassignedSmscs(actor: Actor) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id::text, engine_id, name, type, enabled, lifecycle_state
           FROM smsc_definitions
          WHERE carrier_id IS NULL AND deleted_at IS NULL
          ORDER BY name`,
      );
      return rows;
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
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.tenantId, actor.userId, action, 'carrier', entityId, JSON.stringify(value)],
    );
  }
}

/**
 * Rolls per-bind observations up into one carrier verdict (§3.3).
 *
 * Exported and pure so the rule is testable without a database, because the
 * `unknown` case is easy to get subtly wrong and expensive when it is: reporting
 * an unobservable carrier as healthy is precisely what §3.3 forbids.
 */
export function carrierHealth(input: {
  smscCount: number;
  bindsTotal: number;
  bindsHealthy: number;
  bindsUnobserved: number;
}): CarrierHealth {
  const { smscCount, bindsTotal, bindsHealthy, bindsUnobserved } = input;
  // A carrier with no SMSCs attached is not healthy — there is nothing to be
  // healthy. It is a configuration gap, and `unknown` says so without alarming.
  if (smscCount === 0 || bindsTotal === 0) return 'unknown';
  // Nothing observed at all: we know nothing, and saying otherwise is the
  // failure mode §3.3 names explicitly.
  if (bindsUnobserved === bindsTotal) return 'unknown';
  if (bindsHealthy === 0) return 'critical';
  if (bindsHealthy < bindsTotal) return 'degraded';
  // Every observed bind is up, but some binds were never observed — so we
  // cannot claim the carrier as a whole is healthy.
  if (bindsUnobserved > 0) return 'degraded';
  return 'healthy';
}
