import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ContextRequest } from './request-context.middleware';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): void;
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
      errors: [],
    });
  }
}
