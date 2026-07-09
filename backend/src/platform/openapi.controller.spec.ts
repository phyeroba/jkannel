import { OpenApiController } from './openapi.controller';

describe('OpenApiController', () => {
  it('serves a raw OpenAPI document with platform primitive paths', () => {
    const controller = new OpenApiController();
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
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.paths['/jobs']).toBeDefined();
    expect(response.body.paths['/jobs/{id}/cancel']).toBeDefined();
    expect(response.body.components.headers.IdempotencyKey).toBeDefined();
  });
});
