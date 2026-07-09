import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditTrailInterceptor, redactBody } from './audit-trail.interceptor';

function contextFor(request: unknown) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('AuditTrailInterceptor', () => {
  const query = jest.fn().mockResolvedValue({});
  const database: any = {
    tenantTransaction: jest.fn((_tenant: string, work: any) => work({ query })),
  };
  beforeEach(() => jest.clearAllMocks());

  it('redacts credentials and secrets from audited bodies', () => {
    expect(redactBody({ name: 'a', password: 'x', nested: { apiToken: 'y', ok: 1 } })).toEqual({
      name: 'a',
      password: '[redacted]',
      nested: { apiToken: '[redacted]', ok: 1 },
    });
  });

  it('records mutating authenticated requests with actor and correlation id', async () => {
    const interceptor = new AuditTrailInterceptor(database);
    const request = {
      method: 'POST',
      originalUrl: '/api/v1/smscs',
      body: { name: 'carrier', credentialSecretRef: 'secret://x' },
      correlationId: 'corr-1',
      principal: { tenantId: '7', userId: 'user-1' },
    };
    await lastValueFrom(interceptor.intercept(contextFor(request), { handle: () => of('ok') }));
    await new Promise(process.nextTick);
    expect(database.tenantTransaction).toHaveBeenCalledWith('7', expect.any(Function));
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO audit_log');
    expect(params[2]).toBe('http.post');
    expect(params[3]).toBe('/api/v1/smscs');
    expect(JSON.parse(params[4]).body.credentialSecretRef).toBe('[redacted]');
    expect(params[6]).toBe('corr-1');
  });

  it('skips unauthenticated and plain read requests', async () => {
    const interceptor = new AuditTrailInterceptor(database);
    await lastValueFrom(
      interceptor.intercept(contextFor({ method: 'POST', originalUrl: '/api/v1/auth/login' }), {
        handle: () => of('ok'),
      }),
    );
    await lastValueFrom(
      interceptor.intercept(
        contextFor({
          method: 'GET',
          originalUrl: '/api/v1/smscs',
          principal: { tenantId: '7', userId: 'user-1' },
        }),
        { handle: () => of('ok') },
      ),
    );
    expect(database.tenantTransaction).not.toHaveBeenCalled();
  });

  it('audits sensitive reads and failed mutations', async () => {
    const interceptor = new AuditTrailInterceptor(database);
    await lastValueFrom(
      interceptor.intercept(
        contextFor({
          method: 'GET',
          originalUrl: '/api/v1/messages/export.csv?limit=10',
          principal: { tenantId: '7', userId: 'user-1' },
        }),
        { handle: () => of('ok') },
      ),
    );
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor({
            method: 'DELETE',
            originalUrl: '/api/v1/routes/1',
            principal: { tenantId: '7', userId: 'user-1' },
          }),
          { handle: () => throwError(() => new Error('boom')) },
        ),
      ),
    ).rejects.toThrow('boom');
    await new Promise(process.nextTick);
    expect(database.tenantTransaction).toHaveBeenCalledTimes(2);
    const failure = JSON.parse(query.mock.calls[1][1][4]);
    expect(failure.outcome).toBe('failure');
  });
});
