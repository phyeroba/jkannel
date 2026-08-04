import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { GatewayRequest, callerIp } from './api-key-auth.guard';
import { GatewayLogRepository } from './gateway-log.repository';

interface StatusResponse {
  statusCode?: number;
}

/**
 * Records the final outcome of gateway-authenticated requests that passed the
 * {@link ApiKeyAuthGuard}. Runs after the handler so the true HTTP status is
 * known. No-op for non-gateway requests (no `gatewayClient` on the request).
 * Blocked requests (403/429) are logged by the guard itself, since a rejected
 * guard short-circuits the interceptor chain.
 */
@Injectable()
export class GatewayAuditInterceptor implements NestInterceptor {
  constructor(private readonly log: GatewayLogRepository) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<GatewayRequest>();
    if (!request.gatewayClient) return next.handle();
    const response = http.getResponse<StatusResponse>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(
        () =>
          void this.write(request, response.statusCode ?? 200, 'allowed', Date.now() - startedAt),
      ),
      catchError((error: unknown) => {
        const status = (error as { status?: number }).status ?? 500;
        void this.write(
          request,
          status,
          status === 401 ? 'unauthorized' : 'error',
          Date.now() - startedAt,
        );
        return throwError(() => error);
      }),
    );
  }

  private write(
    request: GatewayRequest,
    status: number,
    outcome: 'allowed' | 'unauthorized' | 'error',
    durationMs: number,
  ): void {
    const client = request.gatewayClient!;
    void this.log.record({
      tenantId: client.tenantId,
      apiKeyId: client.apiKeyId,
      keyPrefix: client.keyPrefix,
      route: (request.originalUrl ?? request.url ?? '').split('?')[0],
      method: (request.method ?? 'GET').toUpperCase(),
      statusCode: status,
      outcome,
      ipAddress: callerIp(request) ?? null,
      correlationId: request.correlationId ?? null,
      durationMs,
      userId: client.userId ?? null,
    });
  }
}
