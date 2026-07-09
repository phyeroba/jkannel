import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/environment';
import { runMigrations } from './database/migration-runner';
import { HttpExceptionFilter } from './platform/http-exception.filter';
import { JsonLogger } from './platform/json.logger';
import { ResponseEnvelopeInterceptor } from './platform/response-envelope.interceptor';

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  if (process.env.MIGRATIONS_ON_BOOT === 'true') {
    await runMigrations('up');
  }
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.enableCors({
    origin: (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((value) => value.trim()),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-correlation-id', 'idempotency-key'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();
  await app.listen(environment.port, '0.0.0.0');
}

void bootstrap();
