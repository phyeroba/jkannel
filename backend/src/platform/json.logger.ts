import { LoggerService } from '@nestjs/common';
import { LogEntry, sharedLogBuffer } from './log-buffer';
import { requestLogFields } from './request-context.store';

/**
 * The facts an HTTP access line carries. The correlation fields are passed
 * explicitly rather than read from AsyncLocalStorage because the line is
 * emitted from a `response.on('finish')` listener, which Node may run outside
 * the request's async scope.
 */
export interface HttpLogFields {
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  message?: string;
  correlationId?: string;
  requestId?: string;
  userId?: string;
  tenantId?: string;
  username?: string;
  clientIp?: string;
}

/**
 * Structured JSON logger.
 *
 * Every line now carries the request it belongs to — correlation id, request
 * id, user, tenant, route — read from the AsyncLocalStorage context opened by
 * RequestContextMiddleware. Before this, a line was `{timestamp, level,
 * context, message}` and nothing tied one service's log to another's, so an
 * incident could not be traced across a request at all.
 *
 * Every line is also appended to the process-local ring buffer that backs
 * `GET /observability/logs`. That buffer is explicitly not durable; see
 * {@link LogBufferService}.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  /**
   * One line per completed HTTP request: method, route, status, duration and
   * the same correlation fields, so a slow or failing call can be found by id.
   */
  http(fields: HttpLogFields): void {
    const status = fields.status ?? 0;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    this.emit({
      timestamp: new Date().toISOString(),
      level,
      context: 'HTTP',
      message: fields.message ?? `${fields.method ?? 'GET'} ${fields.route ?? '/'} ${status}`,
      ...requestLogFields(),
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    });
  }

  private write(level: string, message: unknown, context?: string, trace?: string): void {
    this.emit({
      timestamp: new Date().toISOString(),
      level,
      context,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...requestLogFields(),
      ...(trace ? { trace } : {}),
    });
  }

  private emit(entry: LogEntry): void {
    // Buffer first: a stdout failure must not lose the queryable copy.
    try {
      sharedLogBuffer().push(entry);
    } catch {
      // A logger that throws is worse than a lost buffer entry.
    }
    const output = JSON.stringify(entry);
    if (entry.level === 'error') console.error(output);
    else console.log(output);
  }
}

let shared: JsonLogger | undefined;

/** Process-wide logger for code outside Nest's injector (middleware, boot). */
export function sharedJsonLogger(): JsonLogger {
  return (shared ??= new JsonLogger());
}
