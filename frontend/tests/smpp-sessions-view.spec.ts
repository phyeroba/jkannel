import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['smsc.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import SmppSessionsView from '../src/views/SmppSessionsView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const UNAVAILABLE = [
  'per-session identity',
  'bind state in SMPP vocabulary (BOUND_TX/RX/TRX)',
  'enquire_link round-trip time and missed responses',
  'submit_sm / submit_sm_resp / deliver_sm / generic_nack counters',
  'protocol response latency (median, P95)',
  'session uptime and last protocol activity',
];

const SINGLE_REASON =
  'bearerbox exposes only aggregate counters per smsc-id through its status interface.';
const COLLAPSED_REASON =
  'This SMSC is configured with 3 parallel connections, which the engine reports as a single entry sharing one smsc-id.';

const detail = (engineId: string, overrides: Record<string, unknown> = {}) => ({
  id: `id-${engineId}`,
  engineId,
  name: engineId.toUpperCase(),
  type: 'smpp',
  host: 'smpp.example.net',
  port: 2775,
  enabled: true,
  lifecycleState: 'active',
  carrierId: null,
  carrierName: null,
  bindState: 'bound',
  bindStateSince: '2026-08-17T09:00:00Z',
  bindObservedAt: '2026-08-17T09:30:00Z',
  queued: 3,
  failed: 0,
  sent: 10,
  received: 1,
  outboundRate: 5,
  inboundRate: 0,
  capacity: {
    perConnectionTps: 50,
    connections: 1,
    effectiveTps: 50,
    observedTps: 5,
    utilisation: 0.1,
    note: 'Configured ceiling 50/s on a single connection.',
  },
  transitions: [],
  limits: {
    unavailable: UNAVAILABLE,
    reason: SINGLE_REASON,
    sessionsCollapsed: false,
    configuredInstances: 1,
  },
  ...overrides,
});

const collapsed = (engineId: string) =>
  detail(engineId, {
    capacity: {
      perConnectionTps: 50,
      connections: 3,
      effectiveTps: 150,
      observedTps: null,
      utilisation: null,
      note: 'throughput is enforced per connection, so 3 parallel connections at 50/s allow about 150/s in total.',
    },
    outboundRate: null,
    limits: {
      unavailable: UNAVAILABLE,
      reason: COLLAPSED_REASON,
      sessionsCollapsed: true,
      configuredInstances: 3,
    },
  });

const mountView = async (details: ReturnType<typeof detail>[], total = details.length) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      const match = url.match(/\/smscs\/([^/]+)\/detail/);
      if (match) {
        const found = details.find((row) => row.engineId === match[1]);
        return found
          ? envelope(found)
          : Promise.resolve(new Response('{"success":false}', { status: 500 }));
      }
      if (url.includes('/smscs?'))
        return envelope({
          items: details.map((row) => ({
            id: row.id,
            engine_id: row.engineId,
            name: row.name,
            type: row.type,
            host: row.host,
            port: row.port,
            tps: 50,
            enabled: true,
            lifecycle_state: 'active',
          })),
          total,
        });
      return envelope({});
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/sessions-smpp', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
      { path: '/carriers/:id', component: { template: '<p/>' } },
    ],
  });
  await router.push('/sessions-smpp');
  await router.isReady();
  const wrapper = mount(SmppSessionsView, { global: { plugins: [router] } });
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, calls };
};

describe('SMPP Sessions — what it says it cannot show', () => {
  it('leads with the statement that these are binds, not sessions', async () => {
    const { wrapper } = await mountView([detail('mtn-p1')]);
    const scope = wrapper.get('[data-testid="sessions-scope"]').text();
    expect(scope).toContain('register of binds, not of sessions');
    expect(scope).toContain('instances = N');
    expect(scope).toContain('share');
  });

  it('renders the limits reason verbatim and every unavailable field', async () => {
    const { wrapper } = await mountView([detail('mtn-p1')]);
    const block = wrapper.get('[data-testid="sessions-limits-mtn-p1"]');
    expect(block.get('[data-testid="sessions-limits-mtn-p1-reason"]').text()).toBe(SINGLE_REASON);
    expect(
      block
        .get('[data-testid="sessions-limits-mtn-p1-unavailable"]')
        .findAll('li')
        .map((item) => item.text()),
    ).toEqual(UNAVAILABLE);
  });

  it('groups the limits by reason and names the connections each one covers', async () => {
    const { wrapper } = await mountView([
      detail('mtn-p1'),
      detail('mtn-p2'),
      collapsed('airtel-p1'),
    ]);
    const single = wrapper.get('[data-testid="sessions-limits-mtn-p1"]');
    expect(single.get('[data-testid="sessions-limits-mtn-p1-applies-to"]').text()).toContain(
      'mtn-p1, mtn-p2',
    );
    const many = wrapper.get('[data-testid="sessions-limits-airtel-p1"]');
    expect(many.get('[data-testid="sessions-limits-airtel-p1-reason"]').text()).toBe(
      COLLAPSED_REASON,
    );
    expect(many.get('[data-testid="sessions-limits-airtel-p1-applies-to"]').text()).toContain(
      'airtel-p1',
    );
    // The collapsed reason must not be presented as covering the whole estate.
    expect(many.get('[data-testid="sessions-limits-airtel-p1-applies-to"]').text()).not.toContain(
      'mtn-p1',
    );
  });

  it('has no column for any field it has declared unavailable', async () => {
    const { wrapper } = await mountView([detail('mtn-p1')]);
    const headings = wrapper
      .get('[data-testid="sessions-table"]')
      .findAll('th')
      .map((th) => th.text().toLowerCase());
    for (const forbidden of ['enquire', 'rtt', 'submit_sm', 'generic_nack', 'uptime', 'p95'])
      expect(headings.some((heading) => heading.includes(forbidden))).toBe(false);
  });

  it('marks a collapsed row and summarises which rows are collapsed', async () => {
    const { wrapper } = await mountView([detail('mtn-p1'), collapsed('airtel-p1')]);
    expect(wrapper.get('[data-testid="session-collapsed-airtel-p1"]').text()).toContain(
      '3 collapsed into 1',
    );
    expect(wrapper.get('[data-testid="session-collapsed-mtn-p1"]').text()).toContain(
      '1 configured',
    );
    const summary = wrapper.get('[data-testid="sessions-collapsed-summary"]').text();
    expect(summary).toContain('airtel-p1 (3)');
    expect(summary).toContain('nothing on this screen will show it');
  });

  it('counts configured sessions and calls them configuration, not observation', async () => {
    const { wrapper } = await mountView([detail('mtn-p1'), collapsed('airtel-p1')]);
    // 1 + 3 configured connections behind two reported binds.
    expect(wrapper.get('[data-testid="sessions-metric-configured"]').text()).toBe('4');
    expect(wrapper.get('[data-testid="sessions-configured-note"]').text()).toContain(
      'configuration, not observation',
    );
  });
});

describe('SMPP Sessions — the register', () => {
  it('shows a multi-connection ceiling as the product, and its utilisation as unknown', async () => {
    const { wrapper } = await mountView([collapsed('airtel-p1')]);
    const row = wrapper.get('[data-testid="session-airtel-p1"]').text();
    expect(row).toContain('150/s (50/s × 3 connections)');
    expect(wrapper.get('[data-testid="session-utilisation-airtel-p1"]').text()).toBe('unknown');
  });

  it('says "never observed" rather than reporting a state nobody saw', async () => {
    const { wrapper } = await mountView([
      detail('mtn-p1', { bindState: null, bindStateSince: null, bindObservedAt: null }),
    ]);
    expect(wrapper.get('[data-testid="session-state-mtn-p1"]').text()).toBe('never observed');
    expect(wrapper.get('[data-testid="sessions-metric-unobserved"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="sessions-metric-bound"]').text()).toBe('0');
  });

  it('sends every filter, sort and page control to the API', async () => {
    const { wrapper, calls } = await mountView([detail('mtn-p1')], 40);
    await wrapper.get('[data-testid="sessions-search"]').setValue('mtn');
    await wrapper.get('[data-testid="sessions-filter-enabled"]').setValue('true');
    await wrapper.get('[data-testid="sessions-sort"]').setValue('lifecycleState');
    await wrapper.get('[data-testid="sessions-sort-direction"]').setValue('desc');
    await vi.waitFor(() =>
      expect(calls.some((url) => url.includes('sort=-lifecycleState'))).toBe(true),
    );
    const listCall = calls.filter((url) => url.includes('/smscs?')).pop() ?? '';
    expect(listCall).toContain('search=mtn');
    expect(listCall).toContain('filter.type=smpp');
    expect(listCall).toContain('filter.enabled=true');
    expect(listCall).toContain('limit=25');

    // The pager lives inside the content the loading skeleton replaces, so wait
    // for the re-read to settle before turning the page.
    await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
    await wrapper.get('[data-testid="sessions-next"]').trigger('click');
    await vi.waitFor(() => expect(calls.some((url) => url.includes('offset=25'))).toBe(true));
  });

  it('offers no bind-state filter, because the API cannot honour one', async () => {
    const { wrapper } = await mountView([detail('mtn-p1')]);
    expect(wrapper.find('[data-testid="sessions-filter-bind-state"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="sessions-grid-note"]').text()).toContain(
      'no filter or sort on bind state',
    );
  });

  it('reports a partial read by naming the connections it could not read', async () => {
    const details = [detail('mtn-p1')];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes('/smscs/broken/detail'))
          return Promise.resolve(new Response('{"success":false}', { status: 500 }));
        if (url.includes('/smscs/mtn-p1/detail')) return envelope(details[0]);
        if (url.includes('/smscs?'))
          return envelope({
            items: [
              { id: 'a', engine_id: 'mtn-p1', name: 'MTN', type: 'smpp', enabled: true },
              { id: 'b', engine_id: 'broken', name: 'Broken', type: 'smpp', enabled: true },
            ],
            total: 2,
          });
        return envelope({});
      }),
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/sessions-smpp', component: { template: '<p/>' } },
        { path: '/smsc/:engineId', component: { template: '<p/>' } },
        { path: '/carriers/:id', component: { template: '<p/>' } },
      ],
    });
    await router.push('/sessions-smpp');
    await router.isReady();
    const wrapper = mount(SmppSessionsView, { global: { plugins: [router] } });
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="sessions-state"]').attributes('data-state')).toBe(
        'partial',
      ),
    );
    // Partial keeps the usable rows on screen AND names what is missing.
    expect(wrapper.get('[data-testid="sessions-state"]').text()).toContain('broken');
    expect(wrapper.find('[data-testid="session-mtn-p1"]').exists()).toBe(true);
  });
});
