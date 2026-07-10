import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { RoutingDepthController } from './routing-depth.controller';
import { RoutingDepthRepository } from './routing-depth.repository';
import { RoutingDepthService } from './routing-depth.service';

/**
 * Routing-depth feature module: advanced route configuration (prefix / country /
 * operator / weighted route types), selection strategies (priority / least-cost
 * / load-balance / round-robin / time-based), tenant-scoped route versioning,
 * and a `resolve` preview endpoint. Depends on {@link AuthModule} for the
 * auth/permissions guards.
 */
@Module({
  imports: [AuthModule],
  controllers: [RoutingDepthController],
  providers: [DatabaseService, RoutingDepthRepository, RoutingDepthService],
})
export class RoutingDepthModule {}
