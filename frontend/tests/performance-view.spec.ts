import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['smsc.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import PerformanceView from '../src/views/PerformanceView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const point = (at: string, outbound: number, peak = outbound) => ({
  at,
  outbound,
  inbound: 0,
  peakOutbound: peak,
  samples: 10,
});

const series = (overrides: Record<string, unknown> = {}) => ({
  points: [point('2026-08-21T09:00:00.000Z', 12), point('2026-08-21T09:05:00.000Z', 20, 44)],
  bucketSeconds: 300,
  windowMinutes: 360,
  ceiling: {
    effectiveTps: 50,
    contributingSmscs: 6,
    smscsWithoutCeiling: 0,
    connections: 6,
  },
  peakOutbound: 44,
  latestOutbound: 20,
  sampling: {
    intervalSeconds: 30,
    lastObservedAt: new Date().toISOString(),
    ageSeconds: 4,
    polls: 50,
  },
  limits: {
    unavailable: ['submit latency (API accept to engine handoff)'],
    reason:
      'Kannel reports counters, never per-message timings. Carrier latency is on DLR Performance.',
  },
  ...overrides,
});

const mountView = async (payload: unknown) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      calls.push(String(input));
      return envelope(payload);
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/performance', component: { template: '<p/>' } },
      { path: '/dlr-performance', component: { template: '<p/>' } },
    ],
  });
  await router.push('/performance');
  await router.isReady();
  const wrapper = mount(PerformanceView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, calls };
};

describe('Performance — capacity is measured, latency is not', () => {
  it('plots the series and reports headroom against the declared ceiling', async () => {
    const { wrapper, calls } = await mountView(series());
    expect(calls[0]).toContain('/performance/throughput?minutes=360');

    const metrics = wrapper.get('[data-testid="performance-metrics"]').text();
    expect(metrics).toContain('20/s'); // throughput now
    expect(metrics).toContain('44/s'); // window peak, the highest single poll
    expect(metrics).toContain('30/s'); // headroom: 50 declared less 20 observed
    expect(wrapper.get('[data-testid="performance-utilisation"]').text()).toBe('40%');
    expect(wrapper.get('[data-testid="performance-polls"]').text()).toBe('50');
  });

  it('names the latencies it cannot measure and points at the one it can', async () => {
    const { wrapper } = await mountView(series());
    const panel = wrapper.get('[data-testid="performance-latency"]');
    expect(panel.get('[data-testid="performance-latency-unavailable"]').text()).toContain(
      'submit latency',
    );
    // Without the pointer an operator reads "no latency here" as "none anywhere".
    const link = panel.findAll('a').find((a) => a.attributes('href') === '/dlr-performance');
    expect(link).toBeDefined();
  });

  it('keeps the ceiling but refuses to plot a window nothing polled', async () => {
    const { wrapper } = await mountView(
      series({
        points: [],
        peakOutbound: null,
        latestOutbound: null,
        sampling: { intervalSeconds: null, lastObservedAt: null, ageSeconds: null, polls: 0 },
      }),
    );
    const banner = wrapper.get('[data-testid="performance-state"]');
    // `partial`, not `empty`: the declared ceiling is still a true reading of
    // configuration, and blanking the screen would discard it.
    expect(banner.attributes('data-state')).toBe('partial');
    expect(banner.text()).toContain('No poll landed inside this window');
    // Headroom is unknown, NOT the whole ceiling. "All of it is free" and "we
    // did not look" must not render the same. A MetricCard renders its value
    // before its label, so the em dash immediately preceding "Headroom" is the
    // headroom figure itself — the "50/s declared" in the detail beneath it is
    // configuration, which IS known and is worth stating.
    const metrics = wrapper.get('[data-testid="performance-metrics"]').text();
    expect(metrics).toContain('—Headroom');
    expect(metrics).toContain('50/s declared across 6 connection(s)');
  });

  it('says nothing is declared rather than showing a zero ceiling', async () => {
    const { wrapper } = await mountView(
      series({
        ceiling: {
          effectiveTps: null,
          contributingSmscs: 0,
          smscsWithoutCeiling: 4,
          connections: 4,
        },
      }),
    );
    expect(wrapper.get('[data-testid="performance-ceiling-note"]').text()).toContain(
      'No connection in the estate declares a throughput ceiling',
    );
    expect(wrapper.get('[data-testid="performance-utilisation"]').text()).toBe('unknown');
  });

  it('warns that the total is a lower bound while any connection declares no ceiling', async () => {
    const { wrapper } = await mountView(
      series({
        ceiling: {
          effectiveTps: 50,
          contributingSmscs: 5,
          smscsWithoutCeiling: 1,
          connections: 6,
        },
      }),
    );
    expect(wrapper.get('[data-testid="performance-ceiling-note"]').text()).toContain('lower bound');
  });

  it('marks the chart stale only after several missed polls, not one', async () => {
    const fresh = await mountView(
      series({
        sampling: { intervalSeconds: 30, lastObservedAt: null, ageSeconds: 45, polls: 20 },
      }),
    );
    // One-and-a-half intervals is scheduler jitter; a banner here would be on
    // permanently and would teach people to ignore it.
    expect(fresh.wrapper.find('[data-testid="performance-stale"]').exists()).toBe(false);

    const stale = await mountView(
      series({
        sampling: { intervalSeconds: 30, lastObservedAt: null, ageSeconds: 300, polls: 20 },
      }),
    );
    expect(stale.wrapper.get('[data-testid="performance-stale"]').text()).toContain('not current');
    expect(stale.wrapper.get('[data-testid="performance-state"]').attributes('data-state')).toBe(
      'stale',
    );
  });

  it('re-reads with the chosen window', async () => {
    const { wrapper, calls } = await mountView(series());
    await wrapper.get('[data-testid="performance-range-1440"]').trigger('click');
    await flushPromises();
    expect(calls.some((url) => url.includes('minutes=1440'))).toBe(true);
  });
});
