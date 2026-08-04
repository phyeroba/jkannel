import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { CustomersDepthModule } from '../customers-depth/customers-depth.module';
import { RoutingDepthModule } from '../routing-depth/routing-depth.module';
import { MessageOperationsService } from './message-operations.service';
import { MessageOperationsController } from './message-operations.controller';
import { BulkSendService } from './bulk-send.service';
import { BulkSendController } from './bulk-send.controller';
import { MessageSendService } from './message-send.service';
import { MessageBlocklistService } from './message-blocklist.service';
import { SendEntitlementsService } from './send-entitlements.service';
import { MessagingPolicyController } from './messaging-policy.controller';

/**
 * Messaging-depth feature module. It owns THE send path
 * ({@link MessageSendService}) as well as message replay/clone/requeue and bulk
 * send / campaign jobs.
 *
 * The send path composes three things that used to be unreachable from a real
 * send: {@link RoutingDepthModule}'s route resolution (so route configuration
 * decides where traffic goes), {@link CustomersDepthModule}'s quota and credit
 * primitives (so entitlements are enforced and consumed atomically with the
 * send), and this module's own blocklist. {@link EngineModule} provides the
 * SQLBox repository the message is finally spooled to, and {@link AuthModule}
 * the auth/permissions guards.
 *
 * {@link MessageSendService} is exported so the console's `POST /messages` and
 * the API gateway's key-authenticated submit both go through the same funnel
 * rather than each spooling to the engine on their own terms.
 */
@Module({
  imports: [AuthModule, EngineModule, RoutingDepthModule, CustomersDepthModule],
  controllers: [MessageOperationsController, BulkSendController, MessagingPolicyController],
  providers: [
    DatabaseService,
    MessageOperationsService,
    BulkSendService,
    MessageBlocklistService,
    SendEntitlementsService,
    MessageSendService,
  ],
  exports: [MessageSendService, MessageBlocklistService],
})
export class MessagingDepthModule {}
