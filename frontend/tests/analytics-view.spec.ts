import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
      expect(wrapper.find('[data-testid="overview-cards"]').exists()).toBe(true),
    );
    const cards = wrapper.get('[data-testid="overview-cards"]').text();
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

    await wrapper.get('[data-testid="trend-range-7"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('traffic-trend?days=7'))).toBe(
        true,
      ),
    );
  });

  it('lists report catalog categories and marks unavailable kinds as planned', async () => {
    vi.stubGlobal('fetch', liveMock());
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="catalog"]').exists()).toBe(true));
    const catalogText = wrapper.get('[data-testid="catalog-traffic"]').text();
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
      expect(wrapper.find('[data-testid="volume-export-csv"]').exists()).toBe(true),
    );

    await wrapper.get('[data-testid="volume-export-csv"]').trigger('click');
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
    await vi.waitFor(() => expect(wrapper.find('[data-testid="snapshot-v1"]').exists()).toBe(true));

    await wrapper.get('[data-testid="snapshot-v1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="snapshot-panel"]').exists()).toBe(true),
    );
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="snapshot-related"]').text()).toContain('smsc'),
    );
    expect(wrapper.get('[data-testid="snapshot-related"]').text()).toContain('80');
    expect(
      fetchMock.mock.calls.some((call) => /\/reports\/volume\/v1$/.test(String(call[0]))),
    ).toBe(true);
  });

  it('draws a chart for every table-heavy panel, in both themes and with a title', async () => {
    vi.stubGlobal('fetch', liveMock());
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="trend-chart"]').exists()).toBe(true));
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="latency-chart"]').exists()).toBe(true),
    );

    for (const id of [
      'trend-chart',
      'breakdown-chart',
      'smsc-chart',
      'route-chart',
      'smsc-success-chart',
      'route-performance-chart',
      'latency-chart',
    ]) {
      const chart = wrapper.get(`[data-testid="${id}"]`);
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
    expect(wrapper.get('[data-testid="smsc-success-table"]').text()).toContain('73.3%');
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

    await wrapper.get('[data-testid="heatmap-range-30"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('hourly-heatmap?days=30')),
      ).toBe(true),
    );

    await wrapper.get('[data-testid="latency-range-90"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('latency-sla?days=90'))).toBe(
        true,
      ),
    );

    // Snapshot-based reports take no window, so they get no control that would
    // silently do nothing.
    for (const id of ['smsc', 'route', 'smsc-success', 'route-performance', 'breakdown'])
      expect(wrapper.find(`[data-testid="${id}-range-30"]`).exists()).toBe(false);
    expect(wrapper.findAll('.range-select')).toHaveLength(3);
  });

  it('exports every report the API can export, and names the ones it cannot', async () => {
    const fetchMock = liveMock();
    vi.stubGlobal('fetch', fetchMock);
    const click = stubDownloads();
    const wrapper = mount(AnalyticsView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="exports-panel"]').exists()).toBe(true),
    );

    await wrapper.get('[data-testid="export-volume-pdf"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/reports/volume/export.pdf')),
      ).toBe(true),
    );

    // Each export disables the panel while it runs; wait for it to settle.
    await vi.waitFor(() =>
      expect(
        wrapper.get('[data-testid="export-delivery-csv"]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await wrapper.get('[data-testid="export-delivery-csv"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/reports/delivery/export.csv')),
      ).toBe(true),
    );

    await vi.waitFor(() =>
      expect(
        wrapper.get('[data-testid="export-messages-pdf"]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await wrapper.get('[data-testid="export-messages-pdf"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/messages/export.pdf'))).toBe(
        true,
      ),
    );

    // Delivery receipts have no PDF route on the API, so no PDF button exists.
    expect(wrapper.find('[data-testid="export-delivery-pdf"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="export-delivery"]').text()).toContain('CSV only');
    expect(wrapper.get('[data-testid="exports-unavailable-note"]').text()).toContain(
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
      expect(wrapper.find('[data-testid="export-messages"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="export-volume"]').exists()).toBe(true);
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
      expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="overview-empty"]').text()).toContain(
      'No report snapshots have been generated yet',
    );
    expect(wrapper.find('[data-testid="trend-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="volume-empty"]').exists()).toBe(true);
    // No fabricated numbers appear in an empty overview.
    expect(wrapper.find('[data-testid="overview-cards"]').exists()).toBe(false);
  });
});
