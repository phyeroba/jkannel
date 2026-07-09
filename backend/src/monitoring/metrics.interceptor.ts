import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MetricsRegistry } from './metrics.registry';

/** Records request count and latency for every HTTP request into the registry. */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsRegistry) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ method?: string }>();
    const started = Date.now();
    return next.handle().pipe(
      finalize(() => {
        const response = http.getResponse<{ statusCode?: number }>();
        this.metrics.recordHttpRequest(
          request.method ?? 'GET',
          response.statusCode ?? 200,
          Date.now() - started,
        );
      }),
    );
  }
}
