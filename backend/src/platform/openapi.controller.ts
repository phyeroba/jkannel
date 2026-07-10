import { Controller, Get, Res } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { buildOpenApiDocument } from './openapi-generator';

interface RawResponse {
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

/**
 * Serves the auto-generated OpenAPI 3.1 document at its historical path
 * (/openapi.json, i.e. /api/v1/openapi.json). The document is derived at
 * request time from the controllers actually registered in the running
 * application (via Nest's DiscoveryService) rather than a hand-maintained
 * partial, so newly added route groups (reports/analytics, reports/definitions,
 * configurations/templates, configurations/drift, message-ops, bulk-send,
 * routing, gateway, customer-accounts, ...) appear automatically. See
 * openapi-generator.ts for exactly what is derived and the honest limitations.
 */
@Controller()
export class OpenApiController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('openapi.json')
  document(@Res() response: RawResponse): void {
    const controllers = this.discovery
      .getControllers()
      .map((wrapper) => wrapper.metatype)
      .filter(
        (metatype): metatype is new (...args: unknown[]) => unknown =>
          typeof metatype === 'function',
      );
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.send(buildOpenApiDocument(controllers));
  }
}
