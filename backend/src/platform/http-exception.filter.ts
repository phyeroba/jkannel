import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ContextRequest } from './request-context.middleware';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): void;
}

/**
 * The per-field detail a thrown exception carried, or an empty list.
 *
 * This used to be a hardcoded `errors: []`, which discarded the structured
 * detail of EVERY validation error in the platform. A configuration refusing to
 * generate answered "Configuration validation failed" and nothing else, when
 * the thrower had passed a list naming each field and why — so an operator was
 * told their configuration was invalid and left to guess which part.
 *
 * 4xx ONLY. A 5xx body is already reduced to "An internal error occurred" on
 * purpose, and attaching internals to it would undo that: an unexpected server
 * fault can carry a stack, a query or a path, and none of that belongs in a
 * response. A client error, by contrast, is a statement about the REQUEST, and
 * saying which part of it is wrong is the whole job.
 *
 * Only arrays of strings pass through. Anything else — an object, a nested
 * exception, a value — is dropped rather than serialised blind, because "what
 * exactly is in here" must not depend on what some future thrower decided to
 * attach.
 */
function detailsOf(exception: unknown, status: number): string[] {
  if (status >= 500 || !(exception instanceof HttpException)) return [];
  const body = exception.getResponse();
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter((entry): entry is string => typeof entry === 'string').slice(0, 50);
}

/**
 * `retryAfterSeconds` on a 429, and nothing else.
 *
 * The auth throttle raises its exception carrying exactly how long the lockout
 * lasts, and this filter rebuilt the response body from a fixed shape — so the
 * number was computed, attached, and then discarded on the way out. The console
 * was left showing "Try again later" with no idea whether later meant a minute
 * or a quarter of an hour, which is the difference between waiting and filing a
 * bug against whichever screen happened to be open.
 *
 * Narrow on purpose: one numeric field, on one status, from an HttpException.
 * A general "copy unknown fields through" would undo the reason this filter
 * builds a fixed body in the first place.
 */
function retryAfterOf(exception: unknown, status: number): { retryAfterSeconds?: number } {
  if (status !== HttpStatus.TOO_MANY_REQUESTS || !(exception instanceof HttpException)) return {};
  const body = exception.getResponse();
  if (!body || typeof body !== 'object') return {};
  const seconds = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? { retryAfterSeconds: Math.ceil(seconds) }
    : {};
}

/** Never throws, whatever was thrown — a logger that fails hides the failure. */
function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) || String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  /**
   * Writes the cause of a 5xx to the SERVER LOG, having withheld it from the
   * response.
   *
   * Withholding it from the response is right and stays. Not recording it
   * anywhere was not a second half of that decision, it was an omission, and it
   * makes a 500 undiagnosable: the operator gets "An internal error occurred"
   * and the log has only the access line — status 500, a duration, no reason.
   *
   * Found the hard way. A throughput run produced twelve 500s out of five
   * hundred submissions; the access log recorded twelve 500s at about nine
   * seconds each and the entire rest of the log had nothing about them. There
   * was no way to learn what had failed short of adding this.
   *
   * The `request_id` in the response body is the correlation id logged here, so
   * an operator reporting "I got an error, request 9da048…" is enough to find
   * the stack. That is the trade this restores: the client learns nothing, and
   * the people running the gateway learn everything.
   *
   * 4xx is not logged. Those are statements about the request, the response
   * already says exactly what was wrong, and logging each one turns a client
   * looping on a bad payload into a log flood.
   */
  private record(exception: unknown, request: ContextRequest, status: number) {
    if (status < 500) return;
    const where = `${request.method ?? '?'} ${request.url ?? '?'}`;
    const context = `${where} correlation=${request.correlationId ?? 'none'}`;
    if (exception instanceof Error) this.logger.error(`${context}: ${exception.message}`, exception.stack);
    // A thrown non-Error has no stack to give. Serialise what there is rather
    // than logging "[object Object]", which is the same dead end one step later.
    else this.logger.error(`${context}: ${safeString(exception)}`);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ContextRequest>();
    const response = http.getResponse<ErrorResponse>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      status >= 500
        ? 'An internal error occurred'
        : exception instanceof HttpException
          ? exception.message
          : 'Request failed';
    this.record(exception, request, status);
    response.status(status).json({
      success: false,
      request_id: request.requestId,
      correlation_id: request.correlationId,
      timestamp: new Date().toISOString(),
      api_version: 'v1',
      error_code: `HTTP_${status}`,
      error_name: HttpStatus[status] ?? 'Error',
      error_category: status >= 500 ? 'Internal' : 'Request',
      message,
      errors: detailsOf(exception, status),
      ...retryAfterOf(exception, status),
    });
  }
}
