import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EngineModule } from '../engine/engine.module';
import { AuthModule } from '../security/auth.module';
import { QueueConsoleController } from './queue-console.controller';
import { QueueConsoleService } from './queue-console.service';

/**
 * Live message-queue console: view live queue state and reroute or resend
 * traffic to a different SMPP bind without restarting the engine.
 *
 * WHAT THIS MODULE CAN AND CANNOT DO — the honest boundary, stated once here:
 *
 *  - CAN repoint a message that is still in the SQLBox spool (`send_sms`) at
 *    another bind, or delete it, with no engine restart. Measured caveat:
 *    SQLBox drains that table in under a second, so on a healthy system this
 *    window barely exists and most attempts report `skipped`. It matters under
 *    backlog (burst submissions, slow/paused SQLBox, a stalled bind).
 *
 *  - CANNOT touch messages already inside bearerbox. Tier 2 — bearerbox's
 *    internal per-SMSC queue — is exposed by the admin interface ONLY as an
 *    aggregate `queued` counter per SMSC in /status.json. Those messages cannot
 *    be listed, inspected, moved, retargeted or cancelled individually. No
 *    endpoint here claims otherwise. The supported workaround is two steps:
 *    disable the sick bind (POST binds/:engineId/control) so it stops draining
 *    and stops accepting new traffic, then resend the affected messages from
 *    the log to a healthy bind (POST resend).
 *
 *  - CAN resend anything in history (`sent_sms`) against a different bind. This
 *    is the primary operator path in practice and creates new spool rows; the
 *    original history rows are terminal and are never mutated.
 *
 * Depends on {@link EngineModule} for the SQLBox spool repository, the Kamex
 * status snapshot and SMSC bind control, and on {@link AuthModule} for the
 * auth/permissions guards.
 */
@Module({
  imports: [AuthModule, EngineModule],
  controllers: [QueueConsoleController],
  providers: [DatabaseService, QueueConsoleService],
})
export class QueueConsoleModule {}
