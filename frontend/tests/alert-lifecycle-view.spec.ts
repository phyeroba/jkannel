import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overlay, overlayHas } from './overlay';

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
      { path: '/alerts', component: { template: '<p/>' } },
      { path: '/alert-response', component: { template: '<p/>' } },
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
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="lifecycle-assignee-a1"]').text()).toBe('joel');
    expect(overlay(wrapper, '[data-testid="lifecycle-notification-a1"]').text()).toContain(
      'undeliverable',
    );
    // `suppressed_until` is null on this row, so the line is ABSENT rather
    // than rendered as an em dash. It used to be drawn unconditionally, which
    // on a register where most alerts are not suppressed meant a third line
    // of nothing on every row — enough to push the rows past the height the
    // layout audit allows. A stack is as tall as the row has to say.
    expect(overlayHas(wrapper, '[data-testid="lifecycle-suppressed-a1"]')).toBe(false);
    wrapper.unmount();
  });

  // The other direction: when there IS a suppression, it must still show.
  // Dropping the em-dash line would be a regression if it dropped the real
  // value with it.
  it('shows the suppression deadline when the alert is actually suppressed', async () => {
    stubApi((url) =>
      url.includes('/alerts?')
        ? apiResponse({
            items: [{ ...ALERT_ROW, suppressed_until: '2026-08-05T09:00:00Z' }],
            total: 1,
          })
        : undefined,
    );
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-suppressed-a1"]')).toBe(true),
    );
    // Rendered short ("5 Aug, 12:00"), with the exact instant kept in `title`.
    const cell = overlay(wrapper, '[data-testid="lifecycle-suppressed-a1"]');
    expect(cell.text()).toContain('Aug');
    expect(cell.attributes('title')).toBe('2026-08-05T09:00:00Z');
    wrapper.unmount();
  });

  it('opens an alert and splits the thread into history and operator comments', async () => {
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-detail-assignee"]')).toBe(true),
    );
    // Who has it, and since when. The age qualifies the name rather than
    // costing a second field; the exact instant is in the cell's `title`.
    const assignee = overlay(wrapper, '[data-testid="lifecycle-detail-assignee"]');
    expect(assignee.text()).toContain('joel');
    expect(assignee.text()).toMatch(/\d+[smhd] ago/);
    expect(overlay(wrapper, '[data-testid="lifecycle-detail-notification"]').text()).toContain(
      'undeliverable',
    );
    // notification_state=undeliverable means the alert reached nobody; say so.
    expect(overlayHas(wrapper, '[data-testid="lifecycle-undeliverable-banner"]')).toBe(true);
    // The thread is now the design's Timeline. A transition is still rendered
    // as platform history rather than as somebody's note, and a comment still
    // names its author — the distinction the flat list used to make with a
    // badge is now made by the step label.
    const thread = overlay(wrapper, '[data-testid="lifecycle-thread"]').text();
    expect(thread).toContain('State change');
    expect(thread).toContain('Comment by amina');
    wrapper.unmount();
  });

  it('offers only the transitions legal from the current state', async () => {
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-acknowledge"]')).toBe(true),
    );
    // open -> acknowledge/resolve/suppress/close are legal; reopen is not.
    expect(
      overlay(wrapper, '[data-testid="lifecycle-acknowledge"]').attributes('disabled'),
    ).toBeUndefined();
    expect(
      overlay(wrapper, '[data-testid="lifecycle-resolve"]').attributes('disabled'),
    ).toBeUndefined();
    expect(
      overlay(wrapper, '[data-testid="lifecycle-close"]').attributes('disabled'),
    ).toBeUndefined();
    const reopen = overlay(wrapper, '[data-testid="lifecycle-reopen"]');
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
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-resolve"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-reason"]').setValue(
      'Carrier restored the bind',
    );
    await overlay(wrapper, '[data-testid="lifecycle-resolve"]').trigger('click');

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) =>
        String(entry[0]).includes('/alerts/a1/resolve'),
      );
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        note: 'Carrier restored the bind',
      });
    });
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="lifecycle-action-notice"]').text()).toContain(
        'resolved',
      ),
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
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-resolve"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-resolve"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="lifecycle-action-error"]').text()).toBe(
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
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="lifecycle-readonly"]').text()).toContain(
      'alerts.acknowledge',
    );
    await overlay(wrapper, '[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-suppress-denied"]')).toBe(true),
    );
    expect(overlayHas(wrapper, '[data-testid="lifecycle-actions"]')).toBe(false);
    expect(overlayHas(wrapper, '[data-testid="lifecycle-suppress"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="lifecycle-suppress-denied"]').text()).toContain(
      'system.manage',
    );
    wrapper.unmount();
  });

  it('opens straight onto the alert named in ?alert=', async () => {
    stubApi();
    const wrapper = await mountView('/alert-lifecycle?alert=a1');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-detail-status"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="lifecycle-detail-status"]').text()).toContain('open');
    wrapper.unmount();
  });

  it('adds a comment to the thread', async () => {
    const fetchMock = stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-open-a1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-comment-input"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-comment-input"]').setValue(
      'Paging the carrier.',
    );
    await overlay(wrapper, '[data-testid="lifecycle-comment-submit"]').trigger('click');
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

/**
 * The 2026-10-06 rebuild: the five bands of CONSOLE_DESIGN_SPEC §1. The
 * screen had the right content and the wrong shape — it opened on a
 * seven-control toolbar and a status dropdown with no counts.
 */
const TALLY = {
  total: 312,
  byStatus: { open: 42, acknowledged: 9, suppressed: 2, resolved: 200, closed: 59 },
  bySeverity: { critical: 11, warning: 140, info: 161 },
  openBySeverity: { critical: 3, warning: 39 },
  unacknowledged: 33,
  oldestOpenedAt: '2026-08-04T09:00:00Z',
  resolved30d: 88,
  medianResolveSeconds: 4920,
};
const withTally = (extra: (url: string) => unknown = () => undefined) =>
  stubApi((url) => (url.includes('/alerts/summary') ? apiResponse(TALLY) : extra(url)));

describe('Alert lifecycle view — the five bands', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    permissions.value = new Set(['alerts.view', 'alerts.acknowledge', 'system.manage']);
  });

  it('counts the whole table on the tabs, not the loaded page', async () => {
    withTally();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="lifecycle-tab-open"]').text()).toContain('42'),
    );
    // One row is loaded; the tab must not say 1.
    expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true);
    expect(overlay(wrapper, '[data-testid="lifecycle-tab-all"]').text()).toContain('312');
    expect(overlay(wrapper, '[data-testid="lifecycle-stat-open"]').text()).toBe('42');
    expect(overlay(wrapper, '[data-testid="lifecycle-stat-median"]').text()).toBe('1h 22m');
    wrapper.unmount();
  });

  it('leads with the unclaimed verdict and the age of the oldest', async () => {
    withTally();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-status-line"]')).toBe(true),
    );
    const line = overlay(wrapper, '[data-testid="lifecycle-status-line"]');
    await vi.waitFor(() => expect(line.text()).toContain('Unclaimed'));
    expect(line.text()).toContain('33 alert(s) have been raised and nobody has taken them');
    expect(line.text()).toMatch(/oldest opened \d+[smhd] ago/i);
    wrapper.unmount();
  });

  it('renders no strip at all when the tally cannot be read', async () => {
    // The default stub answers /alerts/summary with something that is not a
    // tally. Zeros would report an empty system, so the strip is absent and
    // the counts come off the tabs.
    stubApi();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    expect(overlayHas(wrapper, '[data-testid="lifecycle-strip"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="lifecycle-tab-open"]').text().trim()).toBe('Open');
    expect(overlay(wrapper, '[data-testid="lifecycle-status-line"]').text()).toContain(
      'this page only',
    );
    wrapper.unmount();
  });

  it('opens on Open and sends the tab to the API as the status filter', async () => {
    const fetchMock = withTally();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-row-a1"]')).toBe(true),
    );
    const urls = () =>
      fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/alerts?'));
    expect(urls()[0]).toContain('filter.status=open');

    await overlay(wrapper, '[data-testid="lifecycle-tab-resolved"]').trigger('click');
    await vi.waitFor(() =>
      expect(urls().some((url) => url.includes('filter.status=resolved'))).toBe(true),
    );
    // "All" must clear the filter rather than sending an empty one.
    await overlay(wrapper, '[data-testid="lifecycle-tab-all"]').trigger('click');
    await vi.waitFor(() => expect(urls().at(-1)).not.toContain('filter.status'));
    wrapper.unmount();
  });

  it('filters severity from a segmented control rather than a dropdown', async () => {
    const fetchMock = withTally();
    const wrapper = await mountView();
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="lifecycle-severity-critical"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="lifecycle-severity-critical"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('filter.severity=critical')),
      ).toBe(true),
    );
    wrapper.unmount();
  });

  it('puts the actions above the record, not below it', async () => {
    withTally();
    const wrapper = await mountView('/alert-lifecycle?alert=a1');
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="lifecycle-actions"]')).toBe(true));
    const sheet = overlay(wrapper, '[data-testid="lifecycle-detail-panel"]').html();
    // The control an operator came for comes before the reference they check
    // afterwards. Position in the markup is the only way to assert order.
    expect(sheet.indexOf('lifecycle-actions')).toBeLessThan(sheet.indexOf('panel-fields'));
    wrapper.unmount();
  });
});
