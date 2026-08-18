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
import { MessagingDepthModule } from '../messaging-depth/messaging-depth.module';
import { ConfigurationGeneratorService } from '../configuration/configuration-generator.service';
import { ConfigurationDeploymentService } from '../configuration/configuration-deployment.service';
import { ConfigurationDiffService } from '../configuration/configuration-diff.service';
import { ConfigurationModelBuilder } from '../configuration/configuration-model.builder';
import { SecretResolver } from '../configuration/secret-resolver.service';
import { SmscConnectivityService } from '../smsc/smsc-connectivity.service';
import { SmppBindProber } from '../smsc/smpp-bind-prober';
import { SmscService } from '../smsc/smsc.service';
import { RoutingService } from '../routing/routing.service';
import { NotificationDeliveryService } from '../monitoring/notification-delivery.service';
import { AnomalyDetectionService } from '../monitoring/anomaly-detection.service';
import { ExportService } from '../platform/export.service';
import { ReportJobsService } from '../reporting/report-jobs.service';
import { ReportingAnalyticsService } from '../reporting/reporting-analytics.service';
import { ReportingAnalyticsController } from '../reporting/reporting-analytics.controller';
import { NotificationsController, VolumeReportsController } from './notifications.controllers';
import { PrivacyModule } from '../privacy/privacy.module';
@Module({
  // MessagingDepthModule supplies MessageSendService so the console's
  // POST /messages goes through the same routing / entitlement / decision
  // pipeline as every other send path instead of spooling to SQLBox directly.
  // PrivacyModule supplies PiiRevealService, which is what makes the masking on
  // /messages, the CSV export and /queues something a caller can see through
  // only with a live, reasoned, audited grant.
  imports: [AuthModule, EngineModule, MessagingDepthModule, PrivacyModule],
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
    // Builds EngineConfiguration from smsc_definitions so /configurations/generate
    // renders the tenant's real SMSCs instead of a caller-supplied model.
    SecretResolver,
    ConfigurationModelBuilder,
    // Performs the actual SMPP handshake behind "Test connection"; without it
    // the check degrades (honestly) to TCP reachability only.
    SmppBindProber,
    SmscConnectivityService,
    SmscService,
    RoutingService,
    NotificationDeliveryService,
    AnomalyDetectionService,
    ExportService,
    ReportJobsService,
    ReportingAnalyticsService,
  ],
})
export class ConsoleModule {}
