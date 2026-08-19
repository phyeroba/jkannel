import { beforeEach, describe, expect, it, vi } from 'vitest';

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

describe('session route guard', () => {
  beforeEach(() => {
    vi.resetModules();
    // The later tests seed an access token, and resetModules does not touch
    // localStorage. Without this, "unauthenticated" is only true because this
    // test happens to run first — an ordering dependency, not a fact.
    localStorage.clear();
  });

  // 30s, not 15s. Importing the router pulls in the whole lazy route table, and
  // under `fullyParallel` on a loaded machine that occasionally crossed 15s and
  // failed a test that passes 3/3 in isolation. A flaky test costs more than a
  // slow one: it teaches people to re-run the suite instead of reading it.
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
  }, 30_000);

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
