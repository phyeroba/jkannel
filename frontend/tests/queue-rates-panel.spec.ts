import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['messages.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import QueueRatesPanel from '../src/components/QueueRatesPanel.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const NOTES = [
  "Per-destination depth is bearerbox's internal queue for that bind. The engine reports it only as a counter — individual messages inside it cannot be listed, reordered or cancelled. The SQLBox spool above is the tier JKANNEL can act on.",
  'Ingress is inferred from the change in depth against measured egress, not observed directly: nothing in the engine counts arrivals.',
];

const destination = (engineId: string, over: Record<string, unknown> = {}) => ({
  engineId,
  smscName: engineId.toUpperCase(),
  carrierId: null,
  carrierName: null,
  bindState: 'bound',
  depth: 120,
  ingressPerSecond: 5,
  egressPerSecond: 4,
  growthPerSecond: 1,
  drainSeconds: 30,
  drainUnavailableReason: null,
  windowSeconds: 900,
  samples: 6,
  resetsDetected: 0,
  oldestSpoolAgeSeconds: null,
  ...over,
});

const overview = (
  destinations: ReturnType<typeof destination>[],
  over: Record<string, unknown> = {},
) => ({
  observedAt: '2026-08-17T09:30:00Z',
  windowMinutes: 15,
  destinations,
  spool: {
    queued: 3,
    oldestAgeSeconds: 45,
    available: true,
    detail: 'Read from the SQLBox spool.',
  },
  notes: NOTES,
  ...over,
});

const mountPanel = async (body: unknown, status = 200) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      calls.push(String(input));
      if (status !== 200)
        return Promise.resolve(new Response('{"success":false,"message":"nope"}', { status }));
      return envelope(body);
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/queues', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
      { path: '/carriers/:id', component: { template: '<p/>' } },
    ],
  });
  await router.push('/queues');
  await router.isReady();
  const wrapper = mount(QueueRatesPanel, { global: { plugins: [router] } });
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, calls };
};

describe('Queue rates — the drain estimate that is not one', () => {
  it('renders drainUnavailableReason verbatim rather than a symbol', async () => {
    const reason = 'Nothing is leaving this queue, so it will not drain at the current rate.';
    const { wrapper } = await mountPanel(
      overview([
        destination('mtn-p1', {
          egressPerSecond: 0,
          drainSeconds: null,
          drainUnavailableReason: reason,
        }),
      ]),
    );
    const cell = wrapper.get('[data-testid="queue-drain-mtn-p1"]');
    expect(cell.text()).toContain(reason);
    expect(cell.text()).toContain('unavailable');
    expect(cell.text()).not.toContain('∞');
    expect(cell.text()).not.toContain('Infinity');
    expect(cell.text()).not.toContain('0s');
  });

  it('keeps the four causes distinct instead of collapsing them to "unavailable"', async () => {
    const stalled = 'Nothing is leaving this queue, so it will not drain at the current rate.';
    const restarted =
      'The engine restarted during this window, so the measured rate is not a reliable basis for an estimate.';
    const volatile =
      'Throughput is varying too much across this window for a drain estimate to mean anything.';
    const { wrapper } = await mountPanel(
      overview([
        destination('a-stalled', { drainSeconds: null, drainUnavailableReason: stalled }),
        destination('b-restart', {
          drainSeconds: null,
          drainUnavailableReason: restarted,
          resetsDetected: 2,
        }),
        destination('c-volatile', { drainSeconds: null, drainUnavailableReason: volatile }),
      ]),
    );
    expect(wrapper.get('[data-testid="queue-drain-a-stalled"]').text()).toContain(stalled);
    expect(wrapper.get('[data-testid="queue-drain-b-restart"]').text()).toContain(restarted);
    expect(wrapper.get('[data-testid="queue-drain-c-volatile"]').text()).toContain(volatile);
    expect(wrapper.get('[data-testid="queue-coverage-b-restart"]').text()).toContain(
      '2 engine restart(s) discarded',
    );
  });

  it('shows a real estimate when the backend returned one', async () => {
    const { wrapper } = await mountPanel(overview([destination('mtn-p1', { drainSeconds: 90 })]));
    const cell = wrapper.get('[data-testid="queue-drain-mtn-p1"]');
    expect(cell.text()).toContain('about 1m 30s');
    expect(cell.text()).toContain('estimated');
  });
});

describe('Queue rates — a rate nobody measured is not zero', () => {
  it('renders null rates as an em dash, never as 0/s', async () => {
    const { wrapper } = await mountPanel(
      overview([
        destination('quiet', {
          depth: null,
          ingressPerSecond: null,
          egressPerSecond: null,
          growthPerSecond: null,
          drainSeconds: null,
          drainUnavailableReason: 'No observations in the window.',
          samples: 0,
          windowSeconds: null,
        }),
      ]),
    );
    expect(wrapper.get('[data-testid="queue-ingress-quiet"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="queue-egress-quiet"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="queue-growth-quiet"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="queue-depth-quiet"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="queue-oldest-quiet"]').text()).toBe('—');
  });

  it('blanks the spool figures and names the cause when the spool is unreadable', async () => {
    const detail = 'SQLBox spool unreadable: relation "send_sms" does not exist';
    const { wrapper } = await mountPanel(
      overview([destination('mtn-p1')], {
        spool: { queued: 0, oldestAgeSeconds: null, available: false, detail },
      }),
    );
    expect(wrapper.get('[data-testid="queue-rates-spool-queued"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="queue-rates-spool-oldest"]').text()).toBe('—');
    const banner = wrapper.get('[data-testid="queue-rates-spool-unavailable"]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain(detail);
    // Partial, not live: the rows are still usable and stay on screen.
    expect(wrapper.get('[data-testid="queue-rates-state"]').attributes('data-state')).toBe(
      'partial',
    );
    expect(wrapper.find('[data-testid="queue-rate-mtn-p1"]').exists()).toBe(true);
  });
});

describe('Queue rates — order, window and notes', () => {
  it('holds row order steady even though the API ranks by depth, until ranking is asked for', async () => {
    const { wrapper } = await mountPanel(
      overview([
        // Exactly what the API sends: deepest first.
        destination('zulu', { depth: 900 }),
        destination('alpha', { depth: 10 }),
      ]),
    );
    const order = () =>
      wrapper.findAll('[data-testid^="queue-rate-"]').map((row) => row.attributes('data-testid'));
    expect(order()).toEqual(['queue-rate-alpha', 'queue-rate-zulu']);
    await wrapper.get('[data-testid="queue-rates-rank"]').setValue(true);
    expect(order()).toEqual(['queue-rate-zulu', 'queue-rate-alpha']);
  });

  it('sends the chosen window to the API and offers none the API would reject', async () => {
    const { wrapper, calls } = await mountPanel(overview([destination('mtn-p1')]));
    expect(calls.some((url) => url.includes('/queue-metrics?windowMinutes=15'))).toBe(true);
    const options = wrapper
      .get('[data-testid="queue-rates-window"]')
      .findAll('option')
      .map((option) => Number(option.element.value));
    expect(options.every((minutes) => minutes >= 1 && minutes <= 1440)).toBe(true);
    await wrapper.get('[data-testid="queue-rates-window"]').setValue('60');
    await vi.waitFor(() =>
      expect(calls.some((url) => url.includes('windowMinutes=60'))).toBe(true),
    );
  });

  it("renders the API's own caveats rather than paraphrasing them", async () => {
    const { wrapper } = await mountPanel(overview([destination('mtn-p1')]));
    const notes = wrapper
      .get('[data-testid="queue-rates-notes"]')
      .findAll('li')
      .map((item) => item.text());
    expect(notes).toEqual(NOTES);
  });

  it('reports a permission failure as such, not as an empty queue', async () => {
    const { wrapper } = await mountPanel(null, 403);
    expect(wrapper.get('[data-testid="queue-rates-state"]').attributes('data-state')).toBe(
      'permission-denied',
    );
    expect(wrapper.get('[data-testid="queue-rates-state"]').text()).toContain('messages.view');
  });

  it('explains an empty result instead of showing a table of zeros', async () => {
    const { wrapper } = await mountPanel(overview([]));
    const block = wrapper.get('[data-testid="queue-rates-state"]');
    expect(block.attributes('data-state')).toBe('empty');
    expect(block.text()).toContain('at least two observations');
    expect(wrapper.find('[data-testid="queue-rates-table"]').exists()).toBe(false);
  });
});
