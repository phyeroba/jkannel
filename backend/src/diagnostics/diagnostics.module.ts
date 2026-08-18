import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { DiagnosticsController } from './diagnostics.controller';
import { MessageTraceService } from './message-trace.service';
import { OperationalEventsService } from './operational-events.service';
import { TestToolsService } from './test-tools.service';
import { PrivacyModule } from '../privacy/privacy.module';

/**
 * Diagnostics (spec §10, §11): message lifecycle assembly and SMPP status
 * decoding.
 *
 * Its own module because the trace needs BOTH database connections — the
 * engine's, for the message rows, and JKANNEL's, for the routing decision and
 * retry chain. Neither repository could reach both, which is precisely why the
 * routing decision went unread.
 */
@Module({
  imports: [AuthModule, PrivacyModule],
  controllers: [DiagnosticsController],
  providers: [
    DatabaseService,
    KamexSqlboxRepository,
    MessageTraceService,
    OperationalEventsService,
    TestToolsService,
  ],
  exports: [MessageTraceService, OperationalEventsService, TestToolsService],
})
export class DiagnosticsModule {}
