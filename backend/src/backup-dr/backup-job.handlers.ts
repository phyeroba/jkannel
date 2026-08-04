import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import { Actor, BackupDrRepository } from './backup-dr.repository';
import { BackupDrService } from './backup-dr.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Job types owned by the backup / disaster-recovery module.
 *
 * These are what prove the job machinery end to end: a real, long-running,
 * genuinely useful piece of work that an operator would rather not hold an HTTP
 * connection open for. Registration happens here — inside the owning module —
 * so the platform layer never imports a domain module.
 *
 * Retry policy is deliberate:
 *   backup.create   3 attempts. A pg_dump can fail transiently (a lock wait, a
 *                   full disk that an operator clears), and the operation is
 *                   safe to repeat: each attempt writes a distinct artifact and
 *                   its own catalog row.
 *   backup.verify   3 attempts, same reasoning.
 *   backup.retention 1 attempt. Deletion is not something to retry blindly;
 *                   the next scheduler cycle picks up whatever remains due.
 */
@Injectable()
export class BackupJobHandlers implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly service: BackupDrService,
    private readonly repository: BackupDrRepository,
  ) {}

  onModuleInit(): void {
    this.register();
  }

  /** Idempotent registration so a second module init does not throw. */
  register(): void {
    if (!this.registry.has('backup.create'))
      this.registry.register({
        type: 'backup.create',
        description:
          'Runs an encrypted pg_dump backup with configuration capture and offsite replication.',
        maxAttempts: 3,
        handler: async (context) => {
          const actor: Actor = context.actor;
          await context.progress(5);
          const record = await this.service.createBackup(actor, {
            kind: asOptionalString(context.input.kind, 'kind'),
            retentionClass: asOptionalString(context.input.retentionClass, 'retentionClass'),
            label: asOptionalString(context.input.label, 'label'),
            scope: asOptionalString(context.input.scope, 'scope'),
          });
          await context.progress(95);
          // A backup that recorded itself as failed must fail the job too, or
          // the job would report success over a failed backup — precisely the
          // dishonesty this whole change set exists to remove.
          if (record.status !== 'completed')
            throw new Error(
              `Backup ${record.id} finished with status "${record.status}": ${record.detail ?? 'no detail recorded'}`,
            );
          return {
            backupId: record.id,
            label: record.label,
            status: record.status,
            sizeBytes: record.size_bytes,
            checksum: record.checksum,
            location: record.location,
            offsiteLocation: record.offsite_location,
            configFileCount: record.config_file_count,
            warning: record.warning,
          };
        },
      });

    if (!this.registry.has('backup.verify'))
      this.registry.register({
        type: 'backup.verify',
        description: 'Verifies an existing backup artifact with pg_restore --list.',
        maxAttempts: 3,
        handler: async (context) => {
          const backupId = context.input.backupId;
          if (typeof backupId !== 'string' || !UUID.test(backupId))
            throw new PermanentJobError('input.backupId must be a backup UUID');
          const record = await this.service.verifyBackup(context.actor, backupId);
          if (record.status !== 'verified')
            throw new Error(
              `Backup ${backupId} did not verify: ${record.detail ?? 'no detail recorded'}`,
            );
          return { backupId, status: record.status, verifiedAt: record.verified_at };
        },
      });

    if (!this.registry.has('backup.retention'))
      this.registry.register({
        type: 'backup.retention',
        description: 'Applies the backup retention policy and deletes expired artifacts.',
        maxAttempts: 1,
        handler: async (context) => {
          const summary = await this.service.applyRetention(context.actor);
          await context.progress(100);
          return { classes: summary };
        },
      });

    if (!this.registry.has('backup.schedule.run'))
      this.registry.register({
        type: 'backup.schedule.run',
        description: 'Runs one named backup schedule immediately.',
        maxAttempts: 2,
        handler: async (context) => {
          const scheduleId = context.input.scheduleId;
          if (typeof scheduleId !== 'string' || !UUID.test(scheduleId))
            throw new PermanentJobError('input.scheduleId must be a backup schedule UUID');
          const schedules = await this.repository.listSchedules(context.actor, {
            'filter.enabled': 'true',
            limit: 500,
          });
          const schedule = schedules.items.find((row) => row.id === scheduleId);
          if (!schedule)
            throw new PermanentJobError(`No enabled backup schedule ${scheduleId} for this tenant`);
          const record = await this.service.createBackup(context.actor, {
            kind: schedule.kind,
            retentionClass: schedule.retention_class,
            label: `${schedule.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
          });
          if (record.status !== 'completed')
            throw new Error(
              `Scheduled backup ${record.id} finished with status "${record.status}": ${record.detail ?? 'no detail recorded'}`,
            );
          return { backupId: record.id, scheduleId, label: record.label };
        },
      });
  }
}

function asOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PermanentJobError(`input.${name} must be a string`);
  return value;
}
