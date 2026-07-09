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
  status?: string;
  smscId?: string;
  direction?: 'MO' | 'MT' | 'DLR';
  /**
   * Engine-level SMSC identifiers the caller's tenant owns. SQLBox tables are
   * engine-owned and carry no tenant column, so tenant isolation is applied by
   * restricting reads to these identifiers. undefined = unrestricted (system
   * use); an empty array yields no rows.
   */
  allowedSmscIds?: string[];
}
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
  private normalize(row: any, source: 'sent_sms' | 'send_sms') {
    const epoch = Number(row.time);
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
      dlrMask: row.dlr_mask ?? null,
      dlrUrl: row.dlr_url ?? null,
      boxcId: row.boxc_id ?? null,
      timestamp: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null,
      status: source === 'send_sms' ? 'queued' : row.momt === 'DLR' ? 'delivery_report' : 'sent',
      raw: row,
    };
  }
  private filters(options: SqlboxListOptions, params: any[]) {
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
    if (options.direction) {
      params.push(options.direction);
      clauses.push(`momt = $${params.length}`);
    }
    if (options.status) {
      const status = String(options.status).toLowerCase();
      if (status === 'delivery_report' || status === 'dlr') clauses.push(`momt = 'DLR'`);
      else if (status === 'sent') clauses.push(`momt <> 'DLR'`);
    }
    if (options.query) {
      params.push(`%${options.query}%`);
      clauses.push(
        `(sender ILIKE $${params.length} OR receiver ILIKE $${params.length} OR foreign_id ILIKE $${params.length} OR msgdata ILIKE $${params.length})`,
      );
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }
  async list(options: SqlboxListOptions | number = 100) {
    const settings = typeof options === 'number' ? { limit: options } : options;
    const size = Math.min(Math.max(settings.limit ?? 100, 1), 500);
    const params: any[] = [];
    const where = this.filters(settings, params);
    params.push(size + 1);
    const result = await this.required().query(
      `SELECT sql_id,momt,sender,receiver,msgdata,time,smsc_id,service,account,dlr_mask,dlr_url,boxc_id,foreign_id FROM sent_sms ${where} ORDER BY sql_id DESC LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, size).map((row) => this.normalize(row, 'sent_sms'));
    return {
      items: rows,
      nextCursor: result.rows.length > size ? Number(result.rows[size].sql_id) : null,
    };
  }
  async trace(id: string, allowedSmscIds?: string[]) {
    const pool = this.required();
    const sent = await pool.query(
      `SELECT sql_id,momt,sender,receiver,msgdata,time,smsc_id,service,account,dlr_mask,dlr_url,boxc_id,foreign_id FROM sent_sms WHERE sql_id::text=$1 OR foreign_id=$1 ORDER BY time,sql_id`,
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
    return {
      source: 'kamex-sqlbox',
      indexes: [
        'jkannel_sqlbox_sent_sms_time_idx',
        'jkannel_sqlbox_sent_sms_smsc_time_idx',
        'jkannel_sqlbox_sent_sms_foreign_id_idx',
      ],
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
