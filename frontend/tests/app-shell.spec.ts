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
    // 32 before Phase 2.3–2.5 added Carriers and SMPP Sessions to Connectivity;
    // 34 before Phase 3.2–3.3 added Live Traffic and DLR Performance to Traffic;
    // 36 before Phase 4.2–4.4 added Message Trace, SMPP Errors and Events to
    // Diagnostics; 39 before Phase 5.2–5.5 added Failover and Route Simulator to
    // Routing and Test Tools to Diagnostics.
    expect(wrapper.get('aside[aria-label="Primary navigation"] nav').findAll('a')).toHaveLength(42);
    expect(wrapper.findAll('.nav-icon svg')).toHaveLength(42);
    // Six specification sections plus the three JKANNEL adds (PLAN.md §1).
    expect(wrapper.findAll('.nav-group')).toHaveLength(9);
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
    // The estate query is debounced, so the immediate state is 'searching' —
    // reporting 'nothing matched' before the search has run would be a lie.
    expect(wrapper.get('.search-results').text()).toContain('Searching the estate…');
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

/**
 * Both of these chips previously asserted something they had no source for. The
 * environment read the literal string "Development" wherever it ran — so the
 * production deployment announced itself as Development — and the state chip
 * reported whether OUR OWN API answered, which says nothing about whether the
 * engine figures on screen are current.
 */
describe('application shell — deployment and telemetry indicators', () => {
  const systemInfo = (overrides: Record<string, unknown> = {}) =>
    envelope({
      environmentLabel: 'Production',
      environmentTone: 'critical',
      environmentDeclared: true,
      version: '0.1.0',
      build: 'abc1234',
      gatewayTimezone: 'Africa/Kampala',
      telemetry: {
        state: 'live',
        ageSeconds: 8,
        detail: 'Engine observed 8s ago.',
        pollingSuppressed: false,
        cause: null,
      },
      ...overrides,
    });

  const shellWith = async (info: Response) => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/system/info')) return info.clone();
      if (url.includes('/system/telemetry')) return envelope({ state: 'live', ageSeconds: 8 });
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    });
    const wrapper = await mountShell(fetchMock as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    return wrapper;
  };

  it('shows the real deployment designation, not a hard-coded one', async () => {
    const wrapper = await shellWith(systemInfo());
    const chip = wrapper.get('[data-testid="environment-chip"]');
    expect(chip.text()).toContain('Production');
    // Tone is driven by the backend so production cannot look as safe as a laptop.
    expect(chip.classes()).toContain('tone-critical');
  });

  it('marks an inferred designation as inferred rather than stating it as fact', async () => {
    // NODE_ENV cannot tell a DR site from production; presenting the guess as
    // certainty is the mistake this indicator exists to prevent.
    const wrapper = await shellWith(systemInfo({ environmentDeclared: false }));
    expect(wrapper.get('[data-testid="environment-chip"]').text()).toContain('?');
    expect(wrapper.get('[data-testid="environment-chip"] .sr-only').text()).toContain('inferred');
  });

  it('renders nothing at all before the first successful read, rather than guessing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('unreachable');
    });
    const wrapper = await mountShell(fetchMock as never);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="environment-chip"]').exists()).toBe(false);
  });

  it('reports telemetry freshness in words as well as colour', async () => {
    // §17.1: health must never be encoded by colour alone.
    const wrapper = await shellWith(systemInfo());
    const indicator = wrapper.get('[data-testid="telemetry-indicator"]');
    expect(indicator.text()).toContain('Live');
    expect(indicator.get('.status-dot').classes()).toContain('good');
  });

  it('says "Suppressed", not "Disconnected", when JKANNEL stopped polling', async () => {
    // The distinction is the whole point: a suppressed poll and a dead engine
    // look identical from a timestamp but have completely different fixes.
    const wrapper = await shellWith(
      systemInfo({
        telemetry: {
          state: 'disconnected',
          ageSeconds: 240,
          detail: 'Check KAMEX_STATUS_PASSWORD.',
          pollingSuppressed: true,
          cause: 'credentials',
        },
      }),
    );
    const indicator = wrapper.get('[data-testid="telemetry-indicator"]');
    expect(indicator.text()).toContain('Suppressed');
    expect(indicator.attributes('title')).toContain('KAMEX_STATUS_PASSWORD');
  });
});

/**
 * §2.1 asks for search across "carrier, SMSC, session, message ID and MSISDN
 * where permitted". The console's search filtered navigation labels — useful
 * for finding a screen, no help when an operator has a message id from a
 * support ticket.
 */
describe('application shell — estate search', () => {
  const searchResponse = (body: Record<string, unknown>) =>
    new Response(JSON.stringify({ success: true, data: body }), { status: 200 });

  const shellSearching = async (body: Record<string, unknown>) => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/search?')) return searchResponse(body);
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    });
    const wrapper = await mountShell(fetchMock as never);
    await wrapper.get('[data-testid="global-search"]').trigger('click');
    await wrapper.get('[data-testid="global-search-input"]').setValue('mtn');
    // Clear the 250ms debounce, then let the request settle.
    await new Promise((resolve) => setTimeout(resolve, 320));
    await wrapper.vm.$nextTick();
    return wrapper;
  };

  it('lists estate objects beside the workspace matches', async () => {
    const wrapper = await shellSearching({
      hits: [
        {
          kind: 'smsc',
          id: 'mtn-p1',
          title: 'MTN Primary',
          subtitle: 'SMSC · smpp · active',
          to: '/smsc?focus=mtn-p1',
        },
      ],
      skipped: [],
    });
    const hits = wrapper.findAll('[data-testid="estate-hit"]');
    expect(hits).toHaveLength(1);
    expect(hits[0].text()).toContain('MTN Primary');
    expect(hits[0].attributes('href')).toContain('focus=mtn-p1');
  });

  it('says which kinds were not searched, so a partial answer is not read as "does not exist"', async () => {
    const wrapper = await shellSearching({
      hits: [],
      skipped: [{ kind: 'message' }, { kind: 'route' }],
    });
    const note = wrapper.get('[data-testid="search-skipped"]').text();
    expect(note).toContain('message');
    expect(note).toContain('route');
  });
});
