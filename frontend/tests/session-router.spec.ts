import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

describe('session route guard', () => {
  /**
   * Pays the module-graph cost once, outside any timed assertion.
   *
   * Importing `../src/router` pulls the whole lazy route table through Vite's
   * transform pipeline — about nine seconds on the first import in a worker,
   * and under `fullyParallel` on a loaded machine it had crossed a 30s test
   * timeout while passing 3/3 in isolation. Raising the number again would have
   * been chasing the symptom: the transform is not what these tests measure.
   *
   * Every later import is cheap (~400ms) because the transform cache survives
   * `vi.resetModules()`, which resets the module REGISTRY, not the cache. So
   * each test still gets a genuinely fresh router; it just no longer has the
   * one-off compile charged against its own budget.
   */
  beforeAll(async () => {
    await import('../src/router');
  }, 120_000);

  beforeEach(() => {
    vi.resetModules();
    // The later tests seed an access token, and resetModules does not touch
    // localStorage. Without this, "unauthenticated" is only true because this
    // test happens to run first — an ordering dependency, not a fact.
    localStorage.clear();
  });

  it('redirects an unauthenticated protected route to login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), {
          status: 401,
        }),
      ),
    );
    const { default: router } = await import('../src/router');
    await router.push('/messages');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('permits an authorized route and rejects a missing permission', async () => {
    localStorage.setItem('jkannel-access-token', 'access');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        ok({
          tenantId: 'tenant-1',
          userId: 'user-1',
          sessionId: 'session-1',
          username: 'operator',
          roles: ['operator'],
          permissions: ['messages.view'],
        }),
      ),
    );
    const { default: router } = await import('../src/router');
    await router.push('/messages');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('messages');
    await router.push('/users');
    expect(router.currentRoute.value.name).toBe('forbidden');
  });

  it('redirects an authenticated user away from login', async () => {
    localStorage.setItem('jkannel-access-token', 'access');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        ok({
          tenantId: 'tenant-1',
          userId: 'user-1',
          sessionId: 'session-1',
          username: 'operator',
          roles: ['operator'],
          permissions: ['dashboard.view'],
        }),
      ),
    );
    const { default: router } = await import('../src/router');
    await router.push('/login');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('operations');
  });
});
