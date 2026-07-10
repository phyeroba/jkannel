import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { GatewayAuditInterceptor } from './gateway-audit.interceptor';
import { GatewayKeyAuthenticator } from './gateway-key-authenticator';
import { GatewayKeysService } from './gateway-keys.service';
import { GatewayLogRepository } from './gateway-log.repository';
import { GatewayRateLimiter } from './gateway-rate-limiter';
import { gatewayRedisProvider } from './redis.provider';

/**
 * API Gateway depth: real per-client enforcement for API-key-authenticated
 * traffic — Redis-backed per-key rate limiting (429 + Retry-After, fail-open),
 * per-key IP allowlist (403), key expiry/lifecycle, and a tenant-scoped
 * per-request audit log. Depends on {@link AuthModule} for the JWT AuthGuard /
 * PermissionsGuard used on the management endpoints.
 */
@Module({
  imports: [AuthModule],
  controllers: [ApiGatewayController],
  providers: [
    DatabaseService,
    gatewayRedisProvider,
    GatewayRateLimiter,
    GatewayKeyAuthenticator,
    GatewayLogRepository,
    GatewayKeysService,
    ApiKeyAuthGuard,
    GatewayAuditInterceptor,
  ],
})
export class ApiGatewayModule {}
