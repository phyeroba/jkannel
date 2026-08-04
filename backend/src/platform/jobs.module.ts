import { Global, Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { JobHandlerRegistry } from './job-registry';
import { JobWorker } from './job-worker';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/**
 * The asynchronous job platform: the queue (JobsService over `api_jobs`), the
 * executor (JobWorker) and the type registry.
 *
 * Marked @Global so any domain module can inject {@link JobHandlerRegistry} and
 * register its own job types at boot without the platform layer having to
 * import that module — which would invert the dependency and couple the
 * platform to every domain. See backup-dr/backup-job.handlers.ts for the
 * registration pattern.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [DatabaseService, JobsService, JobHandlerRegistry, JobWorker],
  exports: [JobsService, JobHandlerRegistry],
})
export class JobsModule {}
