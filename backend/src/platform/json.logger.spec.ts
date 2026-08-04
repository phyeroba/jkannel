import { JsonLogger, sharedJsonLogger } from './json.logger';
import { sharedLogBuffer } from './log-buffer';
import { runWithRequestContext } from './request-context.store';

function captureLine(work: () => void): Record<string, unknown> {
  const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    work();
    return JSON.parse(spy.mock.calls.at(-1)![0] as string);
  } finally {
    spy.mockRestore();
  }
}

describe('JsonLogger', () => {
  beforeEach(() => sharedLogBuffer().clear());

  it('stamps every line inside a request with the correlation and request ids', () => {
    const logger = new JsonLogger();
    const line = captureLine(() =>
      runWithRequestContext(
        {
          requestId: 'req-1',
          correlationId: 'corr-1',
          method: 'POST',
          route: '/api/v1/alerts',
          principalCarrier: { principal: { userId: 'u1', tenantId: '7', username: 'ops' } },
        },
        () => logger.log('submitting', 'MessagesService'),
      ),
    );
    expect(line).toMatchObject({
      level: 'info',
      message: 'submitting',
      context: 'MessagesService',
      correlationId: 'corr-1',
      requestId: 'req-1',
      userId: 'u1',
      tenantId: '7',
      route: '/api/v1/alerts',
      method: 'POST',
    });
  });

  it('resolves the principal at log time, not at scope entry', () => {
    const logger = new JsonLogger();
    const carrier: { principal?: { userId?: string } } = {};
    const line = captureLine(() =>
      runWithRequestContext({ correlationId: 'corr-2', principalCarrier: carrier }, () => {
        // AuthGuard runs after the middleware opened the scope.
        carrier.principal = { userId: 'late-user' };
        logger.log('after auth');
      }),
    );
    expect(line.userId).toBe('late-user');
  });

  it('logs cleanly outside any request (schedulers, boot)', () => {
    const logger = new JsonLogger();
    const line = captureLine(() => logger.log('poller tick'));
    expect(line.correlationId).toBeUndefined();
    expect(line.message).toBe('poller tick');
  });

  it('emits an http access line with route, status and duration', () => {
    const logger = new JsonLogger();
    const line = captureLine(() =>
      logger.http({
        method: 'GET',
        route: '/api/v1/alerts',
        status: 200,
        durationMs: 12,
        correlationId: 'corr-3',
        requestId: 'req-3',
        tenantId: '1',
      }),
    );
    expect(line).toMatchObject({
      context: 'HTTP',
      method: 'GET',
      route: '/api/v1/alerts',
      status: 200,
      durationMs: 12,
      correlationId: 'corr-3',
      level: 'info',
    });
  });

  it('raises the level for 4xx and 5xx responses', () => {
    const logger = new JsonLogger();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warned = captureLine(() => logger.http({ status: 404, route: '/x' }));
    expect(warned.level).toBe('warn');
    logger.http({ status: 503, route: '/x' });
    expect(JSON.parse(spy.mock.calls.at(-1)![0] as string).level).toBe('error');
    spy.mockRestore();
  });

  it('mirrors every line into the queryable ring buffer', () => {
    const logger = new JsonLogger();
    captureLine(() =>
      runWithRequestContext({ correlationId: 'corr-4' }, () => logger.log('buffered')),
    );
    const found = sharedLogBuffer().query({ correlationId: 'corr-4' });
    expect(found.items).toHaveLength(1);
    expect(found.items[0].message).toBe('buffered');
  });

  it('exposes one shared logger for code outside the injector', () => {
    expect(sharedJsonLogger()).toBe(sharedJsonLogger());
  });
});
