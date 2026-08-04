import { RequestContextMiddleware, logRoute } from './request-context.middleware';
import { currentRequestContext, requestLogFields } from './request-context.store';
import { sharedLogBuffer } from './log-buffer';

function fakeResponse() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    headers: {} as Record<string, string>,
    statusCode: 200,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    on(event: string, listener: () => void) {
      (listeners[event] ??= []).push(listener);
    },
    finish() {
      for (const listener of listeners.finish ?? []) listener();
    },
  };
}

describe('RequestContextMiddleware', () => {
  const middleware = new RequestContextMiddleware();

  beforeEach(() => sharedLogBuffer().clear());

  it('reuses a supplied correlation id and echoes both ids back', () => {
    const request: any = {
      headers: { 'x-correlation-id': 'corr-from-caller' },
      method: 'GET',
      originalUrl: '/api/v1/alerts?limit=10',
    };
    const response = fakeResponse();
    middleware.use(request, response, () => undefined);
    expect(request.correlationId).toBe('corr-from-caller');
    expect(response.headers['x-correlation-id']).toBe('corr-from-caller');
    expect(response.headers['x-request-id']).toBe(request.requestId);
  });

  it('opens an async context the whole downstream chain can read', () => {
    const request: any = { headers: {}, method: 'POST', originalUrl: '/api/v1/alerts/x/resolve' };
    let seen: ReturnType<typeof requestLogFields> | undefined;
    middleware.use(request, fakeResponse(), () => {
      // AuthGuard populates the principal after the scope is open.
      request.principal = { userId: 'u1', tenantId: '7', username: 'ops' };
      seen = requestLogFields();
    });
    expect(seen).toMatchObject({
      correlationId: request.correlationId,
      requestId: request.requestId,
      userId: 'u1',
      tenantId: '7',
      method: 'POST',
      route: '/api/v1/alerts/x/resolve',
    });
    // The scope closes with the request.
    expect(currentRequestContext()).toBeUndefined();
  });

  it('logs one access line per request with the correlation id, status and duration', () => {
    const request: any = { headers: {}, method: 'GET', originalUrl: '/api/v1/alerts?limit=1' };
    const response = fakeResponse();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      middleware.use(request, response, () => {
        request.principal = { userId: 'u1', tenantId: '7' };
      });
      response.statusCode = 201;
      response.finish();
      const line = JSON.parse(spy.mock.calls.at(-1)![0] as string);
      expect(line).toMatchObject({
        context: 'HTTP',
        method: 'GET',
        route: '/api/v1/alerts',
        status: 201,
        correlationId: request.correlationId,
        requestId: request.requestId,
        userId: 'u1',
        tenantId: '7',
      });
      expect(typeof line.durationMs).toBe('number');
    } finally {
      spy.mockRestore();
    }
  });

  it('tolerates a response object without an event emitter', () => {
    const request: any = { headers: {}, method: 'GET', url: '/health' };
    expect(() =>
      middleware.use(request, { setHeader: () => undefined }, () => undefined),
    ).not.toThrow();
  });
});

describe('logRoute', () => {
  it('drops the query string so lines group by route', () => {
    expect(logRoute('/api/v1/alerts?limit=10&status=open')).toBe('/api/v1/alerts');
    expect(logRoute('/api/v1/alerts')).toBe('/api/v1/alerts');
    expect(logRoute(undefined)).toBe('/');
  });
});
