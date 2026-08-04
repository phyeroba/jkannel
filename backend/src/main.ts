import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/environment';
import { runMigrations } from './database/migration-runner';
import { HttpExceptionFilter } from './platform/http-exception.filter';
import { JsonLogger } from './platform/json.logger';
import { ResponseEnvelopeInterceptor } from './platform/response-envelope.interceptor';
import { expressTrustProxySetting, trustedProxyConfig } from './security/client-ip';

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  if (process.env.MIGRATIONS_ON_BOOT === 'true') {
    await runMigrations('up');
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger(),
  });
  // Without this Express leaves `req.ip` as the socket peer (always the proxy)
  // and any code reading X-Forwarded-For directly trusts a client-supplied
  // header. Configure it explicitly from TRUSTED_PROXIES / TRUSTED_PROXY_COUNT
  // (default: 1 hop = the bundled nginx) so `req.ip` and `req.clientIp` agree.
  // See security/client-ip.ts for the derivation rules.
  const proxies = trustedProxyConfig();
  app.set('trust proxy', expressTrustProxySetting(proxies));
  app.enableCors({
    origin: (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((value) => value.trim()),
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-correlation-id',
      'idempotency-key',
      // Consent header for the opt-in AI Operations Copilot; without it the
      // browser CORS preflight blocks the request ("Failed to fetch").
      'x-jkannel-ai-opt-in',
    ],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();
  await app.listen(environment.port, '0.0.0.0');
}

void bootstrap();
