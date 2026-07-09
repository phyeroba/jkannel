import { Injectable, NestMiddleware } from '@nestjs/common';

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(_request: unknown, response: HeaderResponse, next: () => void): void {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    response.setHeader('cache-control', 'no-store');
    if (process.env.NODE_ENV === 'production')
      response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    next();
  }
}
