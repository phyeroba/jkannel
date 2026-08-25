import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
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
    });
  }
}
