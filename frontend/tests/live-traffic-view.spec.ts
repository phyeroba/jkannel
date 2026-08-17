import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['messages.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import LiveTrafficView from '../src/views/LiveTrafficView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const bind = (engineId: string, over: Record<string, unknown> = {}) => ({
  engineId,
  name: engineId.toUpperCase(),
  smscName: engineId.toUpperCase(),
  status: 'online',
  queued: 10,
  failed: 0,
  sent: 500,
  received: 20,
  outboundRate: [4, 3, 2],
  inboundRate: [1, 1, 1],
  known: true,
  ...over,
});

const snapshot = (binds: ReturnType<typeof bind>[], over: Record<string, unknown> = {}) => ({
  observedAt: '2026-08-17T09:30:00Z',
  engine: {
    status: 'running',
    version: '1.8.3',
    uptimeSeconds: 7200,
    smsQueuedOut: 12,
    smsQueuedIn: 0,
    dlrQueued: 4,
    storeSize: 30,
  },
  binds,
  spool: { queued: 0, oldestEpoch: null },
  source: { status: 'ok', detail: 'Parsed from Kamex bearerbox /status.json' },
  ...over,
});

/** A fetch mock whose payload can be swapped between refreshes. */
const liveFetch = (initial: unknown) => {
  const current = { body: initial, status: 200 };
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      current.status === 200
        ? envelope(current.body)
        : Promise.resolve(
            new Response('{"success":false,"message":"nope"}', { status: current.status }),
          ),
    ),
  );
  return current;
};

/** The view polls on a timer; unmounting is what clears it between tests. */
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

const testRouter = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/live-traffic', component: { template: '<p/>' } },
      { path: '/dlr-performance', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
    ],
  });
  await router.push('/live-traffic');
  await router.isReady();
  return router;
};

const mountView = async (initial: unknown) => {
  const current = liveFetch(initial);
  const router = await testRouter();
  const wrapper = mount(LiveTrafficView, { global: { plugins: [router] } });
  mounted.push(wrapper);
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, current };
};

const rowOrder = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('[data-testid^="live-traffic-row-"]').map((row) => row.attributes('data-testid'));

describe('Live Traffic — calm, in-place updates (§6)', () => {
  it('does NOT reorder rows when the figures change on refresh', async () => {
    const { wrapper, current } = await mountView(
      snapshot([bind('alpha', { queued: 1 }), bind('zulu', { queued: 900 })]),
    );
    expect(rowOrder(wrapper)).toEqual(['live-traffic-row-alpha', 'live-traffic-row-zulu']);

    // The estate now looks completely different: zulu drains, alpha backs up,
    // and the engine returns the binds in the opposite order.
    current.body = snapshot([bind('zulu', { queued: 0 }), bind('alpha', { queued: 500 })]);
    await wrapper.get('[data-testid="live-traffic-refresh"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="live-traffic-queued-alpha"]').text()).toBe('500'),
    );

    // Values updated in place; the rows did not move.
    expect(rowOrder(wrapper)).toEqual(['live-traffic-row-alpha', 'live-traffic-row-zulu']);
    expect(wrapper.get('[data-testid="live-traffic-queued-zulu"]').text()).toBe('0');
  });

  it('reorders only when the operator turns ranking on, and it starts off', async () => {
    const { wrapper } = await mountView(
      snapshot([bind('alpha', { queued: 1 }), bind('zulu', { queued: 900 })]),
    );
    const rank = wrapper.get('[data-testid="live-traffic-rank"]');
    expect((rank.element as HTMLSelectElement).value).toBe('false');
    await rank.setValue(true);
    expect(rowOrder(wrapper)).toEqual(['live-traffic-row-zulu', 'live-traffic-row-alpha']);
  });

  it('keeps the same DOM row element across a refresh, so a value updates in place', async () => {
    const { wrapper, current } = await mountView(snapshot([bind('alpha', { queued: 1 })]));
    const before = wrapper.get('[data-testid="live-traffic-row-alpha"]').element;
    current.body = snapshot([bind('alpha', { queued: 2 })]);
    await wrapper.get('[data-testid="live-traffic-refresh"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="live-traffic-queued-alpha"]').text()).toBe('2'),
    );
    expect(wrapper.get('[data-testid="live-traffic-row-alpha"]').element).toBe(before);
  });
});

describe('Live Traffic — rates that were not measured', () => {
  it('renders a missing rate as an em dash rather than 0/s', async () => {
    const { wrapper } = await mountView(
      snapshot([bind('quiet', { outboundRate: null, inboundRate: undefined, queued: null })]),
    );
    expect(wrapper.get('[data-testid="live-traffic-mt-1m-quiet"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="live-traffic-mo-quiet"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="live-traffic-queued-quiet"]').text()).toBe('—');
    // And the estate roll-up must not become 0/s either.
    expect(wrapper.get('[data-testid="live-traffic-mt-now"]').text()).toBe('—');
  });

  it('distinguishes a real zero from an unmeasured one, and says the engine cannot', async () => {
    const { wrapper } = await mountView(snapshot([bind('idle', { outboundRate: [0, 0, 0] })]));
    expect(wrapper.get('[data-testid="live-traffic-mt-1m-idle"]').text()).toBe('0/s');
    expect(wrapper.get('[data-testid="live-traffic-rate-note"]').text()).toContain(
      'either an idle bind or an unreported one',
    );
  });

  it('shows current, 15-minute mean and a session peak for MT', async () => {
    const { wrapper, current } = await mountView(snapshot([bind('alpha')]));
    expect(wrapper.get('[data-testid="live-traffic-mt-now"]').text()).toBe('4/s');
    expect(wrapper.get('[data-testid="live-traffic-mt-average"]').text()).toBe('2/s');
    expect(wrapper.get('[data-testid="live-traffic-peak-alpha"]').text()).toBe('4/s');

    current.body = snapshot([bind('alpha', { outboundRate: [11, 3, 2] })]);
    await wrapper.get('[data-testid="live-traffic-refresh"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="live-traffic-peak-alpha"]').text()).toBe('11/s'),
    );

    // A drop does not lower the peak; resetting it does.
    current.body = snapshot([bind('alpha', { outboundRate: [1, 1, 1] })]);
    await wrapper.get('[data-testid="live-traffic-refresh"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="live-traffic-mt-now"]').text()).toBe('1/s'),
    );
    expect(wrapper.get('[data-testid="live-traffic-peak-alpha"]').text()).toBe('11/s');
    await wrapper.get('[data-testid="live-traffic-reset-peaks"]').trigger('click');
    expect(wrapper.get('[data-testid="live-traffic-peak-alpha"]').text()).toBe('—');
  });
});

describe('Live Traffic — what it cannot show', () => {
  it('states that no per-bind DLR rate exists, and draws no column for one', async () => {
    const { wrapper } = await mountView(snapshot([bind('alpha')]));
    const note = wrapper.get('[data-testid="live-traffic-dlr-note"]').text();
    expect(note).toContain('no DLR throughput on this screen');
    expect(note).toContain('queue depth');
    const headings = wrapper
      .get('[data-testid="live-traffic-table"]')
      .findAll('th')
      .map((th) => th.text().toLowerCase());
    expect(headings.some((heading) => heading.includes('dlr'))).toBe(false);
    // The engine-wide receipt queue is a depth and is labelled as one.
    expect(wrapper.get('[data-testid="live-traffic-dlr-queued"]').text()).toBe('4');
  });

  it('keeps the rows but warns when the engine runtime is degraded', async () => {
    const detail = 'Kamex status did not include an smscs array; bind detail is unavailable';
    const { wrapper } = await mountView(
      snapshot([bind('alpha')], { source: { status: 'degraded', detail } }),
    );
    const block = wrapper.get('[data-testid="live-traffic-state"]');
    expect(block.attributes('data-state')).toBe('partial');
    expect(block.text()).toContain(detail);
    expect(wrapper.find('[data-testid="live-traffic-row-alpha"]').exists()).toBe(true);
  });

  it('says the engine reports no binds rather than showing an empty table of zeros', async () => {
    const { wrapper } = await mountView(snapshot([]));
    const block = wrapper.get('[data-testid="live-traffic-state"]');
    expect(block.attributes('data-state')).toBe('empty');
    expect(block.text()).toContain('no binds');
    expect(wrapper.find('[data-testid="live-traffic-table"]').exists()).toBe(false);
  });

  it('states bind health in a word, not only a colour', async () => {
    const { wrapper } = await mountView(
      snapshot([bind('dead-one', { status: 'dead' }), bind('unknown-one', { status: null })]),
    );
    expect(wrapper.get('[data-testid="live-traffic-state-dead-one"]').text()).toBe('dead');
    expect(wrapper.get('[data-testid="live-traffic-state-dead-one"]').classes()).toContain('bad');
    expect(wrapper.get('[data-testid="live-traffic-state-unknown-one"]').text()).toBe('unknown');
  });

  it('reports a permission failure as such', async () => {
    const current = liveFetch(null);
    current.status = 403;
    const wrapper = mount(LiveTrafficView, { global: { plugins: [await testRouter()] } });
    mounted.push(wrapper);
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="live-traffic-state"]').attributes('data-state')).toBe(
        'permission-denied',
      ),
    );
  });
});
