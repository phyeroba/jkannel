import { beforeEach, describe, expect, it, vi } from 'vitest';

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

describe('session route guard', () => {
  beforeEach(() => vi.resetModules());

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
  }, 15_000);

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
