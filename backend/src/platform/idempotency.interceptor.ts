import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { from, mergeMap, Observable, of } from 'rxjs';
import { AuthenticatedRequest } from '../security/auth.guard';
import { ContextRequest } from './request-context.middleware';
import { IdempotencyService } from './idempotency.service';

type Request = ContextRequest & AuthenticatedRequest;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next.handle();
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return next.handle();
    const normalizedKey = key.trim();
    if (normalizedKey.length < 8 || normalizedKey.length > 128)
      throw new ConflictException('Idempotency-Key must be between 8 and 128 characters');
    if (!request.principal) return next.handle();
    const route = this.normalizedRoute(request);
    const hash = this.idempotency.hashRequest(method, route, request.body);
    return from(
      this.idempotency.begin(
        { tenantId: request.principal.tenantId, userId: request.principal.userId },
        normalizedKey,
        method,
        route,
        hash,
      ),
    ).pipe(
      mergeMap((record) => {
        if (record.replayed) return of(record.response_body);
        return next
          .handle()
          .pipe(
            mergeMap((data) =>
              from(
                this.idempotency.complete(
                  { tenantId: request.principal!.tenantId, userId: request.principal!.userId },
                  record.id,
                  data,
                ),
              ).pipe(mergeMap(() => of(data))),
            ),
          );
      }),
    );
  }

  private normalizedRoute(request: Request): string {
    const raw = request.originalUrl ?? request.url ?? '/';
    return raw.split('?')[0].replace(/^\/api\/v1/, '') || '/';
  }
}
