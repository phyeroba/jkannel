import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';

export interface ContextRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  requestId?: string;
  correlationId?: string;
  requestStartedAt?: number;
}
interface ContextResponse {
  setHeader(name: string, value: string): void;
}
type Next = () => void;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: ContextRequest, response: ContextResponse, next: Next): void {
    request.requestId = randomUUID();
    const supplied = request.headers['x-correlation-id'];
    request.correlationId =
      typeof supplied === 'string' && supplied.trim() ? supplied.trim() : request.requestId;
    request.requestStartedAt = Date.now();
    response.setHeader('x-request-id', request.requestId);
    response.setHeader('x-correlation-id', request.correlationId);
    next();
  }
}
