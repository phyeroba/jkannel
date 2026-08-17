import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { RequestContextMiddleware } from './platform/request-context.middleware';
import { AuthModule } from './security/auth.module';
import { EngineModule } from './engine/engine.module';
import { DomainModule } from './domain.module';
import { ConsoleModule } from './console/console.module';
import { ConfigurationDepthModule } from './configuration-depth/configuration-depth.module';
import { AiOperationsModule } from './ai-operations/ai-operations.module';
import { AiCopilotModule } from './ai-copilot/ai-copilot.module';
import { PlatformConsoleModule } from './platform-console/platform-console.module';
import { SecurityHeadersMiddleware } from './platform/security-headers.middleware';
import { MetricsController } from './monitoring/metrics.controller';
import { DatabaseService } from './database/database.service';
import { IdempotencyService } from './platform/idempotency.service';
import { IdempotencyInterceptor } from './platform/idempotency.interceptor';
import { AuditTrailInterceptor } from './platform/audit-trail.interceptor';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { JobsModule } from './platform/jobs.module';
import { OpenApiController } from './platform/openapi.controller';
import { MetricsRegistry } from './monitoring/metrics.registry';
import { MetricsInterceptor } from './monitoring/metrics.interceptor';
import { BackupDrModule } from './backup-dr/backup-dr.module';
import { MonitoringDepthModule } from './monitoring-depth/monitoring-depth.module';
import { ConnectivityModule } from './connectivity/connectivity.module';
import { CustomersModule } from './customers/customers.module';
import { CustomersDepthModule } from './customers-depth/customers-depth.module';
import { MessagingDepthModule } from './messaging-depth/messaging-depth.module';
import { DeliveryRetryModule } from './delivery-retry/delivery-retry.module';
import { ReportingDepthModule } from './reporting-depth/reporting-depth.module';
import { RoutingDepthModule } from './routing-depth/routing-depth.module';
import { ApiGatewayModule } from './api-gateway/api-gateway.module';
import { DataModelModule } from './data-model/data-model.module';
import { QueueConsoleModule } from './queue-console/queue-console.module';
import { LoggingModule } from './platform/logging.module';

@Module({
  imports: [
    // Provides DiscoveryService so OpenApiController can reflect the live route table.
    DiscoveryModule,
    AuthModule,
    // @Global: owns /jobs, the JobWorker executor and the JobHandlerRegistry
    // that domain modules register their job types with. Imported before the
    // domain modules so the registry exists when they initialise.
    JobsModule,
    EngineModule,
    DomainModule,
    // Registered before ConsoleModule so /configurations/templates* and
    // /configurations/drift* match ahead of ConfigurationsController's
    // /configurations/:id route.
    ConfigurationDepthModule,
    ConsoleModule,
    AiOperationsModule,
    AiCopilotModule,
    PlatformConsoleModule,
    BackupDrModule,
    MonitoringDepthModule,
    ConnectivityModule,
    CustomersModule,
    CustomersDepthModule,
    MessagingDepthModule,
    // Consumes MessagingDepthModule's send path, so it is registered after it.
    DeliveryRetryModule,
    ReportingDepthModule,
    RoutingDepthModule,
    ApiGatewayModule,
    DataModelModule,
    QueueConsoleModule,
    // /observability/logs: searches the ring buffer JsonLogger fills.
    LoggingModule,
  ],
  controllers: [HealthController, MetricsController, OpenApiController],
  providers: [
    HealthService,
    DatabaseService,
    IdempotencyService,
    MetricsRegistry,
    // Metrics first so it times the full downstream handler chain.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditTrailInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SecurityHeadersMiddleware, RequestContextMiddleware).forRoutes('*');
  }
}
