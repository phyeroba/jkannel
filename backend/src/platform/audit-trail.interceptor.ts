import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { DatabaseService } from '../database/database.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Reads that expose bulk or sensitive data are audited as well.
const SENSITIVE_READ_PATTERNS = [/\/export\.(csv|pdf)$/i, /\/trace$/i, /^\/api\/v1\/audit-events/i];
const REDACTED_BODY_KEYS = /pass(word)?|secret|token|credential|key/i;

interface AuditableRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  correlationId?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  principal?: { tenantId: string; userId: string; username?: string };
}

export function redactBody(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactBody(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        REDACTED_BODY_KEYS.test(key) ? '[redacted]' : redactBody(entry, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 512) return `${value.slice(0, 512)}…`;
  return value;
}

/**
 * Global audit trail: records who did what and when for every authenticated
 * mutating request and for sensitive reads (exports, traces, audit queries).
 * Domain services keep their own richer audit entries; this interceptor
 * guarantees there is no unaudited write path.
 */
@Injectable()
export class AuditTrailInterceptor implements NestInterceptor {
  constructor(private readonly database: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditableRequest>();
    const method = (request.method ?? 'GET').toUpperCase();
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const sensitiveRead = SENSITIVE_READ_PATTERNS.some((pattern) => pattern.test(path));
    if (!request.principal || (!MUTATING_METHODS.has(method) && !sensitiveRead)) {
      return next.handle();
    }
    return next.handle().pipe(
      tap(() => void this.record(request, method, path, 'success')),
      catchError((error) => {
        void this.record(request, method, path, 'failure', String(error?.message ?? error));
        return throwError(() => error);
      }),
    );
  }

  private async record(
    request: AuditableRequest,
    method: string,
    path: string,
    outcome: 'success' | 'failure',
    reason?: string,
  ): Promise<void> {
    const principal = request.principal!;
    try {
      await this.database.tenantTransaction(principal.tenantId, (client) =>
        client.query(
          `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason,correlation_id,source_ip)
           VALUES($1,$2,$3,'http_request',$4,$5,$6,$7,$8)`,
          [
            principal.tenantId,
            principal.userId,
            `http.${method.toLowerCase()}`,
            path,
            JSON.stringify({ outcome, body: redactBody(request.body) }),
            reason ?? null,
            request.correlationId ?? null,
            request.ip ?? request.socket?.remoteAddress ?? null,
          ],
        ),
      );
    } catch (error) {
      // Never fail the user's request because the supplementary audit write
      // failed, but surface it loudly: silence here would hide gaps.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'audit trail write failed',
          path,
          error: String((error as Error).message ?? error),
        }),
      );
    }
  }
}
