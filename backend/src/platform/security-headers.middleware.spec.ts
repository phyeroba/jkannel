import { SecurityHeadersMiddleware } from './security-headers.middleware';

describe('SecurityHeadersMiddleware', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });
  it('sets defensive API headers and continues the chain', () => {
    process.env.NODE_ENV = 'test';
    const headers: Record<string, string> = {};
    const next = jest.fn();
    new SecurityHeadersMiddleware().use(
      {},
      {
        setHeader: (name, value) => {
          headers[name] = value;
        },
      },
      next,
    );
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('enables HSTS only for production TLS termination', () => {
    process.env.NODE_ENV = 'production';
    const headers: Record<string, string> = {};
    new SecurityHeadersMiddleware().use(
      {},
      {
        setHeader: (name, value) => {
          headers[name] = value;
        },
      },
      () => undefined,
    );
    expect(headers['strict-transport-security']).toContain('max-age=31536000');
  });
});
