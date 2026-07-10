import { ConflictException, Injectable } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition, buildGridSql, parseListQuery } from '../platform/list-query';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface GridPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type RetentionClass = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'manual';
export type BackupKind = 'full' | 'schema' | 'incremental';

export interface BackupRecord {
  id: string;
  label: string;
  kind: string;
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
  'id,label,kind,status,size_bytes,checksum,location,encrypted,detail,retention_class,' +
  'verified_at,artifact_path,platform_version,database_version,started_at,completed_at,created_by';

const SCHEDULE_COLUMNS =
  'id,tenant_id,name,cron,interval_minutes,kind,retention_class,enabled,last_run_at,next_run_at,created_by,created_at';

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

  private async grid<T extends QueryResultRow>(
    actor: Actor,
    select: string,
    from: string,
    gridDef: GridDefinition,
    rawQuery: Record<string, unknown>,
  ): Promise<GridPage<T>> {
    const parsed = parseListQuery(rawQuery, gridDef);
    const fragments = buildGridSql(parsed, gridDef, []);
    const where = fragments.andWhere ? `WHERE ${fragments.andWhere.slice(' AND '.length)}` : '';
    const sql = `${select}, count(*) OVER() AS __total ${from} ${where} ${fragments.orderBy} ${fragments.limitOffset}`;
    return this.inTenant(actor, async (client) => {
      const result = await client.query<T & { __total: string }>(sql, fragments.params);
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as unknown as T);
      return { items, total, limit: parsed.limit, offset: parsed.offset };
    });
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
             (tenant_id,label,kind,status,retention_class,artifact_path,platform_version,database_version,encrypted,detail,created_by)
           VALUES ($1,$2,$3,'running',$4,$5,$6,$7,true,$8,$9)
           RETURNING ${BACKUP_COLUMNS}`,
          [
            actor.tenantId,
            value.label,
            value.kind,
            value.retentionClass,
            value.artifactPath,
            value.platformVersion,
            value.databaseVersion,
            'Whole-database pg_dump in progress.',
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
    value: { sizeBytes: number; checksum: string; location: string; detail: string },
  ): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `UPDATE backup_records
              SET status='completed',size_bytes=$2,checksum=$3,location=$4,detail=$5,completed_at=now()
            WHERE id=$1 RETURNING ${BACKUP_COLUMNS}`,
          [id, value.sizeBytes, value.checksum, value.location, value.detail],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.completed', 'backup', id, {
        sizeBytes: value.sizeBytes,
        checksum: value.checksum,
      });
      return row;
    });
  }

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
      return row;
    });
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

  markVerifyFailed(actor: Actor, id: string, detail: string): Promise<BackupRecord> {
    return this.inTenant(actor, async (client) => {
      const row = (
        await client.query<BackupRecord>(
          `UPDATE backup_records SET detail=$2 WHERE id=$1 RETURNING ${BACKUP_COLUMNS}`,
          [id, detail],
        )
      ).rows[0];
      await this.audit(client, actor, 'backup.verify_failed', 'backup', id, { detail });
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
  ): Promise<Array<{ id: string; artifact_path: string | null }>> {
    return this.inTenant(actor, async (client) => {
      const rows = (
        await client.query<{ id: string; artifact_path: string | null }>(
          `DELETE FROM backup_records
            WHERE id IN (
              SELECT id FROM backup_records
               WHERE retention_class=$1 AND started_at < $2
               ORDER BY started_at ASC
               LIMIT $3
            )
            RETURNING id, artifact_path`,
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
