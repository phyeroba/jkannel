import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { ExportService } from '../platform/export.service';
import { NotificationDeliveryService } from '../monitoring/notification-delivery.service';
import { ReportingAnalyticsService } from '../reporting/reporting-analytics.service';
import { ReportDefinitionsController } from './report-definitions.controller';
import { ReportDefinitionsRepository } from './report-definitions.repository';
import { ReportScheduleService } from './report-schedule.service';
import { DlrPerformanceController } from './dlr-performance.controller';
import { DlrPerformanceService } from './dlr-performance.service';

/**
 * Reporting-depth feature module: saved/named report definitions and scheduled
 * report export delivery. It re-provides {@link ReportingAnalyticsService} (a
 * stateless reader of report snapshots + SQLBox) so the scheduler can re-run
 * catalog report kinds without a cross-module dependency on ConsoleModule.
 *
 * EngineModule is imported for the KamexSqlboxRepository that
 * ReportingAnalyticsService depends on.
 */
@Module({
  imports: [AuthModule, EngineModule],
  controllers: [ReportDefinitionsController, DlrPerformanceController],
  providers: [
    DatabaseService,
    DlrPerformanceService,
    ReportDefinitionsRepository,
    ReportingAnalyticsService,
    ExportService,
    NotificationDeliveryService,
    ReportScheduleService,
  ],
})
export class ReportingDepthModule {}
