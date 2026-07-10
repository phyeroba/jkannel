import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import {
  AlertsController,
  ConfigurationsController,
  ReadModelsController,
  RoutesController,
  SettingsController,
  SmscController,
  UsersController,
} from './console.controllers';
import { ConsoleRepository } from './console.repository';
import { EngineModule } from '../engine/engine.module';
import { ConfigurationGeneratorService } from '../configuration/configuration-generator.service';
import { ConfigurationDeploymentService } from '../configuration/configuration-deployment.service';
import { ConfigurationDiffService } from '../configuration/configuration-diff.service';
import { SmscConnectivityService } from '../smsc/smsc-connectivity.service';
import { RoutingService } from '../routing/routing.service';
import { NotificationDeliveryService } from '../monitoring/notification-delivery.service';
import { AnomalyDetectionService } from '../monitoring/anomaly-detection.service';
import { ExportService } from '../platform/export.service';
import { ReportJobsService } from '../reporting/report-jobs.service';
import { ReportingAnalyticsService } from '../reporting/reporting-analytics.service';
import { ReportingAnalyticsController } from '../reporting/reporting-analytics.controller';
import { NotificationsController, VolumeReportsController } from './notifications.controllers';
@Module({
  imports: [AuthModule, EngineModule],
  controllers: [
    SmscController,
    RoutesController,
    AlertsController,
    SettingsController,
    UsersController,
    ConfigurationsController,
    ReadModelsController,
    NotificationsController,
    VolumeReportsController,
    ReportingAnalyticsController,
  ],
  providers: [
    DatabaseService,
    ConsoleRepository,
    ConfigurationGeneratorService,
    ConfigurationDeploymentService,
    ConfigurationDiffService,
    SmscConnectivityService,
    RoutingService,
    NotificationDeliveryService,
    AnomalyDetectionService,
    ExportService,
    ReportJobsService,
    ReportingAnalyticsService,
  ],
})
export class ConsoleModule {}
