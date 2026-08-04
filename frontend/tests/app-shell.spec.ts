import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set([
      'dashboard.view',
      'messages.view',
      'smsc.view',
      'routes.view',
      'configuration.view',
      'monitoring.view',
      'alerts.view',
      'reports.view',
      'users.view',
      'users.sessions',
      'system.view',
    ]),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
  logout: vi.fn(),
}));

import AppShell from '../src/layouts/AppShell.vue';

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });

const mountShell = async (fetchMock?: ReturnType<typeof vi.fn>) => {
  localStorage.removeItem('jkannel-console-theme');
  // A first visit now starts with only Operations expanded (see the nav spec).
  // These assertions are about the links themselves, so start from a stored
  // "nothing collapsed" preference and keep every group open.
  localStorage.setItem(
    'jkannel-console-nav-collapsed',
    JSON.stringify({ version: 2, collapsed: [] }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/dashboard/operations',
        component: { template: '<p>Dashboard body</p>' },
        meta: {
          title: 'Operations Dashboard',
          description: 'Overview',
          breadcrumb: ['Dashboard', 'Operations'],
        },
      },
      {
        path: '/notifications',
        component: { template: '<p>Notifications body</p>' },
        meta: { title: 'Notifications', description: '', breadcrumb: ['Notifications'] },
      },
    ],
  });
  await router.push('/dashboard/operations');
  await router.isReady();
  vi.stubGlobal('fetch', fetchMock ?? vi.fn().mockResolvedValue({ ok: true }));
  return mount(AppShell, { global: { plugins: [router] }, attachTo: document.body });
};

describe('application shell', () => {
  it('exposes navigation and skip-link landmarks with accessible labels', async () => {
    const wrapper = await mountShell();
    expect(wrapper.get('a.skip-link').attributes('href')).toBe('#workspace');
    expect(wrapper.get('aside[aria-label="Primary navigation"] nav').findAll('a')).toHaveLength(29);
    expect(wrapper.findAll('.nav-icon svg')).toHaveLength(29);
    expect(wrapper.findAll('.nav-group')).toHaveLength(4);
    // Help is reachable from the top bar as well as the Platform group.
    expect(wrapper.get('[data-testid="topbar-help"]').attributes('href')).toBe('/help');
    expect(wrapper.get('aside[aria-label="Primary navigation"]').text()).toContain('Messaging');
    expect(wrapper.get('main').attributes('tabindex')).toBe('-1');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(wrapper.get('nav[aria-label="Breadcrumb"]').text()).toContain('Operations');
  });

  it('opens global search by button and keyboard, filters results, and reports an empty state', async () => {
    const wrapper = await mountShell();
    await wrapper.get('[data-testid="global-search"]').trigger('click');
    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    const input = wrapper.get('[data-testid="global-search-input"]');
    await input.setValue('routing');
    expect(wrapper.get('.search-results').text()).toContain('Routing');
    expect(wrapper.get('.search-results').text()).not.toContain('Messages');
    await input.setValue('workspace-that-does-not-exist');
    expect(wrapper.get('.search-results').text()).toContain('No matching workspace.');
    await window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  });

  it('shows the unread badge, lists notifications, and marks them read', async () => {
    let unread = 3;
    const notifications = [
      {
        id: 'n1',
        category: 'reports',
        title: 'Daily volume report ready',
        body: '120 messages recorded yesterday.',
        read_at: null as string | null,
        created_at: '2026-07-09T05:00:00Z',
      },
      {
        id: 'n2',
        category: 'alerts',
        title: 'Queue depth normal again',
        body: 'The queue drained below the threshold.',
        read_at: '2026-07-08T10:00:00Z' as string | null,
        created_at: '2026-07-08T09:00:00Z',
      },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/notifications/unread-count')) return Promise.resolve(envelope({ unread }));
      // Opening a notification detail: GET /notifications/n1 marks it read and
      // returns the full record including its data payload.
      if (/\/notifications\/n1(\?|$)/.test(String(url)) && (!init || init.method === undefined)) {
        unread = 2;
        notifications[0].read_at = '2026-07-09T06:00:00Z';
        return Promise.resolve(
          envelope({
            ...notifications[0],
            read_at: '2026-07-09T06:00:00Z',
            data: { messages: 120, dlrs: 118, periodType: 'daily' },
          }),
        );
      }
      if (url.includes('/notifications?'))
        return Promise.resolve(
          envelope({ items: notifications, total: notifications.length, limit: 10, offset: 0 }),
        );
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const wrapper = await mountShell(fetchMock);

    await vi.waitFor(() => expect(wrapper.get('[data-testid="unread-count"]').text()).toBe('3'));

    await wrapper.get('[data-testid="notifications-bell"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="notification-n1"]').text()).toContain(
        'Daily volume report ready',
      ),
    );
    expect(wrapper.get('[data-testid="notification-n1"]').classes()).toContain('unread');

    // Clicking the notification opens its detail and marks it read (open == read).
    await wrapper.get('[data-testid="notification-n1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="notification-detail"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="notification-detail"]').text()).toContain('120');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="unread-count"]').text()).toBe('2'));
    expect(
      fetchMock.mock.calls.some((call) => /\/notifications\/n1(\?|$)/.test(String(call[0]))),
    ).toBe(true);
  });

  it('marks every notification read from the panel header', async () => {
    let unread = 2;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/notifications/unread-count')) return Promise.resolve(envelope({ unread }));
      if (url.includes('/notifications/read-all') && init?.method === 'POST') {
        unread = 0;
        return Promise.resolve(envelope({ updated: 2 }));
      }
      if (url.includes('/notifications?'))
        return Promise.resolve(envelope({ items: [], total: 0, limit: 10, offset: 0 }));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const wrapper = await mountShell(fetchMock);
    await vi.waitFor(() => expect(wrapper.get('[data-testid="unread-count"]').text()).toBe('2'));
    await wrapper.get('[data-testid="notifications-bell"]').trigger('click');
    await wrapper.get('[data-testid="mark-all-read"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="unread-count"]').exists()).toBe(false),
    );
  });
});
