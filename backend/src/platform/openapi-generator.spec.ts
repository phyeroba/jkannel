import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../security/auth.guard';
import { ApiKeyAuthGuard } from '../api-gateway/api-key-auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { buildOpenApiDocument, collectRoutes } from './openapi-generator';

@Controller('widgets')
@UseGuards(AuthGuard, PermissionsGuard)
class WidgetsController {
  @Get() @RequirePermissions('widgets.view') list(@Query() _q: unknown) {
    return [];
  }
  @Get(':id') get(@Param('id') _id: string) {
    return {};
  }
  @Post() @RequirePermissions('widgets.manage') create() {
    return {};
  }
}

@Controller('public-thing')
class PublicController {
  @Get('ping') ping(@Query('mode') _mode?: string) {
    return 'ok';
  }
}

@Controller('gatewayish')
@UseGuards(ApiKeyAuthGuard, PermissionsGuard)
class ApiKeyController {
  @Post('messages') @RequirePermissions('sms.send') submit() {
    return {};
  }
}

describe('collectRoutes', () => {
  it('reflects path, method, path-params and auth from real decorators', () => {
    const routes = collectRoutes([WidgetsController, PublicController]);
    const byId = (path: string, method: string) =>
      routes.find((r) => r.path === path && r.method === method);

    expect(byId('/widgets', 'get')?.secured).toBe(true);
    expect(byId('/widgets', 'get')?.permissions).toEqual(['widgets.view']);
    expect(byId('/widgets', 'get')?.wholeQuery).toBe(true);

    const detail = byId('/widgets/{id}', 'get');
    expect(detail?.parameters).toContainEqual({ name: 'id', in: 'path', required: true });

    expect(byId('/widgets', 'post')?.method).toBe('post');
    expect(byId('/public-thing/ping', 'get')?.secured).toBe(false);
  });

  /**
   * Regression: the generator recognised only `AuthGuard` by name, so every
   * API-key-guarded route was emitted with `security: []`. The console's API
   * Reference renders that document verbatim, so the effect was the reference
   * telling readers that `/gateway/*` — the externally-reachable send API —
   * needed no credential. A false "public" on a secured route is the worst
   * direction for this error to point, hence a test rather than a comment.
   */
  it('emits the API-key scheme for ApiKeyAuthGuard rather than calling it public', () => {
    const routes = collectRoutes([ApiKeyController]);
    const submit = routes.find((r) => r.path === '/gatewayish/messages');
    expect(submit?.secured).toBe(true);
    expect(submit?.authSchemes).toEqual(['apiKeyAuth']);

    const document = buildOpenApiDocument([ApiKeyController]) as any;
    expect(document.paths['/gatewayish/messages'].post.security).toEqual([{ apiKeyAuth: [] }]);
    expect(document.components.securitySchemes.apiKeyAuth).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
  });

  it('keeps bearer and public routes distinct from API-key ones', () => {
    const routes = collectRoutes([WidgetsController, PublicController, ApiKeyController]);
    const schemes = (path: string) => routes.find((r) => r.path === path)?.authSchemes;
    expect(schemes('/widgets')).toEqual(['bearerAuth']);
    expect(schemes('/public-thing/ping')).toEqual([]);
    expect(schemes('/gatewayish/messages')).toEqual(['apiKeyAuth']);
  });

  it('recovers named query parameters', () => {
    const routes = collectRoutes([PublicController]);
    const ping = routes.find((r) => r.path === '/public-thing/ping');
    expect(ping?.parameters).toContainEqual({ name: 'mode', in: 'query', required: false });
    expect(ping?.wholeQuery).toBe(false);
  });
});

describe('buildOpenApiDocument', () => {
  it('emits grid/cursor/field parameters for whole-query GET list endpoints', () => {
    const doc = buildOpenApiDocument([WidgetsController]) as any;
    const params = doc.paths['/widgets'].get.parameters;
    const refs = params.map((p: any) => p.$ref).filter(Boolean);
    expect(refs).toEqual(
      expect.arrayContaining([
        '#/components/parameters/GridSearch',
        '#/components/parameters/GridCursor',
        '#/components/parameters/GridFields',
      ]),
    );
    expect(doc.paths['/widgets'].post['x-required-permissions']).toEqual(['widgets.manage']);
    expect(doc['x-generation'].routeCount).toBeGreaterThan(0);
  });
});
