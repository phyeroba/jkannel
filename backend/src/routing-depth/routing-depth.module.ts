import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { RoutingDepthController } from './routing-depth.controller';
import { RoutingDepthRepository } from './routing-depth.repository';
import { RoutingDepthService } from './routing-depth.service';
import { RouteResolutionService } from './route-resolution.service';

/**
 * Routing-depth feature module: advanced route configuration (prefix / country /
 * operator / weighted route types), selection strategies (priority / least-cost
 * / load-balance / round-robin / time-based), tenant-scoped route versioning,
 * and a `resolve` preview endpoint. Depends on {@link AuthModule} for the
 * auth/permissions guards.
 *
 * {@link RouteResolutionService} is exported because it is the engine's entry
 * point ON the live send path (messaging-depth): the same `selectRoute()` the
 * preview uses, fed with real bind health, deployed routes only and the
 * customer's route bindings.
 */
@Module({
  imports: [AuthModule],
  controllers: [RoutingDepthController],
  providers: [DatabaseService, RoutingDepthRepository, RoutingDepthService, RouteResolutionService],
  exports: [RouteResolutionService, RoutingDepthRepository],
})
export class RoutingDepthModule {}
