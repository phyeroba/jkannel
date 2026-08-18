import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { DatabaseService } from '../database/database.service';
import { HealthService } from '../health/health.service';
import { TelemetryFreshnessService } from '../platform/telemetry-freshness.service';
import { PlatformHealthController } from './platform-health.controller';
import { ServiceHealthService } from './service-health.service';
import { ResourceService } from './resource.service';

/**
 * System and platform health (spec §14).
 *
 * Its own module rather than more routes on the console controller, because it
 * composes probes that live in four places — the dependency health check, the
 * engine adapter, the SQLBox repository and the telemetry freshness service —
 * and none of those owns the others.
 */
@Module({
  imports: [AuthModule, EngineModule],
  controllers: [PlatformHealthController],
  providers: [
    DatabaseService,
    HealthService,
    TelemetryFreshnessService,
    ServiceHealthService,
    ResourceService,
  ],
  exports: [ServiceHealthService],
})
export class PlatformHealthModule {}
