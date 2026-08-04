import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

export interface SqlboxSubmission {
  sender: string;
  receiver: string;
  text: string;
  smscId?: string;
  dlrMask?: number;
  dlrUrl?: string;
  foreignId?: string;
}
export interface SqlboxListOptions {
  limit?: number;
  cursor?: number;
  query?: string;
  /**
   * Accepts the legacy values ('sent' / 'dlr' / 'delivery_report', which filter
   * on momt) and the derived delivery statuses and group aliases below. Legacy
   * behaviour is unchanged.
   */
  status?: string;
  /** Derived delivery status filter; same vocabulary as `status`, applied explicitly. */
  deliveryStatus?: string | string[];
  smscId?: string;
  direction?: 'MO' | 'MT' | 'DLR';
  /** Excludes DLR receipt rows, leaving only real messages. */
  excludeDlr?: boolean;
  /**
   * Engine-level SMSC identifiers the caller's tenant owns. SQLBox tables are
   * engine-owned and carry no tenant column, so tenant isolation is applied by
   * restricting reads to these identifiers. undefined = unrestricted (system
   * use); an empty array yields no rows.
   */
  allowedSmscIds?: string[];
}

/**
 * Delivery status derived by correlating an MT row with its delivery reports.
 * `queued` is a spool (send_sms) row and `delivery_report` is a DLR receipt row
 * — neither is a delivery outcome, they just keep every row classifiable.
 */
export type DeliveryStatus =
  | 'delivered'
  | 'failed'
  | 'rejected'
  | 'buffered'
  | 'accepted'
  | 'pending'
  | 'unknown'
  | 'queued'
  | 'delivery_report';

/** The delivery outcomes an MT row can be correlated to. */
export const DELIVERY_STATUSES: DeliveryStatus[] = [
  'delivered',
  'failed',
  'rejected',
  'buffered',
  'accepted',
  'pending',
  'unknown',
];

/**
 * Kannel DLR event values. CRITICAL: this mapping applies to `dlr_mask` ON A
 * DLR ROW only. On an MT row `dlr_mask` is the *requested* mask (31 = "report
 * every event"), which is a subscription, NOT a status — misreading it would
 * classify every message as "rejected".
 */
export const DLR_EVENT_STATUS: Readonly<Record<number, DeliveryStatus>> = {
  1: 'delivered',
  2: 'failed',
  4: 'buffered',
  8: 'accepted',
  16: 'rejected',
};

/**
 * Operator-facing groupings: "everything that needs resending" and "everything
 * still in flight", so the console can offer them as one click.
 */
export const DELIVERY_STATUS_GROUPS: Readonly<Record<string, DeliveryStatus[]>> = {
  resendable: ['failed', 'rejected'],
  failures: ['failed', 'rejected'],
  'in-flight': ['pending', 'buffered'],
  in_flight: ['pending', 'buffered'],
  inflight: ['pending', 'buffered'],
};

/** Legacy momt-based filters, handled by filters() rather than the derived column. */
const LEGACY_STATUS_TOKENS = ['sent', 'dlr', 'delivery_report'];

const statusTokens = (value: unknown): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);

/** True when the token is a status/group this repository understands. */
export function isKnownStatusToken(token: string): boolean {
  const value = token.trim().toLowerCase();
  return (
    LEGACY_STATUS_TOKENS.includes(value) ||
    value in DELIVERY_STATUS_GROUPS ||
    DELIVERY_STATUSES.includes(value as DeliveryStatus)
  );
}

/**
 * Expands a status/group expression into concrete delivery statuses. Legacy
 * momt tokens are ignored here because filters() already handles them, and an
 * expression that yields nothing returns undefined (= no derived filter).
 */
export function resolveDeliveryStatuses(value: unknown): DeliveryStatus[] | undefined {
  const resolved = new Set<DeliveryStatus>();
  for (const token of statusTokens(value)) {
    if (LEGACY_STATUS_TOKENS.includes(token)) continue;
    const group = DELIVERY_STATUS_GROUPS[token];
    if (group) group.forEach((status) => resolved.add(status));
    else if (DELIVERY_STATUSES.includes(token as DeliveryStatus))
      resolved.add(token as DeliveryStatus);
  }
  return resolved.size ? [...resolved] : undefined;
}

const MESSAGE_COLUMNS =
  'm.sql_id,m.momt,m.sender,m.receiver,m.msgdata,m.time,m.smsc_id,m.service,m.account,m.dlr_mask,m.dlr_url,m.boxc_id,m.foreign_id';

/**
 * Latest delivery report for the MT row `m`, correlated on foreign_id (the same
 * key trace() uses). Done as a LATERAL so one query classifies a whole page
 * instead of issuing a follow-up query per message; the foreign_id index
 * created by ensureIndexes() serves the lookup. Skipped for DLR rows so a
 * receipt never correlates to itself.
 */
const LATEST_DLR_JOIN = `LEFT JOIN LATERAL (
      SELECT r.dlr_mask,r.time
        FROM sent_sms r
       WHERE m.momt IS DISTINCT FROM 'DLR' AND m.foreign_id IS NOT NULL
         AND r.momt = 'DLR' AND r.foreign_id = m.foreign_id
       ORDER BY r.time DESC,r.sql_id DESC
       LIMIT 1
    ) d ON true`;

/** Derived status. An MT row with no DLR yet is pending, not failed. */
const DELIVERY_STATUS_SQL = `CASE
      WHEN m.momt = 'DLR' THEN 'delivery_report'
      WHEN d.dlr_mask IS NULL THEN 'pending'
      WHEN d.dlr_mask = 1 THEN 'delivered'
      WHEN d.dlr_mask = 2 THEN 'failed'
      WHEN d.dlr_mask = 4 THEN 'buffered'
      WHEN d.dlr_mask = 8 THEN 'accepted'
      WHEN d.dlr_mask = 16 THEN 'rejected'
      ELSE 'unknown' END`;

// dlr_event is the delivery EVENT: the DLR row's own mask, or the correlated
// DLR's mask for an MT row. Never the MT row's requested dlr_mask.
const DERIVED_COLUMNS = `CASE WHEN m.momt = 'DLR' THEN m.dlr_mask ELSE d.dlr_mask END AS dlr_event,d.time AS dlr_time,${DELIVERY_STATUS_SQL} AS delivery_status`;

const CLASSIFIED_MESSAGES = `SELECT ${MESSAGE_COLUMNS},${DERIVED_COLUMNS} FROM sent_sms m ${LATEST_DLR_JOIN}`;
export interface SqlboxRetentionOptions {
  olderThanDays?: number;
  dryRun?: boolean;
}
export interface VolumeBySmsc {
  smscId: string;
  messages: number;
  dlrs: number;
}

@Injectable()
export class KamexSqlboxRepository implements OnModuleDestroy {
  private readonly connectionString = process.env.KAMEX_SQLBOX_DATABASE_URL;
  private readonly pool = this.connectionString
    ? new Pool({
        connectionString: this.connectionString,
        max: 5,
        application_name: 'jkannel-sqlbox-adapter',
      })
    : undefined;
  async onModuleDestroy() {
    await this.pool?.end();
  }
  private required() {
    if (!this.pool) throw new Error('KAMEX_SQLBOX_DATABASE_URL is not configured');
    return this.pool;
  }
  async probe(): Promise<{ available: boolean; evidence: string }> {
    if (!this.pool)
      return { available: false, evidence: 'KAMEX_SQLBOX_DATABASE_URL is not configured' };
    try {
      const result = await this.pool.query<{ send_sms: string | null; sent_sms: string | null }>(
        "SELECT to_regclass('public.send_sms')::text send_sms,to_regclass('public.sent_sms')::text sent_sms",
      );
      const row = result.rows[0];
      return row.send_sms && row.sent_sms
        ? { available: true, evidence: 'PostgreSQL send_sms and sent_sms tables detected' }
        : { available: false, evidence: 'SQLBox tables have not been created yet' };
    } catch (error) {
      return { available: false, evidence: `SQLBox probe failed: ${(error as Error).message}` };
    }
  }
  /**
   * Derived delivery outcome. Only reads `delivery_status` when the query
   * actually performed the DLR correlation; an uncorrelated MT row is reported
   * as 'unknown' rather than guessed at from its own (requested) dlr_mask.
   */
  private deliveryStatusOf(row: any, source: 'sent_sms' | 'send_sms'): DeliveryStatus {
    if (source === 'send_sms') return 'queued';
    if (row.momt === 'DLR') return 'delivery_report';
    return typeof row.delivery_status === 'string'
      ? (row.delivery_status as DeliveryStatus)
      : 'unknown';
  }
  private normalize(row: any, source: 'sent_sms' | 'send_sms') {
    const epoch = Number(row.time);
    const dlrEvent =
      row.dlr_event === undefined || row.dlr_event === null ? null : Number(row.dlr_event);
    return {
      id: String(row.sql_id),
      source,
      externalRef: row.foreign_id ?? null,
      direction: row.momt ?? (source === 'send_sms' ? 'MT' : 'unknown'),
      sender: row.sender,
      receiver: row.receiver,
      text: row.msgdata,
      smscId: row.smsc_id ?? null,
      service: row.service ?? null,
      account: row.account ?? null,
      // The row's OWN mask. On an MT row this is the requested DLR mask (e.g.
      // 31 = all events), not an outcome — see deliveryStatus / dlrEvent.
      dlrMask: row.dlr_mask ?? null,
      dlrUrl: row.dlr_url ?? null,
      boxcId: row.boxc_id ?? null,
      timestamp: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null,
      // Unchanged legacy coarse status; existing callers depend on these values.
      status: source === 'send_sms' ? 'queued' : row.momt === 'DLR' ? 'delivery_report' : 'sent',
      deliveryStatus: this.deliveryStatusOf(row, source),
      /** Kannel DLR event value behind deliveryStatus, when one was correlated. */
      dlrEvent: Number.isFinite(dlrEvent as number) ? dlrEvent : null,
      dlrAt: row.dlr_time ? new Date(Number(row.dlr_time) * 1000).toISOString() : null,
      raw: row,
    };
  }
  /**
   * Base predicates. `prefix` qualifies the column names for queries that join
   * (the DLR correlation aliases sent_sms twice, so bare names are ambiguous).
   */
  private filters(options: SqlboxListOptions, params: any[], prefix = '') {
    const clauses: string[] = [];
    if (options.allowedSmscIds) {
      params.push(options.allowedSmscIds);
      clauses.push(`${prefix}smsc_id = ANY($${params.length})`);
    }
    if (options.cursor) {
      params.push(options.cursor);
      clauses.push(`${prefix}sql_id < $${params.length}`);
    }
    if (options.smscId) {
      params.push(options.smscId);
      clauses.push(`${prefix}smsc_id = $${params.length}`);
    }
    if (options.direction) {
      params.push(options.direction);
      clauses.push(`${prefix}momt = $${params.length}`);
    }
    if (options.excludeDlr) clauses.push(`${prefix}momt IS DISTINCT FROM 'DLR'`);
    if (options.status) {
      // Legacy momt-based values only; derived statuses are applied to the
      // computed delivery_status column by the caller.
      const status = String(options.status).toLowerCase();
      if (status === 'delivery_report' || status === 'dlr') clauses.push(`${prefix}momt = 'DLR'`);
      else if (status === 'sent') clauses.push(`${prefix}momt <> 'DLR'`);
    }
    if (options.query) {
      params.push(`%${options.query}%`);
      clauses.push(
        `(${prefix}sender ILIKE $${params.length} OR ${prefix}receiver ILIKE $${params.length} OR ${prefix}foreign_id ILIKE $${params.length} OR ${prefix}msgdata ILIKE $${params.length})`,
      );
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }
  /**
   * Message history with each MT row classified by its latest delivery report,
   * so the log can be filtered to failed / pending / delivered and so on.
   */
  async list(options: SqlboxListOptions | number = 100) {
    const settings = typeof options === 'number' ? { limit: options } : options;
    const size = Math.min(Math.max(settings.limit ?? 100, 1), 500);
    const params: any[] = [];
    const where = this.filters(settings, params, 'm.');
    const statuses = resolveDeliveryStatuses(settings.deliveryStatus ?? settings.status);
    let outer = '';
    if (statuses) {
      params.push(statuses);
      outer = `WHERE q.delivery_status = ANY($${params.length})`;
    }
    params.push(size + 1);
    const result = await this.required().query(
      `SELECT * FROM (${CLASSIFIED_MESSAGES} ${where}) q ${outer} ORDER BY q.sql_id DESC LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, size).map((row) => this.normalize(row, 'sent_sms'));
    return {
      items: rows,
      nextCursor: result.rows.length > size ? Number(result.rows[size].sql_id) : null,
    };
  }
  /**
   * Counts per derived delivery status for the filtered scope, so the console
   * can show "12 need resending" without paging the whole log. DLR receipt rows
   * are excluded — they are not messages. Every status is always present.
   */
  async deliveryStatusCounts(options: SqlboxListOptions = {}) {
    const params: any[] = [];
    const where = this.filters(
      { ...options, status: undefined, deliveryStatus: undefined, excludeDlr: true },
      params,
      'm.',
    );
    const result = await this.required().query<{ delivery_status: string; count: string }>(
      `SELECT q.delivery_status,count(*)::text count FROM (${CLASSIFIED_MESSAGES} ${where}) q GROUP BY q.delivery_status`,
      params,
    );
    const counts = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0])) as Record<
      DeliveryStatus,
      number
    >;
    for (const row of result.rows)
      if (row.delivery_status in counts)
        counts[row.delivery_status as DeliveryStatus] = Number(row.count);
    return {
      ...counts,
      resendable: counts.failed + counts.rejected,
      inFlight: counts.pending + counts.buffered,
    };
  }
  async trace(id: string, allowedSmscIds?: string[]) {
    const pool = this.required();
    const sent = await pool.query(
      `${CLASSIFIED_MESSAGES} WHERE m.sql_id::text=$1 OR m.foreign_id=$1 ORDER BY m.time,m.sql_id`,
      [id],
    );
    const queued = await pool.query(
      `SELECT sql_id,momt,sender,receiver,msgdata,time,smsc_id,service,account,dlr_mask,dlr_url,boxc_id,foreign_id FROM send_sms WHERE sql_id::text=$1 OR foreign_id=$1 ORDER BY time,sql_id`,
      [id],
    );
    let events = [
      ...queued.rows.map((row) => this.normalize(row, 'send_sms')),
      ...sent.rows.map((row) => this.normalize(row, 'sent_sms')),
    ];
    if (allowedSmscIds) {
      // The trace belongs to the tenant only if at least one event references
      // one of its SMSCs; engine-side rows without an smsc_id (not yet routed)
      // are included only alongside such an owned event.
      const owned = events.some((event) => event.smscId && allowedSmscIds.includes(event.smscId));
      events = owned
        ? events.filter((event) => !event.smscId || allowedSmscIds.includes(event.smscId))
        : [];
    }
    events = events.sort(
      (a, b) =>
        String(a.timestamp).localeCompare(String(b.timestamp)) || Number(a.id) - Number(b.id),
    );
    return {
      id,
      events,
      summary: {
        eventCount: events.length,
        // Derived from the visible (tenant-scoped) events so the endpoint does
        // not reveal the existence of other tenants' messages.
        hasQueuedCopy: events.some((event) => event.source === 'send_sms'),
        hasSentCopy: events.some((event) => event.source === 'sent_sms'),
        finalStatus: events.at(-1)?.status ?? 'not_found',
      },
    };
  }
  async exportCsv(options: SqlboxListOptions = {}) {
    const max = Number(process.env.SQLBOX_EXPORT_MAX_ROWS ?? 5000);
    const page = await this.list({ ...options, limit: Math.min(options.limit ?? max, max) });
    const header = [
      'id',
      'timestamp',
      'direction',
      'status',
      'sender',
      'receiver',
      'smscId',
      'externalRef',
      'text',
    ];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return {
      filename: `jkannel-sqlbox-${new Date().toISOString().slice(0, 10)}.csv`,
      rowCount: page.items.length,
      nextCursor: page.nextCursor,
      content: [
        header.join(','),
        ...page.items.map((item: any) => header.map((key) => escape(item[key])).join(',')),
      ].join('\r\n'),
    };
  }
  async retentionStatus(options: SqlboxRetentionOptions = {}) {
    const days = Math.min(
      Math.max(options.olderThanDays ?? Number(process.env.SQLBOX_RETENTION_DAYS ?? 90), 1),
      3650,
    );
    const cutoffEpoch = Math.floor(Date.now() / 1000) - days * 86400;
    const result = await this.required().query<{
      total: string;
      eligible: string;
      oldest: string | null;
      newest: string | null;
    }>(
      `SELECT count(*)::text total,count(*) FILTER (WHERE time < $1)::text eligible,min(time)::text oldest,max(time)::text newest FROM sent_sms`,
      [cutoffEpoch],
    );
    const row = result.rows[0];
    return {
      source: 'kamex-sqlbox',
      table: 'sent_sms',
      retentionDays: days,
      cutoffEpoch,
      cutoffAt: new Date(cutoffEpoch * 1000).toISOString(),
      totalRows: Number(row.total),
      eligibleRows: Number(row.eligible),
      oldestAt: row.oldest ? new Date(Number(row.oldest) * 1000).toISOString() : null,
      newestAt: row.newest ? new Date(Number(row.newest) * 1000).toISOString() : null,
      dryRun: options.dryRun ?? true,
    };
  }
  async applyRetention(options: SqlboxRetentionOptions = {}) {
    const status = await this.retentionStatus(options);
    if (options.dryRun !== false) return { ...status, deletedRows: 0, applied: false };
    const result = await this.required().query(`DELETE FROM sent_sms WHERE time < $1`, [
      status.cutoffEpoch,
    ]);
    return { ...status, deletedRows: result.rowCount ?? 0, applied: true };
  }
  async ensureIndexes() {
    await this.required().query(
      'CREATE INDEX IF NOT EXISTS jkannel_sqlbox_sent_sms_time_idx ON sent_sms(time DESC, sql_id DESC)',
    );
    await this.required().query(
      'CREATE INDEX IF NOT EXISTS jkannel_sqlbox_sent_sms_smsc_time_idx ON sent_sms(smsc_id, time DESC)',
    );
    await this.required().query(
      'CREATE INDEX IF NOT EXISTS jkannel_sqlbox_sent_sms_foreign_id_idx ON sent_sms(foreign_id)',
    );
    // Serves the latest-DLR LATERAL used to derive delivery status: partial on
    // the receipts, ordered so the correlation is an index-only top-1 lookup.
    await this.required().query(
      "CREATE INDEX IF NOT EXISTS jkannel_sqlbox_sent_sms_dlr_correlation_idx ON sent_sms(foreign_id, time DESC, sql_id DESC) WHERE momt = 'DLR'",
    );
    return {
      source: 'kamex-sqlbox',
      indexes: [
        'jkannel_sqlbox_sent_sms_time_idx',
        'jkannel_sqlbox_sent_sms_smsc_time_idx',
        'jkannel_sqlbox_sent_sms_foreign_id_idx',
        'jkannel_sqlbox_sent_sms_dlr_correlation_idx',
      ],
    };
  }
  /** Lists queued (pending) messages from send_sms as a paginated grid. */
  async listQueue(options: SqlboxListOptions = {}) {
    const size = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const params: any[] = [];
    const clauses: string[] = [];
    if (options.allowedSmscIds) {
      params.push(options.allowedSmscIds);
      clauses.push(`smsc_id = ANY($${params.length})`);
    }
    if (options.cursor) {
      params.push(options.cursor);
      clauses.push(`sql_id < $${params.length}`);
    }
    if (options.smscId) {
      params.push(options.smscId);
      clauses.push(`smsc_id = $${params.length}`);
    }
    if (options.query) {
      params.push(`%${options.query}%`);
      clauses.push(
        `(sender ILIKE $${params.length} OR receiver ILIKE $${params.length} OR msgdata ILIKE $${params.length})`,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(size + 1);
    const result = await this.required().query(
      `SELECT sql_id,momt,sender,receiver,msgdata,time,smsc_id,service,account,dlr_mask,dlr_url,boxc_id,foreign_id FROM send_sms ${where} ORDER BY sql_id DESC LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, size).map((row) => this.normalize(row, 'send_sms'));
    return {
      items: rows,
      nextCursor: result.rows.length > size ? Number(result.rows[size].sql_id) : null,
      total: rows.length,
    };
  }

  async queueSummary(allowedSmscIds?: string[]) {
    const params: any[] = [];
    let where = '';
    if (allowedSmscIds) {
      params.push(allowedSmscIds);
      where = `WHERE smsc_id = ANY($${params.length})`;
    }
    const result = await this.required().query<{ queued: string; oldest_epoch: string | null }>(
      `SELECT count(*)::text queued,min(time)::text oldest_epoch FROM send_sms ${where}`,
      params,
    );
    return {
      queued: Number(result.rows[0].queued),
      oldestEpoch: result.rows[0].oldest_epoch ? Number(result.rows[0].oldest_epoch) : null,
    };
  }
  /**
   * Message and DLR counts for a time window, total and per SMSC. Used by the
   * scheduled volume reports; counts are always scoped to the tenant's SMSCs.
   */
  async volumeSummary(fromEpoch: number, toEpoch: number, allowedSmscIds: string[]) {
    if (!allowedSmscIds.length) return { messages: 0, dlrs: 0, bySmsc: [] as VolumeBySmsc[] };
    const result = await this.required().query<{
      smsc_id: string | null;
      messages: string;
      dlrs: string;
    }>(
      `SELECT smsc_id,
              count(*) FILTER (WHERE momt IS DISTINCT FROM 'DLR')::text messages,
              count(*) FILTER (WHERE momt = 'DLR')::text dlrs
         FROM sent_sms
        WHERE time >= $1 AND time < $2 AND smsc_id = ANY($3)
        GROUP BY smsc_id`,
      [fromEpoch, toEpoch, allowedSmscIds],
    );
    const bySmsc: VolumeBySmsc[] = result.rows.map((row) => ({
      smscId: row.smsc_id ?? 'unknown',
      messages: Number(row.messages),
      dlrs: Number(row.dlrs),
    }));
    return {
      messages: bySmsc.reduce((sum, row) => sum + row.messages, 0),
      dlrs: bySmsc.reduce((sum, row) => sum + row.dlrs, 0),
      bySmsc,
    };
  }

  /**
   * Pending spool depth grouped by engine SMSC id. Always pass the tenant's
   * allowed ids; an empty array yields no rows, undefined is system-wide.
   */
  async spoolBySmsc(allowedSmscIds?: string[]) {
    const params: any[] = [];
    let where = '';
    if (allowedSmscIds) {
      params.push(allowedSmscIds);
      where = `WHERE smsc_id = ANY($${params.length})`;
    }
    const result = await this.required().query<{ smsc_id: string | null; count: string }>(
      `SELECT smsc_id,count(*)::text count FROM send_sms ${where} GROUP BY smsc_id ORDER BY smsc_id`,
      params,
    );
    return result.rows.map((row) => ({
      smscId: row.smsc_id ?? 'unassigned',
      count: Number(row.count),
    }));
  }

  /**
   * On-the-fly reroute: repoints still-spooled messages at a different bind.
   * SQLBox picks the row up on its next poll, so no engine restart is involved.
   *
   * `allowedSmscIds` is a mandatory tenant-isolation predicate — a caller can
   * never move a row that is currently owned by another tenant's SMSC.
   *
   * MEASURED: SQLBox drains send_sms in well under a second, so on a healthy
   * system most requested ids will already be gone. The affected ids are
   * returned so the caller can report precisely which rows moved and which were
   * missed; a partial match is the normal outcome, never an error.
   */
  async rerouteSpool(sqlIds: number[], targetSmscId: string, allowedSmscIds: string[]) {
    if (!sqlIds.length || !allowedSmscIds.length) return { rerouted: 0, sqlIds: [] as number[] };
    const result = await this.required().query<{ sql_id: string }>(
      `UPDATE send_sms SET smsc_id=$1 WHERE sql_id = ANY($2::bigint[]) AND smsc_id = ANY($3) RETURNING sql_id::text`,
      [targetSmscId, sqlIds, allowedSmscIds],
    );
    const affected = result.rows.map((row) => Number(row.sql_id));
    return { rerouted: affected.length, sqlIds: affected };
  }

  /**
   * Removes still-spooled messages before SQLBox injects them. Tenant-scoped,
   * and subject to the same sub-second drain race as {@link rerouteSpool}, so
   * the ids actually deleted are returned rather than just a count.
   */
  async cancelSpool(sqlIds: number[], allowedSmscIds: string[]) {
    if (!sqlIds.length || !allowedSmscIds.length) return { cancelled: 0, sqlIds: [] as number[] };
    const result = await this.required().query<{ sql_id: string }>(
      `DELETE FROM send_sms WHERE sql_id = ANY($1::bigint[]) AND smsc_id = ANY($2) RETURNING sql_id::text`,
      [sqlIds, allowedSmscIds],
    );
    const affected = result.rows.map((row) => Number(row.sql_id));
    return { cancelled: affected.length, sqlIds: affected };
  }

  /**
   * Loads history rows (by sql_id or foreign_id) that a resend can be built
   * from, restricted to the tenant's SMSCs. DLR rows are returned too so the
   * caller can report them as skipped rather than as "not found".
   */
  async findSentForResend(ids: string[], allowedSmscIds: string[]) {
    if (!ids.length || !allowedSmscIds.length) return [];
    const result = await this.required().query(
      `${CLASSIFIED_MESSAGES}
        WHERE (m.sql_id::text = ANY($1) OR m.foreign_id = ANY($1)) AND m.smsc_id = ANY($2)
        ORDER BY m.sql_id DESC`,
      [ids, allowedSmscIds],
    );
    return result.rows.map((row) => this.normalize(row, 'sent_sms'));
  }

  async submit(value: SqlboxSubmission) {
    const result = await this.required().query<{ sql_id: string }>(
      `INSERT INTO send_sms(momt,sender,receiver,msgdata,time,smsc_id,dlr_mask,dlr_url,foreign_id) VALUES('MT',$1,$2,$3,extract(epoch from now())::bigint,$4,$5,$6,$7) RETURNING sql_id::text`,
      [
        value.sender,
        value.receiver,
        value.text,
        value.smscId ?? null,
        value.dlrMask ?? 31,
        value.dlrUrl ?? null,
        value.foreignId ?? null,
      ],
    );
    return { sqlId: result.rows[0].sql_id, status: 'queued', source: 'kamex-sqlbox' };
  }
}
