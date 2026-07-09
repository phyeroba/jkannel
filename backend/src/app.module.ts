import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { RequestContextMiddleware } from './platform/request-context.middleware';
import { AuthModule } from './security/auth.module';
import { EngineModule } from './engine/engine.module';
import { DomainModule } from './domain.module';
import { ConsoleModule } from './console/console.module';
import { AiOperationsModule } from './ai-operations/ai-operations.module';
import { AiCopilotModule } from './ai-copilot/ai-copilot.module';
import { SecurityHeadersMiddleware } from './platform/security-headers.middleware';
import { MetricsController } from './monitoring/metrics.controller';
import { DatabaseService } from './database/database.service';
import { IdempotencyService } from './platform/idempotency.service';
import { IdempotencyInterceptor } from './platform/idempotency.interceptor';
import { AuditTrailInterceptor } from './platform/audit-trail.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JobsController } from './platform/jobs.controller';
import { JobsService } from './platform/jobs.service';
import { OpenApiController } from './platform/openapi.controller';
import { MetricsRegistry } from './monitoring/metrics.registry';
import { MetricsInterceptor } from './monitoring/metrics.interceptor';

@Module({
  imports: [
    AuthModule,
    EngineModule,
    DomainModule,
    ConsoleModule,
    AiOperationsModule,
    AiCopilotModule,
  ],
  controllers: [HealthController, MetricsController, JobsController, OpenApiController],
  providers: [
    HealthService,
    DatabaseService,
    IdempotencyService,
    JobsService,
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
