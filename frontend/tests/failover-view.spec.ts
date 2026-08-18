import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `vi.mock` is hoisted above the imports, so the granted permissions have to be
 * hoisted with it — a plain `const` above the factory is still in its temporal
 * dead zone when the factory first runs.
 */
const granted = vi.hoisted(() => new Set<string>(['routes.view', 'routes.manage']));
vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: granted }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import FailoverView from '../src/views/FailoverView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
const failure = (status = 500) =>
  Promise.resolve(new Response(JSON.stringify({ success: false, message: 'boom' }), { status }));

const routes = [
  {
    id: 'r1',
    name: 'MTN national',
    priority: 10,
    enabled: true,
    destination_prefix: '25677',
    sender: null,
    target_smsc_id: 's1',
    target_smsc_name: 'MTN Primary',
    fallback_smsc_id: null,
    fallback_smsc_name: null,
  },
  {
    id: 'r2',
    name: 'Airtel national',
    priority: 20,
    enabled: true,
    destination_prefix: '25675',
    sender: null,
    target_smsc_id: 's3',
    target_smsc_name: 'Airtel Primary',
    fallback_smsc_id: 's2',
    fallback_smsc_name: 'MTN Secondary',
  },
];

const smscs = [
  { id: 's1', engine_id: 'mtn-p1', name: 'MTN Primary' },
  { id: 's2', engine_id: 'mtn-p2', name: 'MTN Secondary' },
  { id: 's3', engine_id: 'airtel-p1', name: 'Airtel Primary' },
];

const override = {
  id: 'f1',
  route_id: 'r1',
  route_name: 'MTN national',
  from_smsc_id: 's1',
  to_smsc_id: 's2',
  to_engine_id: 'mtn-p2',
  to_name: 'MTN Secondary',
  reason: 'Carrier instructed traffic movement',
  started_by: 'amina',
  started_at: '2026-08-17T09:00:00Z',
};

const detail = (engineId: string) => ({
  id: engineId,
  engineId,
  name: engineId,
  type: 'smpp',
  host: 'smpp.example',
  port: 2775,
  enabled: true,
  lifecycleState: 'active',
  carrierId: null,
  carrierName: null,
  bindState: engineId === 'mtn-p2' ? 'bound' : 'disconnected',
  bindStateSince: null,
  bindObservedAt: null,
  queued: 412,
  failed: 0,
  sent: 10,
  received: 0,
  outboundRate: 12,
  inboundRate: 0,
  capacity: {
    perConnectionTps: 50,
    connections: 1,
    effectiveTps: 50,
    observedTps: 12,
    utilisation: 0.24,
    note: 'note',
  },
  transitions: [],
  limits: { unavailable: [], reason: 'r', sessionsCollapsed: false, configuredInstances: 1 },
});

interface Options {
  overrides?: unknown[];
  routesFail?: boolean;
  smscsFail?: boolean;
  posts?: { url: string; body: unknown }[];
}

async function mountView(options: Options = {}) {
  const posts = options.posts ?? [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
        return envelope({ ok: true });
      }
      if (url.includes('/control/failovers')) return envelope({ items: options.overrides ?? [] });
      if (url.includes('/detail')) {
        const engineId = url.split('/smscs/')[1].split('/')[0];
        return envelope(detail(engineId));
      }
      if (url.includes('/routes'))
        return options.routesFail ? failure() : envelope({ items: routes });
      if (url.includes('/smscs')) return options.smscsFail ? failure() : envelope({ items: smscs });
      return envelope({});
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/failover', component: { template: '<p/>' } }],
  });
  await router.push('/failover');
  await router.isReady();
  const wrapper = mount(FailoverView, { global: { plugins: [router] } });
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="failover-state"][data-state="loading"]').exists()).toBe(
      false,
    ),
  );
  return { wrapper, posts };
}

beforeEach(() => {
  granted.clear();
  granted.add('routes.view');
  granted.add('routes.manage');
});

describe('a manual override is never hidden (UC-RTE-02)', () => {
  it('lists every active override with the reason and who raised it', async () => {
    const { wrapper } = await mountView({ overrides: [override] });
    const row = wrapper.get('[data-testid="failover-row-r1"]');
    expect(row.text()).toContain('MTN national');
    expect(row.text()).toContain('manual override');
    expect(row.text()).toContain('MTN Secondary');
    expect(row.text()).toContain('Carrier instructed traffic movement');
    expect(row.text()).toContain('amina');
    expect(wrapper.get('[data-testid="failover-active-badge"]').text()).toBe('1 manual override');
  });

  it('says plainly that no override is in effect rather than showing an empty table', async () => {
    const { wrapper } = await mountView({ overrides: [] });
    expect(wrapper.get('[data-testid="failover-none"]').text()).toContain(
      'No route is being held on a manual override',
    );
    expect(wrapper.get('[data-testid="failover-active-badge"]').text()).toBe('no manual override');
  });

  it('refuses to report "no override" when the register itself could not be read', async () => {
    // An empty list means three different things; only one of them is "none".
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        String(input).includes('/control/failovers') ? failure() : envelope({ items: [] }),
      ),
    );
    const wrapper = mount(FailoverView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="failover-unknown"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="failover-none"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="failover-unknown"]').text()).toContain(
      'not a statement that none is in force',
    );
    expect(wrapper.get('[data-testid="failover-active-badge"]').text()).toBe('unknown');
  });

  it('shows the override even when the route register and SMSC list cannot be read', async () => {
    // The one fact an operator must not lose during an outage is that traffic is
    // being held somewhere on purpose.
    const { wrapper } = await mountView({
      overrides: [override],
      routesFail: true,
      smscsFail: true,
    });
    expect(wrapper.get('[data-testid="failover-row-r1"]').text()).toContain('MTN Secondary');
    expect(wrapper.get('[data-testid="failover-state"]').attributes('data-state')).toBe('partial');
    expect(wrapper.get('[data-testid="failover-state"]').text()).toContain('the route register');
  });

  it('renders the active path and the mode together on every route', async () => {
    const { wrapper } = await mountView({ overrides: [override] });
    expect(wrapper.get('[data-testid="route-active-r1"]').text()).toBe('MTN Secondary');
    expect(wrapper.get('[data-testid="route-mode-r1"]').text()).toBe('manual override');
    // The route's own configuration is still visible, unchanged.
    expect(wrapper.get('[data-testid="route-r1"]').text()).toContain('MTN Primary');
    // A route with no override reads automatic and shows its configured target.
    expect(wrapper.get('[data-testid="route-active-r2"]').text()).toBe('Airtel Primary');
    expect(wrapper.get('[data-testid="route-mode-r2"]').text()).toBe('automatic');
  });

  it('names the current path in the form heading, override or not', async () => {
    const { wrapper } = await mountView({ overrides: [override] });
    expect(wrapper.get('[data-testid="failover-current-path"]').text()).toBe('MTN Secondary');
  });
});

describe('starting a failover', () => {
  it('states the impact from live readings and posts the target and reason', async () => {
    const { wrapper, posts } = await mountView({ overrides: [] });
    await wrapper.get('[data-testid="failover-target-select"]').setValue('s2');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="failover-compare-proposed"]').text()).toContain('bound'),
    );
    await wrapper.get('[data-testid="failover-start"]').trigger('click');

    const consequences = wrapper
      .get('[data-testid="failover-confirm-consequences"]')
      .findAll('li')
      .map((item) => item.text());
    expect(consequences[0]).toContain('configured target is not changed');
    expect(consequences.join(' ')).toContain('Proposed path mtn-p2');
    // The comparison is labelled as a reading, not as advice.
    expect(wrapper.get('[data-testid="failover-compared-at"]').text()).toContain(
      'not a recommendation',
    );

    await wrapper
      .get('[data-testid="failover-confirm-reason"]')
      .setValue('Primary degraded, moving per runbook');
    await wrapper.get('[data-testid="failover-confirm-confirm"]').trigger('click');
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0].url).toContain('/control/routes/r1/failover');
    expect(posts[0].body).toEqual({
      toSmscId: 's2',
      reason: 'Primary degraded, moving per runbook',
    });
  });

  it('does not offer the connection this route’s traffic is already on', async () => {
    const { wrapper } = await mountView({ overrides: [override] });
    // r1 is already overridden onto s2, so s2 is not offered; s3 is.
    const options = wrapper
      .get('[data-testid="failover-target-select"]')
      .findAll('option')
      .map((option) => option.attributes('value'));
    expect(options).not.toContain('s2');
    expect(options).toContain('s1');
  });

  it('warns, verbatim about the bind it read, when the proposed target is not bound', async () => {
    const { wrapper } = await mountView({ overrides: [] });
    // s3 (airtel-p1) reports `disconnected` in the fixture.
    await wrapper.get('[data-testid="failover-target-select"]').setValue('s3');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="failover-target-warning"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="failover-target-warning"]').text()).toContain('disconnected');
  });
});

describe('reverting an override', () => {
  it('says where traffic returns to and that reverting checks nothing', async () => {
    const { wrapper, posts } = await mountView({ overrides: [override] });
    await wrapper.get('[data-testid="failover-revert-r1"]').trigger('click');
    const text = wrapper.get('[data-testid="revert-confirm-consequences"]').text();
    expect(text).toContain('MTN Primary');
    expect(text).toContain('Reverting does not check it');
    expect(text).toContain('Carrier instructed traffic movement');

    await wrapper.get('[data-testid="revert-confirm-reason"]').setValue('Incident closed');
    await wrapper.get('[data-testid="revert-confirm-confirm"]').trigger('click');
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0].url).toContain('/control/routes/r1/failover/revert');
    expect(posts[0].body).toEqual({ reason: 'Incident closed' });
  });

  it('offers no mutating control to an operator who may only read', async () => {
    granted.delete('routes.manage');
    const { wrapper } = await mountView({ overrides: [override] });
    expect(wrapper.find('[data-testid="failover-revert-r1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="failover-readonly"]').text()).toContain('routes.manage');
    expect(wrapper.get('[data-testid="failover-start"]').attributes('disabled')).toBeDefined();
    // But the override itself is still fully visible.
    expect(wrapper.get('[data-testid="failover-row-r1"]').text()).toContain('MTN Secondary');
  });
});
