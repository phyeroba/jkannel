import { callerIp } from './api-key-auth.guard';

/**
 * Regression cover for the X-Forwarded-For allowlist bypass.
 *
 * callerIp() used to return the LEFT-MOST X-Forwarded-For entry. Because nginx
 * appends to that header rather than replacing it, the left-most value is
 * attacker-controlled: presenting `X-Forwarded-For: <an allow-listed address>`
 * was enough to defeat a per-key IP allowlist and to poison every
 * gateway_request_log row. It must now read only the trustworthy value that
 * RequestContextMiddleware derived.
 */
describe('callerIp', () => {
  it('ignores a spoofed X-Forwarded-For and uses the resolved client IP', () => {
    const request = {
      headers: { 'x-forwarded-for': '10.0.0.9, 203.0.113.7' },
      clientIp: '203.0.113.7',
      ip: '172.18.0.5',
      socket: { remoteAddress: '172.18.0.5' },
    };
    // 10.0.0.9 is the forged, left-most entry — it must never be returned.
    expect(callerIp(request)).toBe('203.0.113.7');
  });

  it('does not consult the header at all when no client IP was resolved', () => {
    const request = {
      headers: { 'x-forwarded-for': '10.0.0.9' },
      ip: '198.51.100.4',
      socket: { remoteAddress: '198.51.100.4' },
    };
    expect(callerIp(request)).toBe('198.51.100.4');
  });

  it('falls back to the socket address when nothing else is available', () => {
    expect(callerIp({ headers: {}, socket: { remoteAddress: '192.0.2.10' } })).toBe('192.0.2.10');
  });

  it('returns undefined rather than guessing when the peer is unknown', () => {
    expect(callerIp({ headers: {} })).toBeUndefined();
  });
});
