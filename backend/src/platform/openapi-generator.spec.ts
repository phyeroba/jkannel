import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../security/auth.guard';
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
