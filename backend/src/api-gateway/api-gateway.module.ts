import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { EngineModule } from '../engine/engine.module';
import { MessagingDepthModule } from '../messaging-depth/messaging-depth.module';
import { ApiGatewayController } from './api-gateway.controller';
import { GatewayMessagingController } from './gateway-messaging.controller';
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
 *
 * {@link GatewayMessagingController} is the business API the gateway exists to
 * protect: API-key-authenticated message submission and message/routing-decision
 * reads, with the key's scopes enforced by PermissionsGuard. It imports
 * {@link MessagingDepthModule} so submissions go through the single send path
 * (routing, blocklist, customer entitlements) rather than spooling directly.
 */
@Module({
  imports: [AuthModule, EngineModule, MessagingDepthModule],
  controllers: [ApiGatewayController, GatewayMessagingController],
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
