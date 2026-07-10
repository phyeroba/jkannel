import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set(['reports.view', 'system.manage']),
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

function liveMock() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/reports/volume/run') && init?.method === 'POST')
      return apiResponse({ results: [] });
    if (target.includes('/reports/volume/export.'))
      return Promise.resolve(new Response('a,b', { status: 200 }));
    if (target.includes('/reports/volume')) return apiResponse(volumePage);
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
