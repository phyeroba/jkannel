import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['smsc.view', 'smsc.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import CarrierDetailView from '../src/views/CarrierDetailView.vue';
import { clearBreadcrumbTrail, resolveBreadcrumbs } from '../src/stores/breadcrumbs';

const CARRIER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const FREE_ID = '33333333-3333-4333-8333-333333333333';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const carrier = (overrides: Record<string, unknown> = {}) => ({
  id: CARRIER_ID,
  name: 'MTN Uganda',
  country_code: 'UG',
  network_code: '64110',
  status: 'active',
  notes: 'Primary market',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  smscCount: 1,
  bindsHealthy: 1,
  bindsTotal: 1,
  bindsUnobserved: 0,
  health: 'healthy',
  queuedMessages: 12,
  failedMessages: 0,
  capacityTps: 50,
  observedTps: null,
  utilisation: null,
  openAlerts: 0,
  ...overrides,
});

const member = (overrides: Record<string, unknown> = {}) => ({
  id: MEMBER_ID,
  engineId: 'mtn-p1',
  name: 'MTN Primary',
  type: 'smpp',
  host: 'smpp.mtn.co.ug',
  port: 2775,
  enabled: true,
  lifecycleState: 'active',
  carrierId: CARRIER_ID,
  carrierName: 'MTN Uganda',
  bindState: 'bound',
  bindStateSince: '2026-08-17T09:00:00Z',
  bindObservedAt: '2026-08-17T09:30:00Z',
  queued: 12,
  failed: 0,
  sent: 100,
  received: 4,
  outboundRate: 20,
  inboundRate: 0,
  capacity: {
    perConnectionTps: 50,
    connections: 2,
    effectiveTps: 100,
    observedTps: 20,
    utilisation: 0.2,
    note: 'throughput is enforced per connection…',
  },
  transitions: [],
  limits: {
    unavailable: [],
    reason: 'r',
    sessionsCollapsed: true,
    configuredInstances: 2,
  },
  ...overrides,
});

const freeSmsc = {
  id: FREE_ID,
  engine_id: 'airtel-p1',
  name: 'Airtel Primary',
  type: 'smpp',
  enabled: true,
  lifecycle_state: 'active',
};

interface Fixture {
  carrierPayload?: unknown;
  members?: ReturnType<typeof member>[];
  unassigned?: unknown[];
  /** Engine ids whose detail read fails, to exercise `partial`. */
  broken?: string[];
}

const mountView = async (fixture: Fixture = {}) => {
  const members = fixture.members ?? [member()];
  const unassigned = fixture.unassigned ?? [freeSmsc];
  const broken = fixture.broken ?? [];
  const posts: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') {
      posts.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return envelope({ ok: true });
    }
    const detailMatch = url.match(/\/smscs\/([^/?]+)\/detail/);
    if (detailMatch) {
      if (broken.includes(detailMatch[1]))
        return Promise.resolve(new Response('{"success":false}', { status: 500 }));
      const found = members.find((row) => row.engineId === detailMatch[1]);
      return found
        ? envelope(found)
        : envelope(member({ engineId: detailMatch[1], carrierId: 'someone-else' }));
    }
    if (url.includes('/carriers/unassigned-smscs')) return envelope(unassigned);
    if (url.includes(`/carriers/${CARRIER_ID}`)) {
      const payload = fixture.carrierPayload ?? carrier();
      return payload instanceof Response ? Promise.resolve(payload.clone()) : envelope(payload);
    }
    if (url.includes('/smscs?'))
      return envelope({
        items: [
          ...members.map((row) => ({
            id: row.id,
            engine_id: row.engineId,
            name: row.name,
            type: row.type,
          })),
          ...broken.map((engineId) => ({ id: engineId, engine_id: engineId, name: engineId })),
          { id: FREE_ID, engine_id: freeSmsc.engine_id, name: freeSmsc.name, type: 'smpp' },
        ],
        total: members.length + broken.length + 1,
      });
    return envelope({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/carriers', component: { template: '<p/>' } },
      { path: '/carriers/:id', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
    ],
  });
  await router.push(`/carriers/${CARRIER_ID}`);
  await router.isReady();
  const wrapper = mount(CarrierDetailView, { global: { plugins: [router] } });
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, router, posts, fetchMock };
};

beforeEach(() => clearBreadcrumbTrail());

describe('carrier detail', () => {
  it('publishes the Carriers / carrier hierarchy once the name is known', async () => {
    const { router } = await mountView();
    expect(resolveBreadcrumbs(router.currentRoute.value)).toEqual([
      { label: 'Carriers', to: '/carriers' },
      { label: 'MTN Uganda' },
    ]);
  });

  it('publishes nothing while the carrier is still loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/carriers/:id', component: { template: '<p/>' } }],
    });
    await router.push(`/carriers/${CARRIER_ID}`);
    await router.isReady();
    mount(CarrierDetailView, { global: { plugins: [router] } });
    // A placeholder crumb that changes under the reader is worse than none.
    expect(resolveBreadcrumbs(router.currentRoute.value)).toEqual([]);
  });

  it('explains the health verdict in words, not only as a badge', async () => {
    const { wrapper } = await mountView({
      carrierPayload: carrier({
        health: 'unknown',
        smscCount: 0,
        bindsTotal: 0,
        bindsHealthy: 0,
      }),
      members: [],
    });
    expect(wrapper.get('[data-testid="carrier-detail-health"]').text()).toBe('unknown');
    expect(wrapper.get('[data-testid="carrier-health-explanation"]').text()).toContain(
      'nothing to be healthy',
    );
  });

  it('shows the roll-up utilisation as unknown and says why', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="carrier-metric-utilisation"]').text()).toBe('unknown');
    expect(wrapper.get('[data-testid="carrier-utilisation-note"]').text()).toContain(
      'rather than a number nobody measured',
    );
  });

  it('lists its connections with the per-connection ceiling spelled out', async () => {
    const { wrapper } = await mountView();
    const row = wrapper.get('[data-testid="carrier-smsc-mtn-p1"]').text();
    expect(row).toContain('MTN Primary');
    expect(row).toContain('100/s (50/s × 2 connections)');
    expect(wrapper.get('[data-testid="carrier-smsc-utilisation-mtn-p1"]').text()).toBe('20%');
  });

  it('attaches an unassigned connection and detaches an attached one', async () => {
    const { wrapper, posts } = await mountView();
    await wrapper.get('[data-testid="carrier-attach-select"]').setValue(FREE_ID);
    await wrapper.get('[data-testid="carrier-attach"]').trigger('click');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].method).toBe('POST');
    expect(posts[0].url).toContain(`/carriers/${CARRIER_ID}/smscs`);
    expect(posts[0].body).toEqual({ smscId: FREE_ID });

    await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
    await wrapper.get('[data-testid="carrier-detach-mtn-p1"]').trigger('click');
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].method).toBe('DELETE');
    expect(posts[1].url).toContain(`/carriers/${CARRIER_ID}/smscs/${MEMBER_ID}`);
  });

  it('tells an operator with no connections what to do next', async () => {
    const { wrapper } = await mountView({ members: [] });
    const state = wrapper.get('[data-testid="carrier-smscs-state"]');
    expect(state.attributes('data-state')).toBe('empty');
    expect(state.text()).toContain('Attach one above');
  });

  it('reports a connection it could not read as partial, by name', async () => {
    const { wrapper } = await mountView({ broken: ['ghost'] });
    const state = wrapper.get('[data-testid="carrier-smscs-state"]');
    expect(state.attributes('data-state')).toBe('partial');
    expect(state.text()).toContain('ghost');
    // Partial keeps the rows it did read.
    expect(wrapper.find('[data-testid="carrier-smsc-mtn-p1"]').exists()).toBe(true);
  });

  it('skips the detail read for connections already known to be unassigned', async () => {
    const { fetchMock } = await mountView();
    const detailCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/detail'));
    expect(detailCalls.some((url) => url.includes('mtn-p1'))).toBe(true);
    expect(detailCalls.some((url) => url.includes('airtel-p1'))).toBe(false);
  });

  it('offers a way back when the carrier does not exist', async () => {
    const { wrapper } = await mountView({
      carrierPayload: new Response(
        JSON.stringify({ success: false, message: 'Carrier not found' }),
        {
          status: 404,
        },
      ),
    });
    expect(wrapper.get('[data-testid="carrier-not-found"]').text()).toContain(
      'not in the register',
    );
  });
});
