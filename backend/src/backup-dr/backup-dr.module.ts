import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { ExportService } from '../platform/export.service';
import { BackupDrController } from './backup-dr.controller';
import { BackupDrRepository } from './backup-dr.repository';
import { BackupDrScheduler } from './backup-dr.scheduler';
import { BackupDrService } from './backup-dr.service';
import { BackupJobHandlers } from './backup-job.handlers';

/**
 * Backup & disaster-recovery module. Real pg_dump/pg_restore backups with
 * encrypted artifacts, a due-schedule/retention scheduler, and a tenant-scoped
 * catalog. The maintainer wires this into AppModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [BackupDrController],
  providers: [
    DatabaseService,
    BackupDrRepository,
    BackupDrService,
    BackupDrScheduler,
    ExportService,
    // Registers backup.* job types with the global JobHandlerRegistry at boot,
    // so POST /jobs can execute real backup work.
    BackupJobHandlers,
  ],
})
export class BackupDrModule {}
