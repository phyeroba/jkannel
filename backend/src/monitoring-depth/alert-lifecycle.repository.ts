import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Actor } from './monitoring-depth.repository';

/** Every state an alert_instances row may occupy (migration 037). */
export type AlertStatus = 'open' | 'acknowledged' | 'suppressed' | 'resolved' | 'closed';

/**
 * Which statuses each lifecycle transition may be applied from. Anything else
 * is a 409 — resolving an already-resolved alert, reopening a live one, and so
 * on. Kept as data (not scattered `if`s) so the controller, the tests and a
 * reader all see the same table.
 */
export const ALERT_TRANSITIONS: Record<string, readonly AlertStatus[]> = {
  acknowledge: ['open', 'suppressed'],
  resolve: ['open', 'acknowledged', 'suppressed'],
  assign: ['open', 'acknowledged', 'suppressed'],
  suppress: ['open', 'acknowledged', 'suppressed'],
  reopen: ['acknowledged', 'suppressed', 'resolved', 'closed'],
  close: ['open', 'acknowledged', 'suppressed', 'resolved'],
};

const MAX_SUPPRESS_MINUTES = 60 * 24 * 30; // 30 days
const MAX_COMMENT_LENGTH = 4000;

export interface AlertRecord {
  id: string;
  status: AlertStatus;
  severity: string;
  summary: string;
  assignedTo: string | null;
  assignedToUsername: string | null;
  assignedAt: string | null;
  suppressedUntil: string | null;
  suppressedReason: string | null;
  notificationState: string;
  notificationDetail: Record<string, unknown>;
  openedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
  escalatedAt: string | null;
  previousSeverity: string | null;
  dedupCount: number;
  correlationGroup: string | null;
  details: Record<string, unknown>;
}

export interface AlertComment {
  id: string;
  alertId: string;
  authorId: string;
  authorUsername: string | null;
  body: string;
  kind: 'comment' | 'transition';
  createdAt: string;
}

interface AlertRow {
  id: string;
  status: AlertStatus;
  severity: string;
  summary: string;
  assigned_to: string | null;
  assigned_to_username: string | null;
  assigned_at: string | null;
  suppressed_until: string | null;
  suppressed_reason: string | null;
  notification_state: string;
  notification_detail: Record<string, unknown> | null;
  opened_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  reopen_count: number | string | null;
  escalated_at: string | null;
  previous_severity: string | null;
  dedup_count: number | string | null;
  correlation_group: string | null;
  details: Record<string, unknown> | null;
}

const SELECT_ALERT = `SELECT id, status, severity, summary, assigned_to, assigned_to_username,
        assigned_at, suppressed_until, suppressed_reason, notification_state,
        notification_detail, opened_at, resolved_at, closed_at, reopen_count,
        escalated_at, previous_severity, dedup_count, correlation_group, details
   FROM alert_instances`;

/** Maps the snake_case row onto the camelCase shape the API contract fixes. */
export function toAlertRecord(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    assignedTo: row.assigned_to ?? null,
    assignedToUsername: row.assigned_to_username ?? null,
    assignedAt: row.assigned_at ?? null,
    suppressedUntil: row.suppressed_until ?? null,
    suppressedReason: row.suppressed_reason ?? null,
    notificationState: row.notification_state ?? 'pending',
    notificationDetail: row.notification_detail ?? {},
    openedAt: row.opened_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    closedAt: row.closed_at ?? null,
    reopenCount: Number(row.reopen_count ?? 0),
    escalatedAt: row.escalated_at ?? null,
    previousSeverity: row.previous_severity ?? null,
    dedupCount: Number(row.dedup_count ?? 1),
    correlationGroup: row.correlation_group ?? null,
    details: row.details ?? {},
  };
}

/**
 * The alert lifecycle: acknowledge, resolve, assign, suppress, reopen, close
 * and comment.
 *
 * Before this existed an alert could only be acknowledged — there was no way to
 * record who owned an incident, to park a known-noisy one, or to write down what
 * was found. Each transition here is:
 *
 *   * tenant-scoped — every statement runs inside `tenantTransaction`, so RLS
 *     applies and one tenant can never move another tenant's alert;
 *   * guarded — an illegal transition (resolving a resolved alert, reopening a
 *     live one) raises 409 rather than silently doing nothing;
 *   * audited — an audit_log row plus a `kind='transition'` comment, so the
 *     alert's own thread reads as the incident's history.
 *
 * Suppression parks an alert *without hiding it*: status becomes 'suppressed'
 * and `suppressed_until` is set. The alert still appears in the open-alert
 * index and the correlation summary; only escalation skips it, and
 * AlertEscalationService returns it to 'open' once the window lapses.
 */
@Injectable()
export class AlertLifecycleRepository {
  constructor(private readonly database: DatabaseService) {}

  private inTenant<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.tenantTransaction(actor.tenantId, work);
  }

  private async audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    alertId: string,
    oldValue: unknown,
    newValue: unknown,
    reason?: string,
  ): Promise<void> {
    await client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor.tenantId,
        actor.userId,
        action,
        'alert',
        alertId,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason ?? null,
      ],
    );
  }

  private async loadForUpdate(client: PoolClient, id: string): Promise<AlertRow> {
    const row = (await client.query<AlertRow>(`${SELECT_ALERT} WHERE id=$1 FOR UPDATE`, [id]))
      .rows[0];
    if (!row) throw new NotFoundException('Alert not found');
    return row;
  }

  /** Raises 409 with the offending state named, so the client can explain it. */
  private assertTransition(transition: keyof typeof ALERT_TRANSITIONS, row: AlertRow): void {
    const allowed = ALERT_TRANSITIONS[transition];
    if (!allowed.includes(row.status))
      throw new ConflictException(
        `Cannot ${transition} an alert that is ${row.status} (allowed from: ${allowed.join(', ')})`,
      );
  }

  /** Appends the machine-written half of the comment thread. */
  private async appendTransitionComment(
    client: PoolClient,
    actor: Actor,
    alertId: string,
    body: string,
  ): Promise<void> {
    await client.query(
      'INSERT INTO alert_comments(tenant_id,alert_id,author_id,author_username,body,kind) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.tenantId, alertId, actor.userId, actor.username ?? null, body, 'transition'],
    );
  }

  async get(actor: Actor, id: string): Promise<AlertRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (await client.query<AlertRow>(`${SELECT_ALERT} WHERE id=$1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Alert not found');
      return toAlertRecord(row);
    });
  }

  /**
   * open|suppressed -> acknowledged. Also writes the alert_acknowledgements row
   * the console's existing /alerts/:id/acknowledgements endpoint reads, so both
   * routes stay consistent.
   */
  async acknowledge(actor: Actor, id: string, note?: string): Promise<AlertRecord> {
    return this.inTenant(actor, async (client) => {
      const before = await this.loadForUpdate(client, id);
      this.assertTransition('acknowledge', before);
      await client.query(
        `INSERT INTO alert_acknowledgements(tenant_id,alert_id,actor_id,note) VALUES($1,$2,$3,$4)
         ON CONFLICT(tenant_id,alert_id) DO UPDATE SET note=EXCLUDED.note,actor_id=EXCLUDED.actor_id,acknowledged_at=now()`,
        [actor.tenantId, id, actor.userId, note ?? null],
      );
      const after = (
        await client.query<AlertRow>(
          `UPDATE alert_instances
              SET status='acknowledged', suppressed_until=NULL
            WHERE id=$1
            RETURNING id, status, severity, summary, assigned_to, assigned_to_username,
                      assigned_at, suppressed_until, suppressed_reason, notification_state,
                      notification_detail, opened_at, resolved_at, closed_at, reopen_count,
                      escalated_at, previous_severity, dedup_count, correlation_group, details`,
          [id],
        )
      ).rows[0];
      await this.appendTransitionComment(
        client,
        actor,
        id,
        note ? `Acknowledged: ${note}` : 'Acknowledged',
      );
      await this.audit(client, actor, 'alert.acknowledged', id, before, after, note);
      return toAlertRecord(after);
    });
  }

  /** open|acknowledged|suppressed -> resolved. */
  async resolve(actor: Actor, id: string, note?: string): Promise<AlertRecord> {
    return this.inTenant(actor, async (client) => {
      const before = await this.loadForUpdate(client, id);
      this.assertTransition('resolve', before);
      const after = (
        await client.query<AlertRow>(
          `UPDATE alert_instances
              SET status='resolved', resolved_at=now(), suppressed_until=NULL
            WHERE id=$1
            RETURNING id, status, severity, summary, assigned_to, assigned_to_username,
                      assigned_at, suppressed_until, suppressed_reason, notification_state,
                      notification_detail, opened_at, resolved_at, closed_at, reopen_count,
                      escalated_at, previous_severity, dedup_count, correlation_group, details`,
          [id],
        )
      ).rows[0];
      await this.appendTransitionComment(
        client,
        actor,
        id,
        note ? `Resolved: ${note}` : 'Resolved',
      );
      await this.audit(client, actor, 'alert.resolved', id, before, after, note);
      return toAlertRecord(after);
    });
  }

  /**
   * Assigns ownership. `assignee` is a username or a user id; it is resolved
   * against the tenant's own users (RLS-scoped), so an alert can never be
   * assigned to somebody in another tenant. An unknown assignee is a 404 rather
   * than a free-text field that looks assigned but reaches nobody.
   */
  async assign(actor: Actor, id: string, assignee: string): Promise<AlertRecord> {
    return this.inTenant(actor, async (client) => {
      const before = await this.loadForUpdate(client, id);
      this.assertTransition('assign', before);
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assignee);
      const user = (
        await client.query<{ id: string; username: string }>(
          `SELECT id::text AS id, username FROM users
            WHERE (lower(username)=lower($1) OR ($2 AND id::text=$1))
              AND status <> 'deleted'
            LIMIT 1`,
          [assignee, isUuid],
        )
      ).rows[0];
      if (!user) throw new NotFoundException(`No user '${assignee}' in this tenant`);
      const after = (
        await client.query<AlertRow>(
          `UPDATE alert_instances
              SET assigned_to=$2, assigned_to_username=$3, assigned_by=$4, assigned_at=now()
            WHERE id=$1
            RETURNING id, status, severity, summary, assigned_to, assigned_to_username,
                      assigned_at, suppressed_until, suppressed_reason, notification_state,
                      notification_detail, opened_at, resolved_at, closed_at, reopen_count,
                      escalated_at, previous_severity, dedup_count, correlation_group, details`,
          [id, user.id, user.username, actor.userId],
        )
      ).rows[0];
      await this.appendTransitionComment(client, actor, id, `Assigned to ${user.username}`);
      await this.audit(client, actor, 'alert.assigned', id, before, after);
      return toAlertRecord(after);
    });
  }

  /**
   * Parks the alert for `minutes`. It stays visible everywhere it was visible
   * before; escalation is what stops. Requires system.manage at the controller.
   */
  async suppress(actor: Actor, id: string, minutes: number, reason?: string): Promise<AlertRecord> {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_SUPPRESS_MINUTES)
      throw new ConflictException(`minutes must be between 1 and ${MAX_SUPPRESS_MINUTES}`);
    return this.inTenant(actor, async (client) => {
      const before = await this.loadForUpdate(client, id);
      this.assertTransition('suppress', before);
      const after = (
        await client.query<AlertRow>(
          `UPDATE alert_instances
              SET status='suppressed',
                  suppressed_until=now() + ($2 || ' minutes')::interval,
                  suppressed_reason=$3,
                  suppressed_by=$4
            WHERE id=$1
            RETURNING id, status, severity, summary, assigned_to, assigned_to_username,
                      assigned_at, suppressed_until, suppressed_reason, notification_state,
                      notification_detail, opened_at, resolved_at, closed_at, reopen_count,
                      escalated_at, previous_severity, dedup_count, correlation_group, details`,
          [id, String(Math.floor(minutes)), reason ?? null, actor.userId],
        )
      ).rows[0];
      await this.appendTransitionComment(
        client,
        actor,
        id,
        `Suppressed for ${Math.floor(minutes)} minute(s)${reason ? `: ${reason}` : ''}`,
      );
      await this.audit(client, actor, 'alert.suppressed', id, before, after, reason);
      return toAlertRecord(after);
    });
  }

  /** acknowledged|suppressed|resolved|closed -> open. */
  async reopen(actor: Actor, id: string, reason?: string): Promise<AlertRecord> {
    return this.inTenant(actor, async (client) => {
      const before = await this.loadForUpdate(client, id);
      this.assertTransition('reopen', before);
      const after = (
        await client.query<AlertRow>(
          `UPDATE alert_instances
              SET status='open', resolved_at=NULL, closed_at=NULL, closed_by=NULL,
                  suppressed_until=NULL, suppressed_reason=NULL, suppressed_by=NULL,
                  reopened_at=now(), reopen_count=reopen_count+1,
                  -- A new notification cycle: the escalation chain runs again
                  -- for the reopened alert instead of staying exhausted.
                  escalation_cycle=escalation_cycle+1,
                  notification_state='pending'
            WHERE id=$1
            RETURNING id, status, severity, summary, assigned_to, assigned_to_username,
                      assigned_at, suppressed_until, suppressed_reason, notification_state,
                      notification_detail, opened_at, resolved_at, closed_at, reopen_count,
                      escalated_at, previous_severity, dedup_count, correlation_group, details`,
          [id],
        )
      ).rows[0];
      await this.appendTransitionComment(
        client,
        actor,
        id,
        reason ? `Reopened: ${reason}` : 'Reopened',
      );
      await this.audit(client, actor, 'alert.reopened', id, before, after, reason);
      return toAlertRecord(after);
    });
  }

  /** Terminal administrative close. Anything but an already-closed alert. */
  async close(actor: Actor, id: string, reason?: string): Promise<AlertRecord> {
    return this.inTenant(actor, async (client) => {
      const before = await this.loadForUpdate(client, id);
      this.assertTransition('close', before);
      const after = (
        await client.query<AlertRow>(
          `UPDATE alert_instances
              SET status='closed', closed_at=now(), closed_by=$2,
                  resolved_at=COALESCE(resolved_at, now()), suppressed_until=NULL
            WHERE id=$1
            RETURNING id, status, severity, summary, assigned_to, assigned_to_username,
                      assigned_at, suppressed_until, suppressed_reason, notification_state,
                      notification_detail, opened_at, resolved_at, closed_at, reopen_count,
                      escalated_at, previous_severity, dedup_count, correlation_group, details`,
          [id, actor.userId],
        )
      ).rows[0];
      await this.appendTransitionComment(
        client,
        actor,
        id,
        reason ? `Closed: ${reason}` : 'Closed',
      );
      await this.audit(client, actor, 'alert.closed', id, before, after, reason);
      return toAlertRecord(after);
    });
  }

  /** Appends an operator comment. Allowed in every state, including closed. */
  async addComment(actor: Actor, id: string, body: string): Promise<AlertComment> {
    const text = body.trim().slice(0, MAX_COMMENT_LENGTH);
    return this.inTenant(actor, async (client) => {
      const alert = (
        await client.query<{ id: string }>('SELECT id FROM alert_instances WHERE id=$1', [id])
      ).rows[0];
      if (!alert) throw new NotFoundException('Alert not found');
      const row = (
        await client.query<{
          id: string;
          alert_id: string;
          author_id: string;
          author_username: string | null;
          body: string;
          kind: 'comment' | 'transition';
          created_at: string;
        }>(
          `INSERT INTO alert_comments(tenant_id,alert_id,author_id,author_username,body,kind)
           VALUES($1,$2,$3,$4,$5,'comment')
           RETURNING id, alert_id, author_id, author_username, body, kind, created_at`,
          [actor.tenantId, id, actor.userId, actor.username ?? null, text],
        )
      ).rows[0];
      await this.audit(client, actor, 'alert.commented', id, null, { commentId: row.id });
      return {
        id: row.id,
        alertId: row.alert_id,
        authorId: row.author_id,
        authorUsername: row.author_username,
        body: row.body,
        kind: row.kind,
        createdAt: row.created_at,
      };
    });
  }

  /** Full thread, oldest first — it reads as the incident's history. */
  async listComments(actor: Actor, id: string): Promise<AlertComment[]> {
    return this.inTenant(actor, async (client) => {
      const alert = (
        await client.query<{ id: string }>('SELECT id FROM alert_instances WHERE id=$1', [id])
      ).rows[0];
      if (!alert) throw new NotFoundException('Alert not found');
      const rows = (
        await client.query<{
          id: string;
          alert_id: string;
          author_id: string;
          author_username: string | null;
          body: string;
          kind: 'comment' | 'transition';
          created_at: string;
        }>(
          `SELECT id, alert_id, author_id, author_username, body, kind, created_at
             FROM alert_comments WHERE alert_id=$1 ORDER BY created_at ASC, id ASC LIMIT 500`,
          [id],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        alertId: row.alert_id,
        authorId: row.author_id,
        authorUsername: row.author_username,
        body: row.body,
        kind: row.kind,
        createdAt: row.created_at,
      }));
    });
  }
}
