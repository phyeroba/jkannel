import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { ContextRequest } from './request-context.middleware';

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ContextRequest>();
    return next.handle().pipe(
      map((data) => ({
        success: true,
        request_id: request.requestId,
        correlation_id: request.correlationId,
        timestamp: new Date().toISOString(),
        api_version: 'v1',
        execution_time_ms: Date.now() - (request.requestStartedAt ?? Date.now()),
        data,
        meta: {},
        links: {},
        errors: [],
        warnings: [],
      })),
    );
  }
}
