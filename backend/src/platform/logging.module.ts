import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { DatabaseService } from '../database/database.service';
import { LogBufferService, sharedLogBuffer } from './log-buffer';
import { LogsController } from './logs.controller';
import { DurableLogService } from './durable-log.service';

/**
 * Exposes the log explorer over two sources: the process-local ring buffer that
 * JsonLogger fills, and the durable `log_entries` table for warn and above.
 *
 * The buffer provider is a factory over {@link sharedLogBuffer} because the
 * logger is constructed before Nest's injector exists (main.ts hands it to
 * NestFactory), so both must reach the same instance. {@link DurableLogService}
 * registers itself with the logger on `onModuleInit` for the same reason.
 */
@Module({
  imports: [AuthModule],
  controllers: [LogsController],
  providers: [
    { provide: LogBufferService, useFactory: sharedLogBuffer },
    DatabaseService,
    DurableLogService,
  ],
  exports: [LogBufferService, DurableLogService],
})
export class LoggingModule {}
