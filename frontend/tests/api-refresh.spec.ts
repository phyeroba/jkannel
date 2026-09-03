import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console fires several requests per screen. When the 15-minute access
 * token expires they all get 401 in the same tick — and each one calling
 * `renew()` independently presents the SAME refresh token, which the server
 * correctly treats as replay and answers by revoking the family.
 *
 * That signed the operator out roughly every fifteen minutes of active use and
 * made every panel on the screen error at once. This pins the fix: however many
 * callers hit 401 together, exactly ONE refresh goes to the server.
 */
describe('token refresh under concurrency', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('sends exactly one refresh when several requests 401 together', async () => {
    localStorage.setItem('jkannel-token', 'expired-access');
    localStorage.setItem('jkannel-refresh-token', 'refresh-1');

    let refreshCalls = 0;
    let rotated = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('/auth/refresh')) {
          refreshCalls += 1;
          // The server rotates on first use and rejects a replay, exactly as
          // production does. If the guard fails, this returns 401 and the test
          // fails on the call count rather than on a vague error.
          if (rotated)
            return new Response(JSON.stringify({ success: false, message: 'replay' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          rotated = true;
          return new Response(
            JSON.stringify({ accessToken: 'fresh-access', refreshToken: 'refresh-2' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        if (!auth.includes('fresh-access'))
          return new Response(JSON.stringify({ success: false }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { apiRequest } = await import('../src/api');
    // Six panels loading at once, which is an ordinary screen here.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => apiRequest<{ ok: boolean }>('/anything')),
    );

    expect(refreshCalls).toBe(1);
    for (const r of results) expect(r.ok).toBe(true);
    expect(localStorage.getItem('jkannel-refresh-token')).toBe('refresh-2');
  });
});
