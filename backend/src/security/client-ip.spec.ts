import {
  expressTrustProxySetting,
  normalizeIp,
  resolveClientIp,
  trustedProxyConfig,
} from './client-ip';
import { RequestContextMiddleware } from '../platform/request-context.middleware';

/** Build a request the way Express presents one. */
function request(xff: string | string[] | undefined, peer = '172.18.0.3') {
  return {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: peer },
  };
}

describe('client IP derivation', () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_COUNT;
    delete process.env.TRUSTED_PROXIES;
  });

  describe('configuration', () => {
    it('defaults to exactly one trusted hop (the bundled nginx)', () => {
      expect(trustedProxyConfig({})).toEqual({ addresses: [], count: 1 });
      expect(expressTrustProxySetting({ addresses: [], count: 1 })).toBe(1);
    });
    it('reads TRUSTED_PROXY_COUNT and rejects nonsense', () => {
      expect(trustedProxyConfig({ TRUSTED_PROXY_COUNT: '0' }).count).toBe(0);
      expect(trustedProxyConfig({ TRUSTED_PROXY_COUNT: '3' }).count).toBe(3);
      expect(trustedProxyConfig({ TRUSTED_PROXY_COUNT: '-2' }).count).toBe(1);
      expect(trustedProxyConfig({ TRUSTED_PROXY_COUNT: 'lots' }).count).toBe(1);
      expect(trustedProxyConfig({ TRUSTED_PROXY_COUNT: '' }).count).toBe(1);
    });
    it('reads TRUSTED_PROXIES and hands the list to Express verbatim', () => {
      const config = trustedProxyConfig({ TRUSTED_PROXIES: '172.18.0.0/16, 10.0.0.1 ' });
      expect(config.addresses).toEqual(['172.18.0.0/16', '10.0.0.1']);
      expect(expressTrustProxySetting(config)).toEqual(['172.18.0.0/16', '10.0.0.1']);
    });
  });

  describe('normalizeIp', () => {
    it('unwraps IPv4-mapped IPv6, brackets and ports', () => {
      expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
      expect(normalizeIp('203.0.113.9:52344')).toBe('203.0.113.9');
      expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
      expect(normalizeIp('  203.0.113.9 ')).toBe('203.0.113.9');
      expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    });
  });

  describe('hop counting', () => {
    const count = (n: number) => ({ addresses: [], count: n });

    it('0 proxies: ignores X-Forwarded-For entirely', () => {
      expect(resolveClientIp(request('9.9.9.9'), count(0))).toBe('172.18.0.3');
      expect(resolveClientIp(request(undefined, '203.0.113.9'), count(0))).toBe('203.0.113.9');
    });

    it('1 proxy (default): takes the value nginx appended', () => {
      // Honest caller: nginx sets XFF to the peer it saw.
      expect(resolveClientIp(request('203.0.113.9'), count(1))).toBe('203.0.113.9');
    });

    it('1 proxy: a spoofed X-Forwarded-For is discarded', () => {
      // The attacker sends "X-Forwarded-For: 10.0.0.1" hoping to look like an
      // allowlisted host; nginx's proxy_add_x_forwarded_for APPENDS its peer, so
      // the forged value survives in FIRST position — exactly what the old
      // `raw.split(',')[0]` read. Counting from the right defeats it.
      expect(resolveClientIp(request('10.0.0.1, 203.0.113.9'), count(1))).toBe('203.0.113.9');
      // Multiple forged hops make no difference.
      expect(resolveClientIp(request('10.0.0.1, 10.0.0.2, 10.0.0.3, 203.0.113.9'), count(1))).toBe(
        '203.0.113.9',
      );
    });

    it('N proxies: skips exactly N hops', () => {
      // client -> CDN -> nginx -> app
      const chain = request('203.0.113.9, 198.51.100.4');
      expect(resolveClientIp(chain, count(2))).toBe('203.0.113.9');
      expect(resolveClientIp(chain, count(1))).toBe('198.51.100.4');
    });

    it('clamps rather than going out of range when the chain is shorter than the count', () => {
      expect(resolveClientIp(request(undefined, '203.0.113.9'), count(3))).toBe('203.0.113.9');
      expect(resolveClientIp(request('203.0.113.9'), count(9))).toBe('203.0.113.9');
    });

    it('accepts a repeated header (Node gives an array) as one chain', () => {
      expect(resolveClientIp(request(['10.0.0.1', '203.0.113.9']), count(1))).toBe('203.0.113.9');
    });

    it('returns undefined when there is nothing at all to go on', () => {
      expect(resolveClientIp({ headers: {} }, count(1))).toBeUndefined();
    });
  });

  describe('address matching (TRUSTED_PROXIES)', () => {
    const config = { addresses: ['172.18.0.0/16'], count: 1 };

    it('skips every trailing hop inside the trusted range', () => {
      expect(resolveClientIp(request('203.0.113.9, 172.18.0.7', '172.18.0.3'), config)).toBe(
        '203.0.113.9',
      );
    });

    it('is not fooled by a direct caller that forges a hop', () => {
      // Caller reaches the published :3000 directly (peer 198.51.100.50, which
      // is NOT one of our proxies) and forges an allowlisted address. Hop
      // counting would return the forgery; address matching returns the truth.
      const direct = request('10.0.0.1', '198.51.100.50');
      expect(resolveClientIp(direct, { addresses: [], count: 1 })).toBe('10.0.0.1');
      expect(resolveClientIp(direct, config)).toBe('198.51.100.50');
    });

    it('falls back to the left-most hop when the whole chain is ours', () => {
      expect(resolveClientIp(request('172.18.0.9, 172.18.0.7', '172.18.0.3'), config)).toBe(
        '172.18.0.9',
      );
    });

    it('matches an IPv4-mapped socket address against an IPv4 CIDR', () => {
      expect(resolveClientIp(request('203.0.113.9', '::ffff:172.18.0.3'), config)).toBe(
        '203.0.113.9',
      );
    });
  });

  describe('RequestContextMiddleware integration', () => {
    it('publishes the derived value as request.clientIp', () => {
      process.env.TRUSTED_PROXY_COUNT = '1';
      const middleware = new RequestContextMiddleware();
      const req = {
        ...request('10.0.0.1, 203.0.113.9'),
        headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' },
      } as Parameters<RequestContextMiddleware['use']>[0];
      const res = { setHeader: () => undefined };
      let called = false;
      middleware.use(req, res, () => {
        called = true;
      });
      expect(called).toBe(true);
      expect(req.clientIp).toBe('203.0.113.9');
      expect(req.requestId).toBeTruthy();
    });

    it('honours TRUSTED_PROXY_COUNT=0 for a directly exposed deployment', () => {
      process.env.TRUSTED_PROXY_COUNT = '0';
      const middleware = new RequestContextMiddleware();
      const req = {
        headers: { 'x-forwarded-for': '9.9.9.9' },
        socket: { remoteAddress: '198.51.100.50' },
      } as Parameters<RequestContextMiddleware['use']>[0];
      middleware.use(req, { setHeader: () => undefined }, () => undefined);
      expect(req.clientIp).toBe('198.51.100.50');
    });
  });
});
