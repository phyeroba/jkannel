import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { MessageOperationsService } from './message-operations.service';
import { MessageOperationsController } from './message-operations.controller';
import { BulkSendService } from './bulk-send.service';
import { BulkSendController } from './bulk-send.controller';

/**
 * Messaging-depth feature module: message replay/clone/requeue and bulk send /
 * campaign jobs. Depends on {@link EngineModule} for the SQLBox repository
 * (message submit) and {@link AuthModule} for the auth/permissions guards.
 */
@Module({
  imports: [AuthModule, EngineModule],
  controllers: [MessageOperationsController, BulkSendController],
  providers: [DatabaseService, MessageOperationsService, BulkSendService],
})
export class MessagingDepthModule {}
