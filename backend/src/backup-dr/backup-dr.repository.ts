import { ConflictException, Injectable } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition } from '../platform/list-query';
import { GridResult, GridRunnerOptions, runGrid } from '../platform/grid-runner';
import { EtagConflictError } from '../platform/etag';

export interface Actor {
  tenantId: string;
  userId: string;
}

/**
 * Grid page shape. Now the shared platform shape: `total`/`offset` are numbers
 * under offset pagination and null under keyset pagination (where a count is
 * deliberately not paid for), and `nextCursor` carries the keyset continuation.
 */
export type GridPage<T> = GridResult<T>;

export type RetentionClass = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'manual';
export type BackupKind = 'full' | 'schema' | 'incremental';
/** What the artifact covers: whole DB ('full'/'database') or config-only. */
export type BackupScope = 'full' | 'database' | 'configurations';

export interface BackupRecord {
  id: string;
  label: string;
  kind: string;
  scope: string;
  status: string;
  size_bytes: string | null;
  checksum: string | null;
  location: string | null;
  encrypted: boolean;
  detail: string | null;
  retention_class: string;
  verified_at: string | null;
  artifact_path: string | null;
  platform_version: string | null;
  database_version: string | null;
  started_at: string;
  completed_at: string | null;
  created_by: string;
  /** Companion configuration/certificate bundle (migration 035). */
  config_artifact_path: string | null;
  config_artifact_checksum: string | null;
  config_file_count: number;
  config_bytes: string | number;
  offsite_location: string | null;
  offsite_synced_at: string | null;
  /** Non-fatal degradation on an otherwise-completed backup. Never hidden. */
  warning: string | null;
}

export interface BackupScheduleRow {
  id: string;
  tenant_id: string;
  name: string;
  cron: string | null;
  interval_minutes: number | null;
  kind: string;
  retention_class: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: string;
  created_at: string;
  /** Optimistic-concurrency counter (migration 039). Drives ETag / If-Match. */
  version: number;
}

/** Grid whitelists for the backup-dr resources. */
export const BACKUP_DR_GRIDS = {
  backups: {
    searchColumns: ['label', 'detail', 'location', 'artifact_path'],
    sortColumns: {
      startedAt: 'started_at',
      completedAt: 'completed_at',
      status: 'status',
      kind: 'kind',
      retentionClass: 'retention_class',
      verifiedAt: 'verified_at',
      sizeBytes: 'size_bytes',
    },
    filterColumns: { status: 'status', kind: 'kind', retentionClass: 'retention_class' },
    defaultOrderBy: 'started_at DESC',
    maxLimit: 500,
  },
  schedules: {
    searchColumns: ['name'],
    sortColumns: {
      name: 'name',
      nextRunAt: 'next_run_at',
      lastRunAt: 'last_run_at',
      createdAt: 'created_at',
      enabled: 'enabled',
    },
    filterColumns: { enabled: 'enabled', kind: 'kind', retentionClass: 'retention_class' },
    defaultOrderBy: 'created_at DESC',
    maxLimit: 500,
  },
} satisfies Record<string, GridDefinition>;

const BACKUP_COLUMNS =
  'id,label,kind,scope,status,size_bytes,checksum,location,encrypted,detail,retention_class,' +
  'verified_at,artifact_path,platform_version,database_version,started_at,completed_at,created_by,' +
  'config_artifact_path,config_artifact_checksum,config_file_count,config_bytes,' +
  'offsite_location,offsite_synced_at,warning';

const SCHEDULE_COLUMNS =
  'id,tenant_id,name,cron,interval_minutes,kind,retention_class,enabled,last_run_at,next_run_at,created_by,created_at,version';

/** Fields a caller may change on a schedule. Everything else is derived. */
export interface BackupSchedulePatch {
  name?: string;
  cron?: string | null;
  intervalMinutes?: number | null;
  kind?: BackupKind;
  retentionClass?: RetentionClass;
  enabled?: boolean;
  nextRunAt?: Date | null;
}

/** Column each patch field writes to, in a fixed order for stable SQL. */
const SCHEDULE_PATCH_COLUMNS: ReadonlyArray<[keyof BackupSchedulePatch, string]> = [
  ['name', 'name'],
  ['cron', 'cron'],
  ['intervalMinutes', 'interval_minutes'],
  ['kind', 'kind'],
  ['retentionClass', 'retention_class'],
  ['enabled', 'enabled'],
  ['nextRunAt', 'next_run_at'],
];

/**
 * Persistence for the backup / disaster-recovery module. All tenant data is
 * accessed inside a tenant transaction so PostgreSQL row level security
 * (migration 018) enforces isolation; every mutation writes an audit_log row.
 */
@Injectable()
export class BackupDrRepository {
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
    id: string | null,
    value: unknown,
  ) {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.tenantId, actor.userId, action, type, id, value ? JSON.stringify(value) : null],
    );
  }

  /**
   * Delegates to the shared platform grid runner, so both backup grids get
   * search/sort/filter/limit/offset (unchanged), plus opt-in keyset pagination
   * (?cursor / ?paginate=cursor) and ?fields= projection, with no controller
   * change. See platform/grid-runner.ts.
   */
  private grid<T extends QueryResultRow>(
    actor: Actor,
    select: string,
    from: string,
    gridDef: GridDefinition,
    rawQuery: Record<string, unknown>,
    options: GridRunnerOptions = { idExpr: 'id' },
  ): Promise<GridPage<T>> {
    return this.inTenant(actor, (client) =>
      runGrid<T>(
        { select, from },
        gridDef,
        rawQuery,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        options,
      ),
    );
  }

  // ---- Server metadata ----------------------------------------------------
  /** Whole-database server version string (SELECT version()), or null. */
  async databaseVersion(): Promise<string | null> {
    try {
      const result = await this.database.query<{ v: string }>('SELECT version() v');
      return result.rows[0]?.v ?? null;
    } catch {
      return null;
    }
  }

  // ---- Backup records -----------------------------------------------------
  listBackups(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid<BackupRecord>(
      actor,
      `SELECT ${BACKUP_COLUMNS}`,
      'FROM backup_records',
      BACKUP_DR_GRIDS.backups,
      query,
    );
  }

  getBackup(actor: Actor, id: string): Promise<BackupRecord | undefined> {
    return this.inTenant(actor, async (client) => {
      return (
        await client.query<BackupRecord>(
          `SELECT ${BACKUP_COLUMNS} FROM backup_records WHERE id=$1`,
          [id],
        )
      ).rows[0];
    });
  }

  /** Inserts a backup row in the 'running' state and returns it. */
  insertRunning(
    actor: Actor,
    value: {
      label: string;
      kind: BackupKind;
      scope: BackupScope;
      retentionClass: RetentionClass;
      artifactPath: string;
      platformVersion: string | null;
      databaseVersion: string | null;
    },
  ): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `INSERT INTO backup_records
             (tenant_id,label,kind,scope,status,retention_class,artifact_path,platform_version,database_version,encrypted,detail,created_by)
           VALUES ($1,$2,$3,$4,'running',$5,$6,$7,$8,true,$9,$10)
           RETURNING ${BACKUP_COLUMNS}`,
          [
            actor.tenantId,
            value.label,
            value.kind,
            value.scope,
            value.retentionClass,
            value.artifactPath,
            value.platformVersion,
            value.databaseVersion,
            value.scope === 'configurations'
              ? 'Configuration-only pg_dump in progress.'
              : 'Whole-database pg_dump in progress.',
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.started', 'backup', row.id, {
        label: value.label,
        kind: value.kind,
      });
      return row;
    });
  }

  completeBackup(
    actor: Actor,
    id: string,
    value: {
      sizeBytes: number;
      checksum: string;
      location: string;
      detail: string;
      configArtifactPath?: string | null;
      configArtifactChecksum?: string | null;
      configFileCount?: number;
      configBytes?: number;
      offsiteLocation?: string | null;
      offsiteSynced?: boolean;
      warning?: string | null;
    },
  ): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `UPDATE backup_records
              SET status='completed',size_bytes=$2,checksum=$3,location=$4,detail=$5,
                  config_artifact_path=$6,config_artifact_checksum=$7,config_file_count=$8,
                  config_bytes=$9,offsite_location=$10,
                  offsite_synced_at=CASE WHEN $11::boolean THEN now() ELSE NULL END,
                  warning=$12,completed_at=now()
            WHERE id=$1 RETURNING ${BACKUP_COLUMNS}`,
          [
            id,
            value.sizeBytes,
            value.checksum,
            value.location,
            value.detail,
            value.configArtifactPath ?? null,
            value.configArtifactChecksum ?? null,
            value.configFileCount ?? 0,
            value.configBytes ?? 0,
            value.offsiteLocation ?? null,
            value.offsiteSynced === true,
            value.warning ?? null,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.completed', 'backup', id, {
        sizeBytes: value.sizeBytes,
        checksum: value.checksum,
        configFileCount: value.configFileCount ?? 0,
        offsiteLocation: value.offsiteLocation ?? null,
        warning: value.warning ?? null,
      });
      // A completed-but-degraded backup is not a success story. Surface it at
      // warning severity so it appears in the operator's alert grid rather than
      // only in a detail string nobody reads until a restore.
      if (value.warning)
        await this.raiseAlert(client, actor, {
          severity: 'warning',
          dedupKey: `backup:degraded:${id}`,
          summary: 'Backup completed with a warning',
          details: { backupId: id, warning: value.warning },
        });
      return row;
    });
  }

  /**
   * Marks a backup failed AND opens an alert. Before this, a failed backup
   * wrote status='failed' plus an audit row and paged nobody — the classic way
   * an operator discovers backup failure at restore time.
   */
  failBackup(actor: Actor, id: string, detail: string): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `UPDATE backup_records SET status='failed',detail=$2,completed_at=now()
            WHERE id=$1 RETURNING ${BACKUP_COLUMNS}`,
          [id, detail],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.failed', 'backup', id, { detail });
      await this.raiseAlert(client, actor, {
        severity: 'critical',
        dedupKey: `backup:failed:${row?.label ?? id}`,
        summary: `Backup "${row?.label ?? id}" failed`,
        details: { backupId: id, label: row?.label ?? null, detail },
      });
      return row;
    });
  }

  /**
   * Opens (or de-duplicates onto) an alert_instances row with source='backup'.
   *
   * There is no alert service injectable from this module without reaching into
   * monitoring/, so this writes the same table monitoring writes, using the same
   * partial-unique dedup index (migration 014). Failure to raise the alert must
   * never mask the underlying backup failure, so it is logged and swallowed.
   */
  private async raiseAlert(
    client: PoolClient,
    actor: Actor,
    value: {
      severity: 'info' | 'warning' | 'critical';
      dedupKey: string;
      summary: string;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await client.query(
        `INSERT INTO alert_instances (tenant_id, rule_id, status, severity, source, dedup_key, summary, details)
         VALUES ($1, NULL, 'open', $2, 'backup', $3, $4, $5)
         ON CONFLICT (tenant_id, dedup_key) WHERE status <> 'resolved' AND dedup_key IS NOT NULL
         DO NOTHING`,
        [
          actor.tenantId,
          value.severity,
          value.dedupKey,
          value.summary,
          JSON.stringify({ ...value.details, raisedBy: 'backup-dr' }),
        ],
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          context: 'BackupDrRepository',
          message: 'could not raise backup alert; the backup failure itself still stands',
          dedupKey: value.dedupKey,
          error: String((error as Error).message ?? error),
        }),
      );
    }
  }

  markVerified(actor: Actor, id: string, detail: string): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `UPDATE backup_records SET status='verified',verified_at=now(),detail=$2
            WHERE id=$1 RETURNING ${BACKUP_COLUMNS}`,
          [id, detail],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.verified', 'backup', id, null);
      return row;
    });
  }

  /** Verification failure is alerted too: an unverifiable artifact is not a backup. */
  markVerifyFailed(actor: Actor, id: string, detail: string): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `UPDATE backup_records SET detail=$2 WHERE id=$1 RETURNING ${BACKUP_COLUMNS}`,
          [id, detail],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.verify_failed', 'backup', id, { detail });
      await this.raiseAlert(client, actor, {
        severity: 'critical',
        dedupKey: `backup:verify_failed:${row?.label ?? id}`,
        summary: `Backup "${row?.label ?? id}" failed verification`,
        details: { backupId: id, label: row?.label ?? null, detail },
      });
      return row;
    });
  }

  /**
   * Deletes backup rows of one retention class older than the cutoff, bounded
   * by `limit`. Returns the removed rows' ids and artifact paths so the caller
   * can delete the artifacts on disk.
   */
  expireBackups(
    actor: Actor,
    retentionClass: RetentionClass,
    cutoffIso: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      artifact_path: string | null;
      config_artifact_path: string | null;
      offsite_location: string | null;
    }>
  > {
    return this.inTenant(actor, async (client) => {
      const rows = (
        await client.query<{
          id: string;
          artifact_path: string | null;
          config_artifact_path: string | null;
          offsite_location: string | null;
        }>(
          `DELETE FROM backup_records
            WHERE id IN (
              SELECT id FROM backup_records
               WHERE retention_class=$1 AND started_at < $2
               ORDER BY started_at ASC
               LIMIT $3
            )
            RETURNING id, artifact_path, config_artifact_path, offsite_location`,
          [retentionClass, cutoffIso, limit],
        )
      ).rows;
      if (rows.length)
        await this.audit(client, actor, 'backup.retention_expired', 'backup', null, {
          retentionClass,
          cutoffIso,
          removed: rows.length,
        });
      return rows;
    });
  }

  // ---- Schedules ----------------------------------------------------------
  listSchedules(actor: Actor, query: Record<string, unknown> = {}) {
    return this.grid<BackupScheduleRow>(
      actor,
      `SELECT ${SCHEDULE_COLUMNS}`,
      'FROM backup_schedules',
      BACKUP_DR_GRIDS.schedules,
      query,
    );
  }

  createSchedule(
    actor: Actor,
    value: {
      name: string;
      cron: string | null;
      intervalMinutes: number | null;
      kind: BackupKind;
      retentionClass: RetentionClass;
      enabled: boolean;
      nextRunAt: Date | null;
    },
  ): Promise<BackupScheduleRow> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupScheduleRow>(
          `INSERT INTO backup_schedules
             (tenant_id,name,cron,interval_minutes,kind,retention_class,enabled,next_run_at,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING ${SCHEDULE_COLUMNS}`,
          [
            actor.tenantId,
            value.name,
            value.cron,
            value.intervalMinutes,
            value.kind,
            value.retentionClass,
            value.enabled,
            value.nextRunAt,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup_schedule.created', 'backup_schedule', row.id, {
        name: value.name,
      });
      return row;
    });
  }

  getSchedule(actor: Actor, id: string): Promise<BackupScheduleRow | undefined> {
    return this.inTenant(actor, async (client) => {
      return (
        await client.query<BackupScheduleRow>(
          `SELECT ${SCHEDULE_COLUMNS} FROM backup_schedules WHERE id=$1`,
          [id],
        )
      ).rows[0];
    });
  }

  /**
   * Applies a partial update under an optional version precondition.
   *
   * `expectedVersion` is the version the caller proved it had read (from
   * `If-Match`). The UPDATE asserts it in the WHERE clause, so the check and
   * the write are the same statement — a concurrent update landing between the
   * controller's read and this write cannot slip through. `version` always
   * advances, which is what makes the next caller's ETag stale.
   *
   * Returns undefined when no such schedule exists; throws
   * {@link EtagConflictError} when the row exists but has moved on.
   */
  updateSchedule(
    actor: Actor,
    id: string,
    patch: BackupSchedulePatch,
    expectedVersion?: number,
  ): Promise<BackupScheduleRow | undefined> {
    return this.inTenant(actor, async (client) => {
      const assignments: string[] = [];
      const params: unknown[] = [id];
      for (const [field, column] of SCHEDULE_PATCH_COLUMNS) {
        if (patch[field] === undefined) continue;
        params.push(patch[field]);
        assignments.push(`${column}=$${params.length}`);
      }
      // Always bump the version, even for a no-op body: the caller asked to
      // mutate the resource, and an unchanged version would let a stale ETag
      // keep working.
      assignments.push('version=version+1');
      params.push(expectedVersion ?? null);
      const versionParam = `$${params.length}`;

      const row = (
        await client.query<BackupScheduleRow>(
          `UPDATE backup_schedules SET ${assignments.join(',')}
            WHERE id=$1 AND (${versionParam}::integer IS NULL OR version=${versionParam}::integer)
            RETURNING ${SCHEDULE_COLUMNS}`,
          params,
        )
      ).rows[0];

      if (!row) {
        const exists = (
          await client.query<{ id: string }>('SELECT id FROM backup_schedules WHERE id=$1', [id])
        ).rows[0];
        if (!exists) return undefined;
        throw new EtagConflictError('Backup schedule');
      }

      await this.audit(client, actor, 'backup_schedule.updated', 'backup_schedule', id, {
        ...patch,
        version: row.version,
      });
      return row;
    });
  }

  /** Reads enabled, due schedules for one tenant (next_run_at null or elapsed). */
  dueSchedules(actor: Actor, now: Date): Promise<BackupScheduleRow[]> {
    return this.inTenant(actor, async (client) => {
      return (
        await client.query<BackupScheduleRow>(
          `SELECT ${SCHEDULE_COLUMNS} FROM backup_schedules
            WHERE enabled AND (next_run_at IS NULL OR next_run_at <= $1)
            ORDER BY next_run_at ASC NULLS FIRST`,
          [now],
        )
      ).rows;
    });
  }

  /**
   * Records a scheduler tick. Deliberately does NOT bump `version`: last_run_at
   * / next_run_at are derived bookkeeping, not an operator edit, and invalidating
   * every open editor's ETag on each cycle would make If-Match unusable.
   */
  markScheduleRan(actor: Actor, id: string, ranAt: Date, nextRunAt: Date | null): Promise<void> {
    return this.inTenant(actor, async (client) => {
      await client.query('UPDATE backup_schedules SET last_run_at=$2,next_run_at=$3 WHERE id=$1', [
        id,
        ranAt,
        nextRunAt,
      ]);
    });
  }

  // ---- Restore operations -------------------------------------------------
  recordRestoreRunning(
    actor: Actor,
    value: { backupId: string; target: string },
  ): Promise<{ id: string }> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<{ id: string }>(
          `INSERT INTO restore_operations (tenant_id,backup_id,status,target,requested_by)
           VALUES ($1,$2,'running',$3,$4) RETURNING id`,
          [actor.tenantId, value.backupId, value.target, actor.userId],
        )
      ).rows[0];
      await this.audit(client, actor, 'restore.started', 'restore_operation', row.id, {
        backupId: value.backupId,
        target: value.target,
      });
      return row;
    });
  }

  completeRestore(
    actor: Actor,
    id: string,
    value: { status: 'succeeded' | 'failed'; detail: string },
  ): Promise<{ id: string; status: string; detail: string | null; target: string | null }> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<{
          id: string;
          status: string;
          detail: string | null;
          target: string | null;
        }>(
          `UPDATE restore_operations SET status=$2,detail=$3,completed_at=now()
            WHERE id=$1 RETURNING id,status,detail,target`,
          [id, value.status, value.detail],
        )
      ).rows[0];
      await this.audit(client, actor, `restore.${value.status}`, 'restore_operation', id, {
        detail: value.detail,
      });
      return row;
    });
  }
}
