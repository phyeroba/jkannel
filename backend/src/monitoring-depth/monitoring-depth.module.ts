import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { AlertEvaluatorService } from '../monitoring/alert-evaluator.service';
import { NotificationDeliveryService } from '../monitoring/notification-delivery.service';
import { MonitoringDepthRepository } from './monitoring-depth.repository';
import { PlatformMetricsService } from './platform-metrics.service';
import { AlertEscalationService } from './alert-escalation.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { AlertCorrelationService } from './alert-correlation.service';
import { EngineSnapshotCache } from './engine-snapshot.cache';
import { SystemInfoController } from '../platform/system-info.controller';
import { SystemInfoService } from '../platform/system-info.service';
import { TelemetryFreshnessService } from '../platform/telemetry-freshness.service';
import { EngineMetricsService } from './engine-metrics.service';
import { SmscStatusPoller } from './smsc-status.poller';
import { AlertRuleEvaluatorScheduler } from './alert-rule-evaluator.scheduler';
import {
  CorrelationController,
  EscalationController,
  MaintenanceController,
  NotificationReadinessController,
} from './monitoring-depth.controller';
import { AlertLifecycleController } from './alert-lifecycle.controller';
import { AlertLifecycleRepository } from './alert-lifecycle.repository';
import { NotificationReadinessService } from './notification-readiness.service';

/**
 * Monitoring-depth feature module: platform/DB/Redis metrics, SMS/SMSC engine
 * telemetry, alert rule evaluation, escalation chains, maintenance windows, and
 * alert correlation/dedup.
 *
 * This module owns the whole observability loop:
 *
 *   SmscStatusPoller -> EngineSnapshotCache -> EngineMetricsService -> /metrics
 *                    -> metric_samples -> AlertRuleEvaluatorScheduler
 *                    -> alert_instances -> AlertEscalationService
 *                    -> NotificationDeliveryService
 *
 * EngineModule is imported for the Kamex adapter's typed `queueSnapshot()`
 * (the poller's only engine dependency) and for the SQLBox repository that
 * backs `sms` notification delivery.
 *
 * Exports {@link PlatformMetricsService} and {@link EngineMetricsService} so the
 * app-level MetricsController can append their output to /metrics; the
 * controller injects both with @Optional, so the wiring stays additive.
 */
@Module({
  imports: [AuthModule, EngineModule],
  controllers: [
    EscalationController,
    MaintenanceController,
    CorrelationController,
    NotificationReadinessController,
    AlertLifecycleController,
    SystemInfoController,
  ],
  providers: [
    DatabaseService,
    MonitoringDepthRepository,
    AlertLifecycleRepository,
    NotificationReadinessService,
    PlatformMetricsService,
    MaintenanceWindowService,
    AlertEscalationService,
    AlertCorrelationService,
    NotificationDeliveryService,
    AlertEvaluatorService,
    EngineSnapshotCache,
    EngineMetricsService,
    SmscStatusPoller,
    AlertRuleEvaluatorScheduler,
    SystemInfoService,
    TelemetryFreshnessService,
  ],
  exports: [
    AlertLifecycleRepository,
    NotificationReadinessService,
    PlatformMetricsService,
    EngineMetricsService,
    MaintenanceWindowService,
    AlertCorrelationService,
    AlertEscalationService,
    EngineSnapshotCache,
    SmscStatusPoller,
    TelemetryFreshnessService,
  ],
})
export class MonitoringDepthModule {}
