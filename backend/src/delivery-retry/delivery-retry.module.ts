import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { MessagingDepthModule } from '../messaging-depth/messaging-depth.module';
import { RoutingDepthModule } from '../routing-depth/routing-depth.module';
import { DeliveryRetryController } from './delivery-retry.controller';
import { DeliveryRetryJobHandlers } from './delivery-retry.handlers';
import { DeliveryRetryService } from './delivery-retry.service';

/**
 * Delivery-failure retry: the other half of "resend with another connection".
 *
 * The send-failure half already existed in {@link RoutingDepthModule} — a
 * fallback bind is chosen when the primary is not healthy at submit time. This
 * module handles the case that had no path at all: the engine accepted the
 * message, the carrier later reported it failed, and nothing tried again.
 *
 * It composes rather than duplicates. {@link EngineModule} supplies the SQLBox
 * reads that find negative delivery reports and the late `delivered` report that
 * cancels a retry; {@link MessagingDepthModule} exports THE send path, so a
 * retry is an ordinary message subject to blocklist, content filtering, sender
 * approval, quota and credit; {@link RoutingDepthModule} supplies live bind
 * health and route resolution, so route configuration still decides where a
 * retry goes. The platform's `@Global` JobsModule is the scheduler.
 *
 * Nothing is exported: a retry must be a consequence of an observed delivery
 * failure, not something another module can trigger for its own reasons.
 */
@Module({
  imports: [AuthModule, EngineModule, MessagingDepthModule, RoutingDepthModule],
  controllers: [DeliveryRetryController],
  providers: [DatabaseService, DeliveryRetryService, DeliveryRetryJobHandlers],
})
export class DeliveryRetryModule {}
