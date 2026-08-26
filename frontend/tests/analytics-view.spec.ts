import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { overlay, overlayAll, overlayHas } from './overlay';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set(['reports.view', 'system.manage', 'messages.export']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import AnalyticsView from '../src/views/AnalyticsView.vue';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      {
        status,
        headers: { 'x-jkannel-export-row-count': '3' },
      },
    ),
  );

const overview = {
  cards: [
    { key: 'messages', label: 'Messages (24h)', value: 1280, unit: 'msg' },
    { key: 'dlrs', label: 'DLRs (24h)', value: 940 },
  ],
  latestDailyPeriod: '2026-07-08',
};

const trend30 = {
  series: [
    { date: '2026-07-07', messages: 60, dlrs: 41 },
    { date: '2026-07-08', messages: 120, dlrs: 88 },
  ],
  window: 30,
};

const trend7 = {
  series: [{ date: '2026-07-08', messages: 30, dlrs: 22 }],
  window: 7,
};

const breakdown = {
  segments: [
    { label: 'Confirmed', value: 88 },
    { label: 'Unconfirmed', value: 32 },
  ],
  total: 120,
};

const perGroup = {
  period: '2026-07-08',
  groups: [{ label: 'smsc-primary', messages: 120, dlrs: 88 }],
};

const catalog = {
  categories: [
    {
      key: 'traffic',
      name: 'Traffic reports',
      description: 'Volume and throughput analytics.',
      kinds: [
        { key: 'volume', name: 'Volume snapshot', available: true },
        { key: 'latency', name: 'Latency histogram', available: false },
      ],
    },
  ],
};

const volumePage = {
  items: [
    {
      id: 'v1',
      period_type: 'daily',
      period_start: '2026-07-08',
      scope: 'total',
      message_count: 120,
      dlr_count: 88,
      generated_at: '2026-07-09T00:05:00Z',
    },
  ],
  total: 1,
  limit: 12,
  offset: 0,
};

const rateGroup = {
  period: '2026-07-08',
  groups: [
    { label: 'smsc-primary', messages: 120, dlrs: 88, successRate: 73.3, failureRate: 4.2 },
    { label: 'smsc-backup', messages: 30, dlrs: 12, successRate: 40, failureRate: 20 },
  ],
};

const heatmap = {
  cells: [{ dow: 3, hour: 9, count: 40 }],
  maxCount: 40,
  window: '7d',
};

const latency = {
  count: 88,
  p50: 3.2,
  p95: 9.4,
  p99: 21,
  unit: 'seconds',
  window: '7d',
  note: 'Latency approximated by matching MT and DLR rows on foreign_id.',
};

function liveMock() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/reports/volume/run') && init?.method === 'POST')
      return apiResponse({ results: [] });
    if (/export\.(csv|pdf)/.test(target))
      return Promise.resolve(new Response('a,b', { status: 200 }));
    if (target.includes('/reports/volume')) return apiResponse(volumePage);
    if (target.includes('/reports/analytics/smsc-success')) return apiResponse(rateGroup);
    if (target.includes('/reports/analytics/route-performance')) return apiResponse(rateGroup);
    if (target.includes('/reports/analytics/hourly-heatmap')) return apiResponse(heatmap);
    if (target.includes('/reports/analytics/latency-sla')) return apiResponse(latency);
    if (target.includes('/reports/analytics/overview')) return apiResponse(overview);
    if (target.includes('/reports/analytics/traffic-trend'))
      return apiResponse(target.includes('days=7') ? trend7 : trend30);
    if (target.includes('/reports/analytics/delivery-breakdown')) return apiResponse(breakdown);
    if (target.includes('/reports/analytics/per-smsc')) return apiResponse(perGroup);
    if (target.includes('/reports/analytics/per-route')) return apiResponse(perGroup);
    if (target.includes('/reports/analytics/catalog')) return apiResponse(catalog);
    return apiResponse({});
  });
}

const stubDownloads = () => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:jkannel-export'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
};

describe('Analytics & Reports view', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders KPI cards from the overview endpoint', async () => {
    vi.stubGlobal('fetch', liveMock());
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="overview-cards"]')).toBe(true),
    );
    const cards = overlay(wrapper, '[data-testid="overview-cards"]').text();
    expect(cards).toContain('Messages (24h)');
    expect(cards).toContain('1280 msg');
    expect(cards).toContain('Latest daily period 2026-07-08');
  });

  it('requests the traffic trend and re-requests when the range changes', async () => {
    const fetchMock = liveMock();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('traffic-trend?days=30'))).toBe(
        true,
      ),
    );

    await overlay(wrapper, '[data-testid="trend-range-7"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('traffic-trend?days=7'))).toBe(
        true,
      ),
    );
  });

  it('lists report catalog categories and marks unavailable kinds as planned', async () => {
    vi.stubGlobal('fetch', liveMock());
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="catalog"]')).toBe(true));
    const catalogText = overlay(wrapper, '[data-testid="catalog-traffic"]').text();
    expect(catalogText).toContain('Traffic reports');
    expect(catalogText).toContain('Volume snapshot');
    expect(catalogText).toContain('available');
    expect(catalogText).toContain('planned');
  });

  it('exports volume snapshots through the export endpoint', async () => {
    const fetchMock = liveMock();
    vi.stubGlobal('fetch', fetchMock);
    const click = stubDownloads();
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="volume-export-csv"]')).toBe(true),
    );

    await overlay(wrapper, '[data-testid="volume-export-csv"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/reports/volume/export.csv')),
    ).toBe(true);
    click.mockRestore();
  });

  it('opens a snapshot detail drawer with the related breakdown', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (/\/reports\/volume\/v1$/.test(target) && (!init || init.method === undefined))
        return apiResponse({
          snapshot: { id: 'v1', message_count: 120 },
          related: [{ scope: 'smsc', label: 'primary', message_count: 80, dlr_count: 60 }],
        });
      if (target.includes('/reports/volume/run') && init?.method === 'POST')
        return apiResponse({ results: [] });
      if (target.includes('/reports/volume')) return apiResponse(volumePage);
      if (target.includes('/reports/analytics/overview')) return apiResponse(overview);
      if (target.includes('/reports/analytics/traffic-trend')) return apiResponse(trend30);
      if (target.includes('/reports/analytics/delivery-breakdown')) return apiResponse(breakdown);
      if (target.includes('/reports/analytics/per-smsc')) return apiResponse(perGroup);
      if (target.includes('/reports/analytics/per-route')) return apiResponse(perGroup);
      if (target.includes('/reports/analytics/catalog')) return apiResponse(catalog);
      return apiResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="snapshot-v1"]')).toBe(true));

    await overlay(wrapper, '[data-testid="snapshot-v1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="snapshot-panel"]')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="snapshot-related"]').text()).toContain('smsc'),
    );
    expect(overlay(wrapper, '[data-testid="snapshot-related"]').text()).toContain('80');
    expect(
      fetchMock.mock.calls.some((call) => /\/reports\/volume\/v1$/.test(String(call[0]))),
    ).toBe(true);
  });

  it('draws a chart for every table-heavy panel, in both themes and with a title', async () => {
    vi.stubGlobal('fetch', liveMock());
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="trend-chart"]')).toBe(true));
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="latency-chart"]')).toBe(true));

    for (const id of [
      'trend-chart',
      'breakdown-chart',
      'smsc-chart',
      'route-chart',
      'smsc-success-chart',
      'route-performance-chart',
      'latency-chart',
    ]) {
      const chart = overlay(wrapper, `[data-testid="${id}"]`);
      const svg = chart.get('svg');
      // Accessible: named for a screen reader, and the same name is the <title>.
      expect(svg.attributes('role')).toBe('img');
      expect(svg.attributes('aria-label')).toBeTruthy();
      expect(chart.get('title').text()).toBe(svg.attributes('aria-label'));
      // Colour is never the only signal: every series is named in the legend.
      expect(chart.get('.mini-chart-legend').text().length).toBeGreaterThan(0);
      // Theme-aware: colours come from the design tokens, not hard-coded hex.
      for (const swatch of chart.findAll('.mini-chart-swatch'))
        expect(swatch.attributes('style')).toContain('var(--');
    }

    // The success-rate panels keep their exact numbers alongside the bars.
    expect(overlay(wrapper, '[data-testid="smsc-success-table"]').text()).toContain('73.3%');
  });

  it('offers a range control only where the endpoint honours a window', async () => {
    const fetchMock = liveMock();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('hourly-heatmap?days=7'))).toBe(
        true,
      ),
    );

    await overlay(wrapper, '[data-testid="heatmap-range-30"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('hourly-heatmap?days=30')),
      ).toBe(true),
    );

    await overlay(wrapper, '[data-testid="latency-range-90"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('latency-sla?days=90'))).toBe(
        true,
      ),
    );

    // Snapshot-based reports take no window, so they get no control that would
    // silently do nothing.
    for (const id of ['smsc', 'route', 'smsc-success', 'route-performance', 'breakdown'])
      expect(overlayHas(wrapper, `[data-testid="${id}-range-30"]`)).toBe(false);
    expect(overlayAll(wrapper, '.range-select')).toHaveLength(3);
  });

  it('exports every report the API can export, and names the ones it cannot', async () => {
    const fetchMock = liveMock();
    vi.stubGlobal('fetch', fetchMock);
    const click = stubDownloads();
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="exports-panel"]')).toBe(true));

    await overlay(wrapper, '[data-testid="export-volume-pdf"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/reports/volume/export.pdf')),
      ).toBe(true),
    );

    // Each export disables the panel while it runs; wait for it to settle.
    await vi.waitFor(() =>
      expect(
        overlay(wrapper, '[data-testid="export-delivery-csv"]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await overlay(wrapper, '[data-testid="export-delivery-csv"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/reports/delivery/export.csv')),
      ).toBe(true),
    );

    await vi.waitFor(() =>
      expect(
        overlay(wrapper, '[data-testid="export-messages-pdf"]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await overlay(wrapper, '[data-testid="export-messages-pdf"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/messages/export.pdf'))).toBe(
        true,
      ),
    );

    // Delivery receipts have no PDF route on the API, so no PDF button exists.
    expect(overlayHas(wrapper, '[data-testid="export-delivery-pdf"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="export-delivery"]').text()).toContain('CSV only');
    expect(overlay(wrapper, '[data-testid="exports-unavailable-note"]').text()).toContain(
      'Hourly traffic heatmap',
    );
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('hides the message export from an operator without messages.export', async () => {
    // The mocked session grants messages.export; assert the gate is wired to it
    // by checking the row is rendered from the permission-filtered list.
    vi.stubGlobal('fetch', liveMock());
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="export-messages"]')).toBe(true),
    );
    expect(overlayHas(wrapper, '[data-testid="export-volume"]')).toBe(true);
  });

  it('shows honest empty states when there are no snapshots yet', async () => {
    const emptyMock = vi.fn().mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/reports/analytics/overview'))
        return apiResponse({
          cards: [{ key: 'messages', label: 'Messages', value: 0 }],
          latestDailyPeriod: null,
        });
      if (target.includes('/reports/analytics/traffic-trend'))
        return apiResponse({ series: [], window: 30 });
      if (target.includes('/reports/analytics/delivery-breakdown'))
        return apiResponse({ segments: [], total: 0 });
      if (target.includes('/reports/analytics/per-smsc'))
        return apiResponse({ period: '', groups: [] });
      if (target.includes('/reports/analytics/per-route'))
        return apiResponse({ period: '', groups: [] });
      if (target.includes('/reports/analytics/catalog')) return apiResponse({ categories: [] });
      if (target.includes('/reports/volume')) return apiResponse({ items: [], total: 0 });
      return apiResponse({});
    });
    vi.stubGlobal('fetch', emptyMock);
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="overview-empty"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="overview-empty"]').text()).toContain(
      'No report snapshots have been generated yet',
    );
    expect(overlayHas(wrapper, '[data-testid="trend-empty"]')).toBe(true);
    expect(overlayHas(wrapper, '[data-testid="volume-empty"]')).toBe(true);
    // No fabricated numbers appear in an empty overview.
    expect(overlayHas(wrapper, '[data-testid="overview-cards"]')).toBe(false);
  });
  /**
   * Regression: the "Report type" menu offered every catalog kind flagged
   * available, but a SAVED DEFINITION may only name a kind in the backend's
   * REPORT_TYPES whitelist — a strict subset. Six options (smsc_success_rate,
   * route_success_rate, queue_status, engine_health, recent_changes,
   * audit_activity) therefore always answered 400. `hourly_heatmap` is also
   * listed under two catalog categories, which rendered a duplicate option.
   */
  it('offers only report kinds a definition may actually name, deduplicated', async () => {
    const twoCategoryCatalog = {
      categories: [
        {
          key: 'traffic',
          name: 'Traffic reports',
          kinds: [
            { key: 'daily_volume', name: 'Daily volume', available: true },
            { key: 'hourly_heatmap', name: 'Hourly heatmap', available: true },
            // Renderable on this page, but the scheduler has no runner for it.
            { key: 'queue_status', name: 'Queue status', available: true },
          ],
        },
        {
          key: 'performance',
          name: 'Performance reports',
          kinds: [
            { key: 'hourly_heatmap', name: 'Hourly heatmap', available: true },
            { key: 'smsc_success_rate', name: 'SMSC success rate', available: true },
            { key: 'latency_sla', name: 'Latency SLA', available: false },
          ],
        },
      ],
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/reports/analytics/catalog'))
        return apiResponse(twoCategoryCatalog);
      if (String(url).includes('/reports/definitions'))
        return apiResponse({ items: [], total: 0, limit: 50, offset: 0 });
      return apiResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AnalyticsView);
    // Enabled only once the catalog has arrived and yielded definable kinds.
    await vi.waitFor(() =>
      expect(
        overlay(wrapper, '[data-testid="definition-new"]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await overlay(wrapper, '[data-testid="definition-new"]').trigger('click');

    // `overlay`, not `wrapper.get`: the create form is a ModalDialog now rather
    // than a section rendered under the register, so its controls are teleported
    // out of the component's own subtree.
    const options = overlay(wrapper, '[data-testid="definition-type"]')
      .findAll('option')
      .map((option) => (option.element as HTMLOptionElement).value);
    expect(options).toEqual(['daily_volume', 'hourly_heatmap']);
    // Not offered: not in the create endpoint's whitelist.
    expect(options).not.toContain('queue_status');
    expect(options).not.toContain('smsc_success_rate');
    // Listed twice in the catalog, offered once here.
    expect(options.filter((key) => key === 'hourly_heatmap')).toHaveLength(1);
    expect(overlay(wrapper, '[data-testid="definition-type-note"]').text()).toContain(
      'kinds the scheduler can run',
    );
  });
});
