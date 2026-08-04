import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { LogBufferService, sharedLogBuffer } from './log-buffer';
import { LogsController } from './logs.controller';

/**
 * Exposes the log explorer over the process-local ring buffer that JsonLogger
 * fills. The provider is a factory over {@link sharedLogBuffer} because the
 * logger is constructed before Nest's injector exists (main.ts hands it to
 * NestFactory), so both must reach the same instance.
 */
@Module({
  imports: [AuthModule],
  controllers: [LogsController],
  providers: [{ provide: LogBufferService, useFactory: sharedLogBuffer }],
  exports: [LogBufferService],
})
export class LoggingModule {}
