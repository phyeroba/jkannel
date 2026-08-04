import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const permissions = ref(new Set(['alerts.view', 'alerts.acknowledge', 'system.manage']));

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    get permissions() {
      return permissions.value;
    },
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import AlertLifecycleView from '../src/views/AlertLifecycleView.vue';

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
const conflict = (message: string) =>
  Promise.resolve(new Response(JSON.stringify({ success: false, message }), { status: 409 }));

/** The alerts index selects `a.*`, so lifecycle columns arrive snake_case. */
const ALERT_ROW = {
  id: 'a1',
  severity: 'critical',
  summary: 'SMPP bind down',
  status: 'open',
  assigned_to_username: 'joel',
  suppressed_until: null,
  notification_state: 'undeliverable',
  opened_at: '2026-08-04T09:00:00Z',
  rule_name: 'bind-health',
};

/** GET /alerts/:id/lifecycle publishes the same fields camelCase. */
const LIFECYCLE = {
  id: 'a1',
  status: 'open',
  severity: 'critical',
  summary: 'SMPP bind down',
  assignedTo: 'u2',
  assignedToUsername: 'joel',
  assignedAt: '2026-08-04T09:02:00Z',
  suppressedUntil: null,
  suppressedReason: null,
  notificationState: 'undeliverable',
  notificationDetail: {},
  openedAt: '2026-08-04T09:00:00Z',
  resolvedAt: null,
  closedAt: null,
  reopenCount: 1,
  escalatedAt: '2026-08-04T09:05:00Z',
  previousSeverity: 'warning',
  dedupCount: 4,
  correlationGroup: 'smpp-primary',
  details: {},
};

const THREAD = [
  {
    id: 'c1',
    authorUsername: null,
    body: 'Acknowledged',
    kind: 'transition',
    createdAt: '2026-08-04T09:03:00Z',
  },
  {
    id: 'c2',
    authorUsername: 'amina',
    body: 'Carrier confirms an outage on their side.',
    kind: 'comment',
    createdAt: '2026-08-04T09:10:00Z',
  },
];

const stubApi = (overrides: (url: string, init?: RequestInit) => unknown = () => undefined) => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const override = overrides(url, init);
    if (override !== undefined) return override;
    if (url.includes('/alerts/a1/lifecycle')) return apiResponse(LIFECYCLE);
    if (url.includes('/alerts/a1/comments')) return apiResponse(THREAD);
    if (url.includes('/alerts?')) return apiResponse({ items: [ALERT_ROW], total: 1 });
    if (url.includes('/users')) return apiResponse({ items: [{ username: 'joel' }], total: 1 });
    return apiResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const mountView = async (path = '/alert-lifecycle') => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/alert-lifecycle',
        name: 'alert-lifecycle',
        component: AlertLifecycleView,
        meta: { title: 'Alert Lifecycle' },
      },
    ],
  });
  await router.push(path);
  await router.isReady();
  return mount(AlertLifecycleView, { global: { plugins: [router] } });
};

describe('Alert lifecycle view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    permissions.value = new Set(['alerts.view', 'alerts.acknowledge', 'system.manage']);
  });

  it('lists the lifecycle columns the alerts index returns', async () => {
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="lifecycle-assignee-a1"]').text()).toBe('joel');
    expect(wrapper.get('[data-testid="lifecycle-suppressed-a1"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="lifecycle-notification-a1"]').text()).toContain(
      'undeliverable',
    );
    wrapper.unmount();
  });

  it('opens an alert and splits the thread into history and operator comments', async () => {
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-detail-assignee"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="lifecycle-detail-assignee"]').text()).toBe('joel');
    expect(wrapper.get('[data-testid="lifecycle-detail-notification"]').text()).toContain(
      'undeliverable',
    );
    // notification_state=undeliverable means the alert reached nobody; say so.
    expect(wrapper.find('[data-testid="lifecycle-undeliverable-banner"]').exists()).toBe(true);
    // A transition entry is rendered as history, not as somebody's comment.
    expect(wrapper.get('[data-testid="lifecycle-thread-transition-0"]').text()).toContain(
      'history',
    );
    expect(wrapper.get('[data-testid="lifecycle-thread-comment-1"]').text()).toContain('amina');
    wrapper.unmount();
  });

  it('offers only the transitions legal from the current state', async () => {
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-acknowledge"]').exists()).toBe(true),
    );
    // open -> acknowledge/resolve/suppress/close are legal; reopen is not.
    expect(
      wrapper.get('[data-testid="lifecycle-acknowledge"]').attributes('disabled'),
    ).toBeUndefined();
    expect(wrapper.get('[data-testid="lifecycle-resolve"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="lifecycle-close"]').attributes('disabled')).toBeUndefined();
    const reopen = wrapper.get('[data-testid="lifecycle-reopen"]');
    expect(reopen.attributes('disabled')).toBeDefined();
    expect(reopen.attributes('title')).toContain('Cannot reopen an alert that is open');
    wrapper.unmount();
  });

  it('resolves with a note and reports the new state', async () => {
    const fetchMock = stubApi((url, init) =>
      url.includes('/alerts/a1/resolve') && init?.method === 'POST'
        ? apiResponse({ ...LIFECYCLE, status: 'resolved', resolvedAt: '2026-08-04T10:00:00Z' })
        : undefined,
    );
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-resolve"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-reason"]').setValue('Carrier restored the bind');
    await wrapper.get('[data-testid="lifecycle-resolve"]').trigger('click');

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) =>
        String(entry[0]).includes('/alerts/a1/resolve'),
      );
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        note: 'Carrier restored the bind',
      });
    });
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="lifecycle-action-notice"]').text()).toContain('resolved'),
    );
    wrapper.unmount();
  });

  it('surfaces an illegal-transition 409 with the offending state named', async () => {
    stubApi((url) =>
      url.includes('/alerts/a1/resolve')
        ? conflict(
            'Cannot resolve an alert that is closed (allowed from: open, acknowledged, suppressed)',
          )
        : undefined,
    );
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-resolve"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-resolve"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="lifecycle-action-error"]').text()).toBe(
        'Cannot resolve an alert that is closed (allowed from: open, acknowledged, suppressed)',
      ),
    );
    wrapper.unmount();
  });

  it('gates suppression on system.manage and operator actions on alerts.acknowledge', async () => {
    permissions.value = new Set(['alerts.view']);
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="lifecycle-readonly"]').text()).toContain(
      'alerts.acknowledge',
    );
    await wrapper.get('[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-suppress-denied"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="lifecycle-actions"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lifecycle-suppress"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="lifecycle-suppress-denied"]').text()).toContain(
      'system.manage',
    );
    wrapper.unmount();
  });

  it('opens straight onto the alert named in ?alert=', async () => {
    stubApi();
    const wrapper = await mountView('/alert-lifecycle?alert=a1');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-detail-status"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="lifecycle-detail-status"]').text()).toContain('open');
    wrapper.unmount();
  });

  it('adds a comment to the thread', async () => {
    const fetchMock = stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-row-a1"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="lifecycle-comment-input"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="lifecycle-comment-input"]').setValue('Paging the carrier.');
    await wrapper.get('[data-testid="lifecycle-comment-submit"]').trigger('click');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (entry) =>
          String(entry[0]).includes('/alerts/a1/comments') &&
          (entry[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        body: 'Paging the carrier.',
      });
    });
    wrapper.unmount();
  });
});
