import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { DatabaseService } from '../database/database.service';
import { HealthService } from '../health/health.service';
import { MonitoringDepthModule } from '../monitoring-depth/monitoring-depth.module';
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
  // MonitoringDepthModule is IMPORTED rather than TelemetryFreshnessService
  // being re-declared as a provider here.
  //
  // Re-declaring it was a real boot failure: a provider listed in a module is
  // instantiated in THAT module's injector, and this one has neither
  // KamexAdapter nor EngineSnapshotCache, so Nest resolved both constructor
  // arguments to null and crash-looped the process with
  // "TelemetryFreshnessService ... dependencies: [null, null]".
  //
  // Unit tests could not catch it — they construct the service directly, so the
  // injector is never exercised. platform-health.module.spec.ts now compiles
  // the real module graph for exactly this reason.
  imports: [AuthModule, EngineModule, MonitoringDepthModule],
  controllers: [PlatformHealthController],
  providers: [DatabaseService, HealthService, ServiceHealthService, ResourceService],
  exports: [ServiceHealthService],
})
export class PlatformHealthModule {}
