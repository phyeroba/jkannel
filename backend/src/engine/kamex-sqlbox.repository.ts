import {
  BadRequestException,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';
import { describeSegments } from './message-segments';

export interface SqlboxSubmission {
  sender: string;
  receiver: string;
  text: string;
  smscId?: string;
  dlrMask?: number;
  dlrUrl?: string;
  foreignId?: string;
  /**
   * `send_sms.deferred` — RELATIVE MINUTES to hold the message for, counted by
   * sqlbox from the moment it picks the row up. null leaves the column NULL,
   * which sqlbox decodes as SMS_PARAM_UNDEFINED ("no preference").
   *
   * This column is a request to the CARRIER (it becomes
   * submit_sm.schedule_delivery_time on an SMPP bind), which most refuse and the
   * `smsc = fake` bind ignores outright. It is NOT what makes "send later" work.
   *
   * Operator-facing scheduling is a JKANNEL-side hold: the message never reaches
   * this repository until its instant arrives (see
   * messaging-depth/scheduled-send.service.ts and ADR-0008 Amendment 1). By the
   * time a scheduled send is submitted here it is being sent NOW, so this field
   * is normally null even for one. Set it only to ask a carrier that genuinely
   * honours schedule_delivery_time to defer further on its own side.
   */
  deferredMinutes?: number | null;
  /**
   * `send_sms.validity` — RELATIVE MINUTES after which the carrier should stop
   * trying (submit_sm.validity_period on an SMPP bind). Same NULL semantics.
   */
  validityMinutes?: number | null;
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
  /**
   * Inclusive lower bound on the engine's epoch-second `time` column. Served by
   * the jkannel_sqlbox_sent_sms_time_idx / _smsc_time_idx indexes created by
   * {@link KamexSqlboxRepository.ensureIndexes}.
   */
  fromEpoch?: number;
  /** Inclusive upper bound on `time`. */
  toEpoch?: number;
  /** Excludes DLR receipt rows, leaving only real messages. */
  excludeDlr?: boolean;
  /**
   * Delivery-report view. Forces `direction = 'DLR'` and — the point of the
   * flag — decodes each receipt's OWN `dlr_mask` into a real delivery status
   * (delivered / failed / rejected / buffered / accepted) instead of the
   * catch-all `delivery_report`. Without it a status filter on the DLR grid can
   * only ever match `delivery_report`, which is why that grid offered "all" and
   * nothing else.
   */
  deliveryReport?: boolean;
  /**
   * Whitelisted sort expression, e.g. `-time` or `receiver,-sql_id`. Defaults
   * to `-sql_id`, which is the insertion order the keyset cursor pages on.
   * See {@link SQLBOX_SORT_COLUMNS}.
   */
  sort?: string;
  /**
   * Offset paging, for the sorts a `sql_id` keyset cannot express. Supplying it
   * switches the response to `{total, offset}` and costs a window count; the
   * default (cursor) path deliberately pays for neither.
   */
  offset?: number;
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

/**
 * Encoding / segmentation / scheduling / billing columns the engine has always
 * written and the console never selected: without them a multi-part message
 * could not be shown as multi-part, an 8-bit or UCS-2 body was indistinguishable
 * from plain text, and `binfo` (the carrier's billing identifier) was invisible.
 * Listed once so the sent_sms and send_sms projections cannot drift apart.
 */
const DETAIL_COLUMN_NAMES = [
  'coding',
  'charset',
  'udhdata',
  'validity',
  'deferred',
  'mclass',
  'pid',
  'binfo',
  'meta_data',
] as const;

const detailColumns = (prefix = '') =>
  DETAIL_COLUMN_NAMES.map((column) => `${prefix}${column}`).join(',');

const BASE_COLUMN_NAMES =
  'sql_id,momt,sender,receiver,msgdata,time,smsc_id,service,account,dlr_mask,dlr_url,boxc_id,foreign_id';

/** send_sms (spool) projection — same field set as the sent_sms one. */
const SPOOL_COLUMNS = `${BASE_COLUMN_NAMES},${detailColumns()}`;

const MESSAGE_COLUMNS = `${BASE_COLUMN_NAMES.split(',')
  .map((column) => `m.${column}`)
  .join(',')},${detailColumns('m.')}`;

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

/** Decodes a Kannel DLR event mask into a delivery status. `expr` must be SQL. */
const decodeDlrMask = (expr: string) => `CASE
      WHEN ${expr} = 1 THEN 'delivered'
      WHEN ${expr} = 2 THEN 'failed'
      WHEN ${expr} = 4 THEN 'buffered'
      WHEN ${expr} = 8 THEN 'accepted'
      WHEN ${expr} = 16 THEN 'rejected'
      ELSE 'unknown' END`;

/** Derived status for the message log. An MT row with no DLR yet is pending. */
const DELIVERY_STATUS_SQL = `CASE
      WHEN m.momt = 'DLR' THEN 'delivery_report'
      WHEN d.dlr_mask IS NULL THEN 'pending'
      ELSE (${decodeDlrMask('d.dlr_mask')}) END`;

/**
 * Derived status for the DELIVERY-REPORT view, where every row IS a receipt and
 * its own `dlr_mask` is the outcome — the one place reading `dlr_mask` off the
 * row itself is correct, because a DLR row's mask is the event that happened
 * rather than the events an MT row subscribed to.
 */
const RECEIPT_STATUS_SQL = `CASE
      WHEN m.momt IS DISTINCT FROM 'DLR' THEN 'unknown'
      WHEN m.dlr_mask IS NULL THEN 'unknown'
      ELSE (${decodeDlrMask('m.dlr_mask')}) END`;

// dlr_event is the delivery EVENT: the DLR row's own mask, or the correlated
// DLR's mask for an MT row. Never the MT row's requested dlr_mask.
const DERIVED_COLUMNS = (statusSql: string) =>
  `CASE WHEN m.momt = 'DLR' THEN m.dlr_mask ELSE d.dlr_mask END AS dlr_event,d.time AS dlr_time,${statusSql} AS delivery_status`;

/**
 * The classified projection. `receipts` swaps the derived `delivery_status` for
 * the receipt's own decoded outcome; everything else — columns, correlation,
 * predicates — is shared, so the delivery-report grid cannot drift away from
 * the message grid it is a view of.
 */
const classifiedMessages = (mode: 'history' | 'receipts' = 'history') =>
  `SELECT ${MESSAGE_COLUMNS},${DERIVED_COLUMNS(
    mode === 'receipts' ? RECEIPT_STATUS_SQL : DELIVERY_STATUS_SQL,
  )} FROM sent_sms m ${LATEST_DLR_JOIN}`;

const CLASSIFIED_MESSAGES = classifiedMessages('history');

/**
 * Sortable columns for the message / delivery-report grids: API name -> SQL
 * expression against the classified sub-select `q`. Whitelisted because the
 * expression is interpolated, never bound.
 *
 * `sql_id` is the physical insertion order and the only key the numeric cursor
 * can page on; every sort therefore carries `q.sql_id DESC` as its final
 * tiebreaker so a page boundary is always total.
 */
export const SQLBOX_SORT_COLUMNS: Readonly<Record<string, string>> = {
  time: 'q.time',
  timestamp: 'q.time',
  sql_id: 'q.sql_id',
  id: 'q.sql_id',
  sender: 'q.sender',
  receiver: 'q.receiver',
  smscId: 'q.smsc_id',
  direction: 'q.momt',
  deliveryStatus: 'q.delivery_status',
  externalRef: 'q.foreign_id',
};

/** The default ordering; also the only one the `sql_id` cursor is valid for. */
export const SQLBOX_DEFAULT_SORT = '-sql_id';

export interface SqlboxSortTerm {
  field: string;
  direction: 'ASC' | 'DESC';
}

/**
 * Parses a `sort` expression against {@link SQLBOX_SORT_COLUMNS}. An unknown
 * field is a 400 naming the allowed set rather than a silently ignored sort
 * that hands back rows in an order the caller did not ask for.
 */
export function parseSqlboxSort(value: unknown): SqlboxSortTerm[] {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  const tokens = (Array.isArray(value) ? value : String(value).split(','))
    .map((token) => String(token).trim())
    .filter(Boolean);
  return tokens.map((token) => {
    const direction: 'ASC' | 'DESC' = token.startsWith('-') ? 'DESC' : 'ASC';
    const field = token.replace(/^[-+]/, '');
    if (!SQLBOX_SORT_COLUMNS[field])
      throw new BadRequestException(
        `Unsupported sort field "${field}" (allowed: ${Object.keys(SQLBOX_SORT_COLUMNS).join(', ')})`,
      );
    return { field, direction };
  });
}

/** True when the sort is the default one the sql_id keyset cursor can page. */
function isDefaultSort(terms: SqlboxSortTerm[]): boolean {
  if (!terms.length) return true;
  return (
    terms.length === 1 &&
    SQLBOX_SORT_COLUMNS[terms[0].field] === 'q.sql_id' &&
    terms[0].direction === 'DESC'
  );
}

/**
 * The sent_sms indexes, as (create-clause) -> statement builders so the same
 * definitions serve both the manual endpoint and the boot path.
 *
 * A production audit found sent_sms carrying ONLY its primary key while the
 * message list ordered by `time DESC` and every DLR correlation joined on
 * `foreign_id`. Each entry below names the query it exists for.
 */
const SENT_SMS_INDEX_STATEMENTS: Array<(create: string) => string> = [
  // list(): unscoped `time >= x AND time <= y` range plus the sql_id paging.
  // EXPLAIN: Index Scan Backward instead of Seq Scan + Sort.
  (create) =>
    `${create} IF NOT EXISTS jkannel_sqlbox_sent_sms_time_idx ON sent_sms(time DESC, sql_id DESC)`,
  // list() as the console actually issues it: smsc_id = ANY(tenant binds) AND a
  // time range. Leading equality then range = one index scan per bind.
  (create) =>
    `${create} IF NOT EXISTS jkannel_sqlbox_sent_sms_smsc_time_idx ON sent_sms(smsc_id, time DESC)`,
  // trace() / findSentForResend(): WHERE foreign_id = $1.
  (create) =>
    `${create} IF NOT EXISTS jkannel_sqlbox_sent_sms_foreign_id_idx ON sent_sms(foreign_id)`,
  // The latest-DLR LATERAL that derives delivery status: partial on receipts,
  // ordered so the correlation is a top-1 index lookup per MT row rather than a
  // scan of every receipt sharing the foreign_id.
  (create) =>
    `${create} IF NOT EXISTS jkannel_sqlbox_sent_sms_dlr_correlation_idx ON sent_sms(foreign_id, time DESC, sql_id DESC) WHERE momt = 'DLR'`,
];

export const SENT_SMS_INDEX_NAMES = [
  'jkannel_sqlbox_sent_sms_time_idx',
  'jkannel_sqlbox_sent_sms_smsc_time_idx',
  'jkannel_sqlbox_sent_sms_foreign_id_idx',
  'jkannel_sqlbox_sent_sms_dlr_correlation_idx',
] as const;

/** Identifier quoting for the one place a name reaches SQL unbound (DROP INDEX). */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
export class KamexSqlboxRepository implements OnModuleDestroy, OnApplicationBootstrap {
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
    // The classified query's answer wins when there is one: in the message log
    // it says 'delivery_report' for a receipt row, and in the delivery-report
    // view it says what that receipt actually reported. Only a query that did
    // NOT correlate (no delivery_status column at all) falls through.
    if (typeof row.delivery_status === 'string' && row.delivery_status)
      return row.delivery_status as DeliveryStatus;
    if (row.momt === 'DLR') return 'delivery_report';
    return 'unknown';
  }
  /** Nullable numeric engine column -> number | null (never NaN, never 0-for-null). */
  private static number(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  private normalize(row: any, source: 'sent_sms' | 'send_sms') {
    const epoch = Number(row.time);
    const dlrEvent =
      row.dlr_event === undefined || row.dlr_event === null ? null : Number(row.dlr_event);
    const coding = KamexSqlboxRepository.number(row.coding);
    const udhData = row.udhdata ?? null;
    const segments = describeSegments({
      text: row.msgdata,
      coding,
      charset: row.charset,
      udhData,
    });
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
      // Encoding / segmentation / scheduling / billing (see DETAIL_COLUMN_NAMES).
      /** Kannel DCS coding: 0 = GSM-7, 1 = 8-bit, 2 = UCS-2. */
      coding,
      charset: row.charset ?? null,
      /** Raw User Data Header, present on concatenated and port-addressed parts. */
      udhData,
      /** Relative validity period in minutes, as submitted. */
      validity: KamexSqlboxRepository.number(row.validity),
      /** Deferred delivery offset in minutes. */
      deferred: KamexSqlboxRepository.number(row.deferred),
      /** Message class (0 = flash ... 3 = SIM). */
      mclass: KamexSqlboxRepository.number(row.mclass),
      /** Protocol identifier. */
      pid: KamexSqlboxRepository.number(row.pid),
      /** Carrier billing identifier, when the SMSC supplied one. */
      binfo: row.binfo ?? null,
      metaData: row.meta_data ?? null,
      /** Derived part count — see describeSegments for the GSM 03.38 rules. */
      segments: segments.segments,
      /** How that count was reached, so the console never has to guess. */
      segmentation: {
        alphabet: segments.alphabet,
        length: segments.length,
        singleCapacity: segments.singleCapacity,
        multipartCapacity: segments.multipartCapacity,
        declaredByUdh: segments.declaredByUdh,
      },
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
    // The delivery-report view IS the receipt rows, by definition; it pins the
    // direction so a caller cannot widen it back out with ?direction=MT.
    const direction = options.deliveryReport ? 'DLR' : options.direction;
    if (direction) {
      params.push(direction);
      clauses.push(`${prefix}momt = $${params.length}`);
    }
    // Inclusive on both ends: an operator asking for 09:00-10:00 expects a
    // message stamped exactly 10:00:00 to be in the answer. `time` is epoch
    // seconds and is indexed (time DESC, sql_id DESC), so the range is a scan
    // of the index rather than of the table.
    if (options.fromEpoch !== undefined) {
      params.push(options.fromEpoch);
      clauses.push(`${prefix}time >= $${params.length}`);
    }
    if (options.toEpoch !== undefined) {
      params.push(options.toEpoch);
      clauses.push(`${prefix}time <= $${params.length}`);
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
   *
   * Two paging modes, and which one you get is decided by the options rather
   * than by a flag:
   *
   *   default   keyset on `sql_id DESC`; returns `nextCursor`, no row count.
   *             This is the hot path and it must stay free of `count(*)`:
   *             sent_sms is the fastest-growing table in the system and a
   *             window count over a filtered range is a scan of that range.
   *   `offset`  supplied, or a non-default `sort` requested: OFFSET paging with
   *             a `count(*) OVER()` total, because a `sql_id` cursor cannot
   *             express a page boundary in someone else's ordering. Deep
   *             offsets degrade — that is inherent to OFFSET and is why the
   *             default is a keyset.
   */
  async list(options: SqlboxListOptions | number = 100) {
    const settings = typeof options === 'number' ? { limit: options } : options;
    const size = Math.min(Math.max(settings.limit ?? 100, 1), 500);
    const sort = parseSqlboxSort(settings.sort);
    const keyset = isDefaultSort(sort) && settings.offset === undefined;
    const params: any[] = [];
    const where = this.filters(settings, params, 'm.');
    const statuses = resolveDeliveryStatuses(settings.deliveryStatus ?? settings.status);
    let outer = '';
    if (statuses) {
      params.push(statuses);
      outer = `WHERE q.delivery_status = ANY($${params.length})`;
    }
    // q.sql_id DESC always closes the ORDER BY: without a unique tiebreaker two
    // rows sharing a timestamp could swap places between pages and be shown
    // twice or not at all.
    const orderBy = [
      ...sort.map((term) => `${SQLBOX_SORT_COLUMNS[term.field]} ${term.direction}`),
      'q.sql_id DESC',
    ].join(', ');
    const projection = keyset ? 'SELECT *' : 'SELECT *, count(*) OVER() AS __total';

    params.push(size + 1);
    const limitClause = `LIMIT $${params.length}`;
    let offsetClause = '';
    let offset = 0;
    if (!keyset) {
      offset = Math.min(Math.max(settings.offset ?? 0, 0), 5_000_000);
      params.push(offset);
      offsetClause = ` OFFSET $${params.length}`;
    }

    const result = await this.required().query(
      `${projection} FROM (${classifiedMessages(settings.deliveryReport ? 'receipts' : 'history')} ${where}) q ${outer} ORDER BY ${orderBy} ${limitClause}${offsetClause}`,
      params,
    );
    const page = result.rows.slice(0, size);
    const total = page.length ? Number(page[0].__total) : 0;
    // __total is a paging artefact, not a message field; it must not leak into
    // `raw` and from there into a CSV export column.
    const rows = page.map(({ __total, ...row }: any) => this.normalize(row, 'sent_sms'));
    if (keyset)
      return {
        items: rows,
        nextCursor: result.rows.length > size ? Number(result.rows[size].sql_id) : null,
        total: null as number | null,
        limit: size,
        offset: null as number | null,
      };
    return {
      items: rows,
      // A non-default sort has no sql_id keyset; say so rather than hand back a
      // cursor that would page in the wrong order.
      nextCursor: null,
      total,
      limit: size,
      offset,
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
      `SELECT ${SPOOL_COLUMNS} FROM send_sms WHERE sql_id::text=$1 OR foreign_id=$1 ORDER BY time,sql_id`,
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
  /**
   * The CSV export column set. Exported so a caller that has to emit a
   * header-only body (SQLBox unavailable) cannot hand back a header that
   * disagrees with the one a real export would produce.
   */
  static readonly EXPORT_COLUMNS = [
    'id',
    'timestamp',
    'direction',
    'status',
    'deliveryStatus',
    'sender',
    'receiver',
    'smscId',
    'externalRef',
    'segments',
    'coding',
    'charset',
    'udhData',
    'validity',
    'deferred',
    'mclass',
    'pid',
    'binfo',
    'metaData',
    'text',
  ] as const;

  /** The export header row, terminated exactly as the export body is. */
  static exportHeaderRow(): string {
    return `${KamexSqlboxRepository.EXPORT_COLUMNS.join(',')}\r\n`;
  }

  /**
   * CSV of the SAME rows the grid would show for the SAME options. It delegates
   * to {@link list}, so there is no second filter implementation that could
   * silently honour fewer filters than the grid does — which is exactly the
   * defect this shape prevents.
   */
  async exportCsv(options: SqlboxListOptions = {}) {
    const max = Number(process.env.SQLBOX_EXPORT_MAX_ROWS ?? 5000);
    const page = await this.list({ ...options, limit: Math.min(options.limit ?? max, max) });
    const header = KamexSqlboxRepository.EXPORT_COLUMNS;
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
  async ensureIndexes(options: { concurrently?: boolean } = {}) {
    // CONCURRENTLY trades a second table pass for not taking ACCESS EXCLUSIVE
    // on sent_sms. On a table that is receiving every message the engine sends,
    // a plain CREATE INDEX would block sqlbox's inserts for the whole build —
    // which is exactly what the boot path must not do. It cannot run inside a
    // transaction block; pg's pool queries are autocommit, so this is fine.
    const create = options.concurrently ? 'CREATE INDEX CONCURRENTLY' : 'CREATE INDEX';
    // An interrupted CONCURRENTLY build leaves an INVALID index behind, and
    // IF NOT EXISTS would then happily skip it forever — the table would look
    // indexed and plan as though it were not. Clear those first.
    await this.dropInvalidIndexes();
    for (const statement of SENT_SMS_INDEX_STATEMENTS)
      await this.required().query(statement(create));
    return { source: 'kamex-sqlbox', indexes: [...SENT_SMS_INDEX_NAMES] };
  }

  /** Drops any of our indexes Postgres has marked invalid (see ensureIndexes). */
  private async dropInvalidIndexes(): Promise<string[]> {
    const invalid = await this.required().query<{ relname: string }>(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relname = ANY($1)`,
      [[...SENT_SMS_INDEX_NAMES]],
    );
    for (const row of invalid.rows)
      await this.required().query(`DROP INDEX IF EXISTS ${quoteIdentifier(row.relname)}`);
    return invalid.rows.map((row) => row.relname);
  }

  /**
   * Creates the sent_sms indexes at boot.
   *
   * ROOT CAUSE THIS CLOSES. `ensureIndexes()` was reachable only through
   * `POST /messages/indexes`, and a production audit found it had never been
   * run: sent_sms — the fastest-growing table in the system, ordered by `time
   * DESC` on every list and joined on `foreign_id` for every DLR correlation —
   * carried nothing but its primary key. A fresh deployment would be equally
   * unindexed, because nothing in the boot sequence asked.
   *
   * Every property here is deliberate:
   *   - IDEMPOTENT: CREATE INDEX IF NOT EXISTS, so a restart is free.
   *   - NON-BLOCKING: {@link onApplicationBootstrap} does not await it. An
   *     index build on a large table takes minutes; the API must be serving
   *     traffic during it.
   *   - NON-FATAL: any failure (no permission, SQLBox not up yet, build
   *     cancelled) is logged and swallowed. A missing index makes queries slow,
   *     never wrong; refusing to boot over one would be the worse outcome.
   *   - SKIPPED UNDER TEST: NODE_ENV=test never touches a database here.
   *   - OPT-OUTABLE: SQLBOX_AUTO_INDEX=false for a DBA who wants to own DDL.
   */
  async ensureIndexesAtBoot(): Promise<{ status: string; detail?: string; indexes?: string[] }> {
    if (process.env.NODE_ENV === 'test') return { status: 'skipped', detail: 'NODE_ENV=test' };
    if (process.env.SQLBOX_AUTO_INDEX === 'false')
      return { status: 'skipped', detail: 'SQLBOX_AUTO_INDEX=false' };
    if (!this.pool)
      return { status: 'skipped', detail: 'KAMEX_SQLBOX_DATABASE_URL is not configured' };
    try {
      const probe = await this.probe();
      if (!probe.available) return { status: 'skipped', detail: probe.evidence };
      const result = await this.ensureIndexes({ concurrently: true });
      this.log('info', 'sqlbox indexes ensured at boot', { indexes: result.indexes });
      return { status: 'ensured', indexes: result.indexes };
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      this.log('error', 'could not ensure sqlbox indexes at boot; continuing unindexed', {
        detail,
      });
      return { status: 'failed', detail };
    }
  }

  /**
   * Fire-and-forget on purpose: an index build must never sit between the
   * process starting and the first request being served.
   */
  onApplicationBootstrap(): void {
    void this.ensureIndexesAtBoot();
  }

  private log(level: 'info' | 'error', message: string, extra: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ level, message, source: 'kamex-sqlbox', ...extra });
    if (level === 'error') console.error(line);
    else console.log(line);
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
    if (options.fromEpoch !== undefined) {
      params.push(options.fromEpoch);
      clauses.push(`time >= $${params.length}`);
    }
    if (options.toEpoch !== undefined) {
      params.push(options.toEpoch);
      clauses.push(`time <= $${params.length}`);
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
      `SELECT ${SPOOL_COLUMNS} FROM send_sms ${where} ORDER BY sql_id DESC LIMIT $${params.length}`,
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

  /**
   * Spools one MT message into `send_sms`.
   *
   * `deferred` / `validity` are written as the engine defines them: RELATIVE
   * MINUTES, NULL for "unset". sqlbox turns them into absolute instants when it
   * picks the row up and the SMSC driver puts them on the wire. A null offset
   * writes NULL rather than 0 — 0 is a real value meaning "no delay/expire now"
   * and must stay distinguishable from "the caller expressed no preference".
   *
   * Honesty note carried next to the INSERT on purpose: writing `deferred` does
   * not make JKANNEL, sqlbox or bearerbox hold the message. It asks the CARRIER
   * to. See messaging-depth/message-scheduling.ts.
   */
  async submit(value: SqlboxSubmission) {
    const result = await this.required().query<{ sql_id: string }>(
      `INSERT INTO send_sms(momt,sender,receiver,msgdata,time,smsc_id,dlr_mask,dlr_url,foreign_id,deferred,validity) VALUES('MT',$1,$2,$3,extract(epoch from now())::bigint,$4,$5,$6,$7,$8,$9) RETURNING sql_id::text`,
      [
        value.sender,
        value.receiver,
        value.text,
        value.smscId ?? null,
        value.dlrMask ?? 31,
        value.dlrUrl ?? null,
        value.foreignId ?? null,
        value.deferredMinutes ?? null,
        value.validityMinutes ?? null,
      ],
    );
    return {
      sqlId: result.rows[0].sql_id,
      status: 'queued',
      source: 'kamex-sqlbox',
      deferredMinutes: value.deferredMinutes ?? null,
      validityMinutes: value.validityMinutes ?? null,
    };
  }
}
