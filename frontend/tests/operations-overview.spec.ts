import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import OperationsOverview from '../src/views/OperationsOverview.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

async function mountOverview(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: OperationsOverview },
      { path: '/alerts', component: { template: '<p>Alerts</p>' } },
      { path: '/copilot', component: { template: '<p>Copilot</p>' } },
    ],
  });
  await router.push('/');
  await router.isReady();
  return mount(OperationsOverview, { global: { plugins: [router] } });
}

function liveFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/queues')) return envelope({ queued: 4, source: 'kamex-sqlbox' });
    if (url.includes('/monitoring'))
      return envelope({
        items: [],
        identity: { instanceId: 'engine-1', family: 'Kamex', version: '1.8.3' },
        health: { engine: 'running', transport: 'connected', observedAt: 'now' },
      });
    if (url.includes('/reports/volume'))
      return envelope({
        items: [
          {
            id: 'v2',
            period_type: 'daily',
            period_start: '2026-07-08',
            message_count: 120,
            dlr_count: 88,
            scope: 'total',
          },
          {
            id: 'v1',
            period_type: 'daily',
            period_start: '2026-07-07',
            message_count: 60,
            dlr_count: 41,
            scope: 'total',
          },
        ],
        total: 2,
        limit: 8,
        offset: 0,
      });
    if (url.includes('/alerts'))
      return envelope({
        items: [
          {
            id: 'a1',
            severity: 'warning',
            summary: 'Queue depth above threshold',
            status: 'open',
            opened_at: '2026-07-09T04:00:00Z',
          },
        ],
        total: 7,
        limit: 5,
        offset: 0,
      });
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

describe('operations overview remote state', () => {
  it('renders live metrics, engine health, volume trend, and recent alerts from the API', async () => {
    const fetchMock = liveFetchMock();
    const wrapper = await mountOverview(fetchMock);
    expect(wrapper.text()).toContain('checking');

    await vi.waitFor(() => expect(wrapper.text()).toContain('healthy'));
    expect(wrapper.text()).toContain('Kamex 1.8.3');
    expect(wrapper.text()).toContain('running');
    expect(wrapper.text()).toContain('120');
    expect(wrapper.text()).toContain('Queue depth above threshold');
    // The CSS bar chart was replaced by the design system's Traffic line chart,
    // which is what its DashboardScreen leads with. Same source (the daily
    // volume report), same question, the shape the package specifies.
    expect(wrapper.find('[data-testid="dashboard-traffic-chart"]').exists()).toBe(true);
    // The query string carries the daily/total filters and page bounds.
    const volumeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/reports/volume'),
    );
    expect(volumeCall?.[0]).toContain('filter.periodType=daily');
    expect(volumeCall?.[0]).toContain('filter.scope=total');
    expect(volumeCall?.[0]).toContain('limit=8');

    await wrapper.get('[data-testid="refresh-dashboard"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((call) => String(call[0]).includes('/queues')).length,
      ).toBe(2),
    );
  });

  it('renders honest unavailable and unknown states when every source fails', async () => {
    const wrapper = await mountOverview(vi.fn().mockRejectedValue(new Error('network details')));
    await vi.waitFor(() => expect(wrapper.text()).toContain('unavailable'));
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="alerts-unavailable"]').exists()).toBe(true),
    );
    // The Traffic panel states the outage in words rather than rendering an axis.
    expect(wrapper.text()).toContain('Volume report data is unavailable.');
    expect(wrapper.text()).toContain('unknown');
    expect(wrapper.text()).not.toContain('Healthy');
    expect(wrapper.text()).not.toContain('Online');
    expect(wrapper.text()).not.toContain('network details');
  });

  /**
   * The exact body the deployed API returns for GET /queues. The tile used to
   * look for a top-level `queued` and a string `source`, neither of which this
   * payload has, so a perfectly healthy SQLBox reported "store not observable".
   * Every other test used the older flat shape, which is why nothing caught it.
   */
  it('reads the live /queues envelope: summary.queued and source.status', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/queues'))
        return envelope({
          items: [],
          nextCursor: null,
          total: 0,
          summary: { queued: 0, oldestEpoch: null },
          source: { status: 'available', type: 'kamex-sqlbox' },
        });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const wrapper = await mountOverview(fetchMock);
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="health-list"]').text()).toContain(
        'PostgreSQL SQLBox reachable',
      ),
    );
    const health = wrapper.get('[data-testid="health-list"]').text();
    expect(health).not.toContain('store not observable');
    expect(health).toContain('available');
    // Zero queued is a number, not "unavailable".
    expect(wrapper.text()).toContain('Messages waiting in SQLBox');
    expect(wrapper.text()).not.toContain('SQLBox queue not observable');
  });

  it('reports a non-zero live queue depth from summary.queued', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/queues'))
        return envelope({
          items: [{ id: '1' }],
          nextCursor: null,
          total: 1,
          summary: { queued: 42, oldestEpoch: 1754300000 },
          source: { status: 'available', type: 'kamex-sqlbox' },
        });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const wrapper = await mountOverview(fetchMock);
    await vi.waitFor(() => expect(wrapper.text()).toContain('42'));
  });

  it('still reports the store unavailable when source.status says so', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/queues'))
        return envelope({
          items: [],
          nextCursor: null,
          summary: null,
          source: { status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE', message: 'no pool' },
        });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const wrapper = await mountOverview(fetchMock);
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="health-list"]').text()).toContain('store not observable'),
    );
    expect(wrapper.text()).toContain('SQLBox queue not observable');
    expect(wrapper.text()).not.toContain('no pool');
  });

  it('never fabricates health rows for unobserved dependencies', async () => {
    const wrapper = await mountOverview(liveFetchMock());
    await vi.waitFor(() => expect(wrapper.text()).toContain('healthy'));
    const health = wrapper.get('[data-testid="health-list"]').text();
    expect(health).not.toContain('Redis');
    expect(health).toContain('SQLBox message store');
    expect(health).toContain('JKANNEL API');
  });
});
