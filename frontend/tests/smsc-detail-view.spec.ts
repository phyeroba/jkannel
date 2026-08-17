import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['smsc.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import SmscDetailView from '../src/views/SmscDetailView.vue';
import { clearBreadcrumbTrail, resolveBreadcrumbs } from '../src/stores/breadcrumbs';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

/** Mirrors backend/src/connectivity/smsc-detail.service.ts `observabilityLimits`. */
const limits = (configuredInstances = 1) => ({
  unavailable: [
    'per-session identity',
    'bind state in SMPP vocabulary (BOUND_TX/RX/TRX)',
    'enquire_link round-trip time and missed responses',
    'submit_sm / submit_sm_resp / deliver_sm / generic_nack counters',
    'protocol response latency (median, P95)',
    'session uptime and last protocol activity',
  ],
  reason:
    configuredInstances > 1
      ? `This SMSC is configured with ${configuredInstances} parallel connections, which the engine reports as a single entry sharing one smsc-id.`
      : 'bearerbox exposes only aggregate counters per smsc-id through its status interface.',
  sessionsCollapsed: configuredInstances > 1,
  configuredInstances,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  engineId: 'mtn-p1',
  name: 'MTN Primary',
  type: 'smpp',
  host: 'smpp.mtn.co.ug',
  port: 2775,
  enabled: true,
  lifecycleState: 'active',
  carrierId: '11111111-1111-4111-8111-111111111111',
  carrierName: 'MTN Uganda',
  bindState: 'bound',
  bindStateSince: '2026-08-17T09:00:00Z',
  bindObservedAt: '2026-08-17T09:30:00Z',
  queued: 12,
  failed: 0,
  sent: 4200,
  received: 88,
  outboundRate: 30,
  inboundRate: 1,
  capacity: {
    perConnectionTps: 50,
    connections: 3,
    effectiveTps: 150,
    observedTps: 30,
    utilisation: 0.2,
    note: 'throughput is enforced per connection, so 3 parallel connections at 50/s allow about 150/s in total. Check this against the rate your contract with the carrier actually permits.',
  },
  transitions: [
    {
      kind: 'state_change',
      fromState: 'connecting',
      toState: 'bound',
      detail: { attempt: 2 },
      observedAt: '2026-08-17T09:00:00Z',
    },
  ],
  limits: limits(3),
  ...overrides,
});

const mountView = async (payload: unknown, path = '/smsc/mtn-p1') => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/detail'))
        return payload instanceof Response ? Promise.resolve(payload.clone()) : envelope(payload);
      return envelope({});
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/smsc', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
      { path: '/carriers', component: { template: '<p/>' } },
      { path: '/carriers/:id', component: { template: '<p/>' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(SmscDetailView, { global: { plugins: [router] } });
  // DataState renders nothing at all once the state is `live`, so "settled"
  // is the absence of the loading skeleton rather than a state attribute.
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, router };
};

beforeEach(() => clearBreadcrumbTrail());

describe('SMSC detail — the limits block', () => {
  it('renders the reason verbatim and every unavailable field', async () => {
    const { wrapper } = await mountView(detail());
    const block = wrapper.get('[data-testid="smsc-limits"]');
    expect(block.get('[data-testid="smsc-limits-reason"]').text()).toBe(detail().limits.reason);

    const listed = block
      .get('[data-testid="smsc-limits-unavailable"]')
      .findAll('li')
      .map((item) => item.text());
    expect(listed).toEqual(limits(3).unavailable);
    // The distinction the whole block exists for.
    expect(block.text()).toContain('not observable');
    expect(block.text()).toContain('never zero');
  });

  it('adds no columns for the fields it has just declared unavailable', async () => {
    const { wrapper } = await mountView(detail());
    const body = wrapper.text();
    // The words appear only inside the limits list, never as a table heading.
    expect(wrapper.findAll('th').map((th) => th.text().toLowerCase())).not.toContain('enquire rtt');
    expect(wrapper.findAll('th').map((th) => th.text().toLowerCase())).not.toContain('p95 latency');
    expect(body).toContain('enquire_link round-trip time and missed responses');
  });

  it('warns that several sessions are collapsed into one reported entry', async () => {
    const { wrapper } = await mountView(detail());
    const collapsed = wrapper.get('[data-testid="smsc-limits-collapsed"]');
    expect(collapsed.text()).toContain('3 parallel connections are reported here as one');
    expect(collapsed.text()).toContain('one failing session is invisible');
  });

  it('drops the collapse warning when the SMSC runs a single connection', async () => {
    const { wrapper } = await mountView(
      detail({
        limits: limits(1),
        capacity: {
          perConnectionTps: 50,
          connections: 1,
          effectiveTps: 50,
          observedTps: 10,
          utilisation: 0.2,
          note: 'Configured ceiling 50/s on a single connection.',
        },
      }),
    );
    expect(wrapper.find('[data-testid="smsc-limits-collapsed"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="smsc-limits-reason"]').text()).toContain(
      'aggregate counters per smsc-id',
    );
  });
});

describe('SMSC detail — capacity and utilisation', () => {
  it('multiplies the per-connection ceiling and shows the engine’s own explanation', async () => {
    const { wrapper } = await mountView(detail());
    expect(wrapper.get('[data-testid="smsc-capacity-per-connection"]').text()).toBe('50/s');
    expect(wrapper.get('[data-testid="smsc-capacity-connections"]').text()).toBe('3');
    expect(wrapper.get('[data-testid="smsc-capacity-effective"]').text()).toBe(
      '150/s (50/s × 3 connections)',
    );
    // Verbatim — the multiplier is the surprising part and must not be paraphrased.
    expect(wrapper.get('[data-testid="smsc-capacity-note"]').text()).toBe(detail().capacity.note);
    expect(wrapper.get('[data-testid="smsc-capacity-utilisation"]').text()).toBe('20%');
  });

  it('reads utilisation as unknown — never 0% or 100% — when there is no ceiling', async () => {
    const { wrapper } = await mountView(
      detail({
        capacity: {
          perConnectionTps: null,
          connections: 1,
          effectiveTps: null,
          observedTps: 30,
          utilisation: null,
          note: 'No throughput ceiling is configured for this SMSC, so utilisation cannot be calculated.',
        },
      }),
    );
    expect(wrapper.get('[data-testid="smsc-capacity-utilisation"]').text()).toBe('unknown');
    expect(wrapper.get('[data-testid="smsc-utilisation-badge"]').text()).toBe('unknown');
    expect(wrapper.get('[data-testid="smsc-capacity-effective"]').text()).toBe(
      'no ceiling configured',
    );
    expect(wrapper.get('[data-testid="smsc-utilisation-unknown"]').text()).toContain(
      'no throughput ceiling is configured',
    );
    expect(wrapper.get('[data-testid="smsc-utilisation-unknown"]').text()).toContain(
      'It is not 0% and it is not 100%',
    );
  });

  it('reads utilisation as unknown when the ceiling exists but nothing was observed', async () => {
    const { wrapper } = await mountView(
      detail({
        outboundRate: null,
        capacity: {
          perConnectionTps: 50,
          connections: 1,
          effectiveTps: 50,
          observedTps: null,
          utilisation: null,
          note: 'Configured ceiling 50/s on a single connection.',
        },
      }),
    );
    expect(wrapper.get('[data-testid="smsc-capacity-observed"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="smsc-utilisation-unknown"]').text()).toContain(
      'no outbound rate has been observed',
    );
  });
});

describe('SMSC detail — honest state and hierarchy', () => {
  it('publishes the real Carriers / carrier / connection trail', async () => {
    const { router } = await mountView(detail());
    expect(resolveBreadcrumbs(router.currentRoute.value)).toEqual([
      { label: 'Carriers', to: '/carriers' },
      { label: 'MTN Uganda', to: '/carriers/11111111-1111-4111-8111-111111111111' },
      { label: 'MTN Primary' },
    ]);
  });

  it('does not invent a carrier ancestor for an unfiled connection', async () => {
    const { router } = await mountView(detail({ carrierId: null, carrierName: null }));
    expect(resolveBreadcrumbs(router.currentRoute.value)).toEqual([
      { label: 'SMSC Connections', to: '/smsc' },
      { label: 'MTN Primary' },
    ]);
  });

  it('says "never observed" rather than "disconnected" when no bind state exists', async () => {
    const { wrapper } = await mountView(detail({ bindState: null, bindStateSince: null }));
    expect(wrapper.get('[data-testid="smsc-bind-badge"]').text()).toBe('never observed');
    expect(wrapper.get('[data-testid="smsc-never-observed"]').text()).toContain(
      'not the same as “disconnected”',
    );
  });

  it('labels the counters as engine aggregates, not delivery receipts', async () => {
    const { wrapper } = await mountView(detail({ failed: 0 }));
    expect(wrapper.get('[data-testid="smsc-metric-failed"]').text()).toBe('0');
    expect(wrapper.get('[data-testid="smsc-counter-note"]').text()).toContain(
      'not a count of undelivered messages',
    );
  });

  it('explains an empty bind timeline instead of implying the history aged out', async () => {
    const { wrapper } = await mountView(detail({ transitions: [] }));
    expect(wrapper.get('[data-testid="smsc-timeline-empty"]').text()).toContain(
      'not that older entries have aged out',
    );
    expect(wrapper.get('[data-testid="smsc-last-event"]').text()).toContain(
      'no bind transition has ever been recorded',
    );
  });

  it('offers a way back when the engine id does not resolve', async () => {
    const { wrapper } = await mountView(
      new Response(JSON.stringify({ success: false, message: 'SMSC not found' }), { status: 404 }),
    );
    expect(wrapper.get('[data-testid="smsc-not-found"]').text()).toContain('mtn-p1');
  });
});
