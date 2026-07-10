import { DiscoveryService } from '@nestjs/core';
import { JobsController } from './jobs.controller';
import { HealthController } from '../health/health.controller';
import { OpenApiController } from './openapi.controller';

/** Minimal DiscoveryService stub returning a fixed set of registered controllers. */
function fakeDiscovery(controllers: unknown[]): DiscoveryService {
  return {
    getControllers: () => controllers.map((metatype) => ({ metatype })),
  } as unknown as DiscoveryService;
}

describe('OpenApiController', () => {
  function render(controllers: unknown[]) {
    const controller = new OpenApiController(fakeDiscovery(controllers));
    const response = {
      headers: {} as Record<string, string>,
      body: null as any,
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      send(body: any) {
        this.body = body;
      },
    };
    controller.document(response);
    return response;
  }

  it('serves an OpenAPI 3.1 document auto-derived from registered controllers', () => {
    const response = render([JobsController, HealthController]);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.openapi).toBe('3.1.0');
    // Reflected from JobsController's real decorators (path + method + :id -> {id}).
    expect(response.body.paths['/jobs'].get).toBeDefined();
    expect(response.body.paths['/jobs'].post).toBeDefined();
    expect(response.body.paths['/jobs/{id}/cancel'].post).toBeDefined();
    expect(response.body.components.headers.IdempotencyKey).toBeDefined();
  });

  it('marks AuthGuard-protected routes as bearer-secured and public ones as open', () => {
    const response = render([JobsController, HealthController]);
    // JobsController is @UseGuards(AuthGuard, ...) -> secured.
    expect(response.body.paths['/jobs'].get.security).toEqual([{ bearerAuth: [] }]);
    // HealthController has no AuthGuard -> public.
    expect(response.body.paths['/health'].get.security).toEqual([]);
  });

  it('reflects required permissions and header parameters from decorators', () => {
    const response = render([JobsController]);
    expect(response.body.paths['/jobs'].get['x-required-permissions']).toContain('system.view');
    const createParams = response.body.paths['/jobs'].post.parameters ?? [];
    expect(createParams.some((p: any) => p.in === 'header' && p.name === 'idempotency-key')).toBe(
      true,
    );
  });

  it('reports its generation strategy and limitations honestly', () => {
    const response = render([HealthController]);
    expect(response.body['x-generation'].strategy).toBe('reflected-from-controllers');
    expect(Array.isArray(response.body['x-generation'].limitations)).toBe(true);
  });
});
