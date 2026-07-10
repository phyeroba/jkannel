import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { NotificationDeliveryService } from '../monitoring/notification-delivery.service';
import { MonitoringDepthRepository } from './monitoring-depth.repository';
import { PlatformMetricsService } from './platform-metrics.service';
import { AlertEscalationService } from './alert-escalation.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { AlertCorrelationService } from './alert-correlation.service';
import {
  CorrelationController,
  EscalationController,
  MaintenanceController,
} from './monitoring-depth.controller';

/**
 * Monitoring-depth feature module: platform/DB/Redis metrics, alert escalation
 * chains, maintenance windows, and alert correlation/dedup.
 *
 * Exports {@link PlatformMetricsService} so the app-level MetricsController can
 * append platform metrics to /metrics once AppModule imports this module (the
 * controller injects it with @Optional, so wiring is additive).
 */
@Module({
  imports: [AuthModule],
  controllers: [EscalationController, MaintenanceController, CorrelationController],
  providers: [
    DatabaseService,
    MonitoringDepthRepository,
    PlatformMetricsService,
    MaintenanceWindowService,
    AlertEscalationService,
    AlertCorrelationService,
    NotificationDeliveryService,
  ],
  exports: [
    PlatformMetricsService,
    MaintenanceWindowService,
    AlertCorrelationService,
    AlertEscalationService,
  ],
})
export class MonitoringDepthModule {}
