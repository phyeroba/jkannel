import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

/**
 * The §12.1 event vocabulary, as constants rather than free strings at each
 * call site — so a typo produces a compile error instead of an event kind that
 * silently never matches a filter.
 */
export const EVENT_KINDS = {
  bindLost: 'smsc.bind.lost',
  bindRestored: 'smsc.bind.restored',
  bindFailed: 'smsc.bind.failed',
  sessionFlapping: 'smsc.session.flapping',
  smscSuspended: 'smsc.suspended',
  smscResumed: 'smsc.resumed',
  routeFailover: 'route.failover',
  queueThresholdCrossed: 'queue.threshold.crossed',
  queueRecovered: 'queue.threshold.recovered',
  dlrDegraded: 'dlr.quality.degraded',
  dlrRecovered: 'dlr.quality.recovered',
  serviceRestarted: 'service.restarted',
  controlPlaneFailure: 'control.failure',
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

export interface EventInput {
  kind: EventKind | string;
  severity?: 'info' | 'warning' | 'critical';
  summary: string;
  detail?: Record<string, unknown>;
  subjectType?: string | null;
  subjectId?: string | null;
  correlationId?: string | null;
}

export interface EventQuery {
  limit?: number;
  /** Prefix match, so `smsc.` returns every SMSC event. */
  kindPrefix?: string;
  severity?: string;
  subjectType?: string;
  subjectId?: string;
  correlationId?: string;
  since?: string;
}

@Injectable()
export class OperationalEventsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Records an event on an EXISTING transaction.
   *
   * This is the form emitters should use. An event describing a state change
   * belongs in the same commit as the change: recorded separately, a crash
   * between the two leaves either an event for something that did not happen or
   * a change nothing observed, and both are worse than no event.
   */
  async recordOn(client: PoolClient, actor: Actor, event: EventInput): Promise<void> {
    await client.query(
      `INSERT INTO operational_events
         (tenant_id, kind, severity, summary, detail, subject_type, subject_id, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        actor.tenantId,
        event.kind,
        event.severity ?? 'info',
        event.summary,
        JSON.stringify(event.detail ?? {}),
        event.subjectType ?? null,
        event.subjectId ?? null,
        event.correlationId ?? null,
      ],
    );
  }

  /**
   * Records an event in its own transaction.
   *
   * Never throws. An observation failing to record must not fail the thing it
   * was observing — a bind poll that dies because its event insert hit a
   * constraint would turn a monitoring gap into an outage.
   */
  async record(actor: Actor, event: EventInput): Promise<void> {
    try {
      await this.database.tenantTransaction(actor.tenantId, (client) =>
        this.recordOn(client, actor, event),
      );
    } catch {
      /* Swallowed deliberately; see above. */
    }
  }

  async list(actor: Actor, query: EventQuery = {}) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (query.kindPrefix) add('kind LIKE ?', `${query.kindPrefix}%`);
    if (query.severity) add('severity = ?', query.severity);
    if (query.subjectType) add('subject_type = ?', query.subjectType);
    if (query.subjectId) add('subject_id = ?', query.subjectId);
    if (query.correlationId) add('correlation_id = ?::uuid', query.correlationId);
    if (query.since) add('observed_at >= ?::timestamptz', query.since);
    params.push(limit);

    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id::text, kind, severity, summary, detail, subject_type, subject_id,
                correlation_id::text, observed_at
           FROM operational_events
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY observed_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return { items: rows, limit };
    });
  }

  /**
   * Everything recorded under one correlation id, across events and alerts.
   *
   * This is the §12 payoff: one query answers "what happened during this
   * incident", where previously an operator could only go audit to logs and had
   * no path from an alert to anything at all.
   */
  async correlated(actor: Actor, correlationId: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const events = await client.query(
        `SELECT id::text, kind, severity, summary, detail, subject_type, subject_id, observed_at
           FROM operational_events WHERE correlation_id = $1::uuid ORDER BY observed_at`,
        [correlationId],
      );
      const alerts = await client.query(
        `SELECT id::text, dedup_key, severity, summary, opened_at, resolved_at
           FROM alert_instances WHERE correlation_id = $1::uuid ORDER BY opened_at`,
        [correlationId],
      );
      const audit = await client.query(
        `SELECT id::text, actor_id, action, entity_type, entity_id, created_at
           FROM audit_log WHERE correlation_id = $1::uuid ORDER BY created_at`,
        [correlationId],
      );
      return {
        correlationId,
        events: events.rows,
        alerts: alerts.rows,
        audit: audit.rows,
        note:
          'Structured logs for this correlation id are at ' +
          `GET /observability/logs?correlationId=${correlationId}. They are process-local and ` +
          'do not survive a restart, so an older incident may have events and audit entries here ' +
          'with no log lines.',
      };
    });
  }
}
