import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['reports.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import DlrPerformanceView from '../src/views/DlrPerformanceView.vue';
import { setRangePreset } from '../src/stores/time-range';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

/** Verbatim from assessMaturity() in the backend, both signals firing. */
const WARNING =
  '100% of this window is inside the last 15 minutes and 74% of accepted messages have no receipt yet. ' +
  'Receipts arrive after submission, so the delivery rate for a window this recent is mechanically low and ' +
  'will rise on its own. Do not read it as a delivery failure — compare against a settled window before ' +
  'concluding anything.';

const funnel = (over: Record<string, number> = {}) => ({
  submitted: 1000,
  accepted: 1000,
  receiptsReceived: 900,
  delivered: 850,
  failed: 40,
  expired: 0,
  rejected: 10,
  pending: 100,
  unknown: 0,
  ...over,
});

const quality = (over: Record<string, unknown> = {}) => ({
  funnel: funnel(),
  deliveryRate: 0.944,
  deliveryRateIncludingPending: 0.85,
  noReceiptRate: 0.1,
  maturity: { immature: false, pendingShare: 0.1, windowOverlapShare: 0, warning: null },
  ...over,
});

const report = (over: Record<string, unknown> = {}) => ({
  from: '2026-08-16T09:30:00.000Z',
  to: '2026-08-17T09:30:00.000Z',
  overall: quality(),
  byBind: [
    {
      engineId: 'mtn-p1',
      smscName: 'MTN Primary',
      carrierId: 'c1',
      carrierName: 'MTN Uganda',
      quality: quality(),
    },
  ],
  available: true,
  detail: 'Read from the engine message store.',
  ...over,
});

/**
 * Each view watches the shared range, so a wrapper left mounted would re-fetch
 * on the next test's range change. Unmounting keeps the tests independent.
 */
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

const mountView = async (body: unknown, status = 200) => {
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
      { path: '/dlr-performance', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
      { path: '/carriers/:id', component: { template: '<p/>' } },
    ],
  });
  await router.push('/dlr-performance');
  await router.isReady();
  const wrapper = mount(DlrPerformanceView, { global: { plugins: [router] } });
  mounted.push(wrapper);
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, calls };
};

/**
 * §8's single UI requirement: "Make DLR maturity/window warnings prominent to
 * avoid false incident conclusions."
 */
describe('DLR Performance — the maturity warning', () => {
  it('renders the warning verbatim, as an alert, ABOVE every figure', async () => {
    const { wrapper } = await mountView(
      report({
        overall: quality({
          maturity: {
            immature: true,
            pendingShare: 0.74,
            windowOverlapShare: 1,
            warning: WARNING,
          },
        }),
      }),
    );
    const banner = wrapper.get('[data-testid="dlr-maturity-warning"]');
    expect(banner.attributes('role')).toBe('alert');
    expect(wrapper.get('[data-testid="dlr-maturity-text"]').text()).toBe(WARNING);

    // Prominence is positional: the banner must precede the delivery rates in
    // document order, not sit under them or hide in a tooltip.
    const html = wrapper.html();
    expect(html.indexOf('dlr-maturity-warning')).toBeLessThan(html.indexOf('dlr-rate-settled'));
    expect(html.indexOf('dlr-maturity-warning')).toBeLessThan(html.indexOf('dlr-funnel-panel'));
  });

  it('is absent on a settled window', async () => {
    const { wrapper } = await mountView(report());
    expect(wrapper.find('[data-testid="dlr-maturity-warning"]').exists()).toBe(false);
  });

  it('marks the individual binds whose own window has not settled', async () => {
    const { wrapper } = await mountView(
      report({
        byBind: [
          {
            engineId: 'settled',
            smscName: 'Settled',
            carrierId: null,
            carrierName: null,
            quality: quality(),
          },
          {
            engineId: 'fresh',
            smscName: 'Fresh',
            carrierId: null,
            carrierName: null,
            quality: quality({
              maturity: {
                immature: true,
                pendingShare: 0.8,
                windowOverlapShare: 1,
                warning: WARNING,
              },
            }),
          },
        ],
      }),
    );
    expect(wrapper.get('[data-testid="dlr-bind-maturity-fresh"]').text()).toBe(
      'too recent to judge',
    );
    expect(
      wrapper.get('[data-testid="dlr-bind-maturity-fresh"] .status-badge').attributes('title'),
    ).toBe(WARNING);
    expect(wrapper.get('[data-testid="dlr-bind-maturity-settled"]').text()).toBe('settled');
    expect(wrapper.get('[data-testid="dlr-bind-maturity-note"]').text()).toContain(
      'always make the unsettled one look worse',
    );
  });
});

describe('DLR Performance — both rates, always', () => {
  it('shows the settled and worst-case rates side by side, labelled by what they exclude', async () => {
    const { wrapper } = await mountView(report());
    expect(wrapper.get('[data-testid="dlr-rate-settled"]').text()).toBe('94.4%');
    expect(wrapper.get('[data-testid="dlr-rate-worst-case"]').text()).toBe('85.0%');
    expect(wrapper.get('[data-testid="dlr-rate-no-receipt"]').text()).toBe('10.0%');
    const pair = wrapper.get('[data-testid="dlr-rate-pair"]').text();
    expect(pair).toContain('messages still pending are left out');
    expect(pair).toContain('counted as a failure');
  });

  it('gives every bind both rates too, so waiting is not read as failing', async () => {
    const { wrapper } = await mountView(report());
    expect(wrapper.get('[data-testid="dlr-bind-settled-mtn-p1"]').text()).toBe('94.4%');
    expect(wrapper.get('[data-testid="dlr-bind-worst-mtn-p1"]').text()).toBe('85.0%');
  });

  it('renders a rate with no denominator as an em dash, never as 0%', async () => {
    const { wrapper } = await mountView(
      report({
        overall: quality({
          funnel: funnel({ delivered: 0, failed: 0, rejected: 0, pending: 1000 }),
          deliveryRate: null,
          deliveryRateIncludingPending: 0,
          noReceiptRate: 1,
        }),
      }),
    );
    expect(wrapper.get('[data-testid="dlr-rate-settled"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="dlr-rate-worst-case"]').text()).toBe('0.0%');
  });

  it('sorts the worst settled rate first without treating "unmeasured" as worst', async () => {
    const { wrapper } = await mountView(
      report({
        byBind: [
          {
            engineId: 'good',
            smscName: 'Good',
            carrierId: null,
            carrierName: null,
            quality: quality({ deliveryRate: 0.99 }),
          },
          {
            engineId: 'unmeasured',
            smscName: 'Unmeasured',
            carrierId: null,
            carrierName: null,
            quality: quality({ deliveryRate: null }),
          },
          {
            engineId: 'bad',
            smscName: 'Bad',
            carrierId: null,
            carrierName: null,
            quality: quality({ deliveryRate: 0.4 }),
          },
        ],
      }),
    );
    await wrapper.get('[data-testid="dlr-bind-sort"]').setValue('worst');
    const order = wrapper
      .get('[data-testid="dlr-bind-table"] tbody')
      .findAll('tr')
      .map((row) => row.attributes('data-testid'));
    expect(order).toEqual(['dlr-bind-bad', 'dlr-bind-good', 'dlr-bind-unmeasured']);
  });
});

describe('DLR Performance — window and honesty', () => {
  it('asks the API for the shared time range, as absolute instants', async () => {
    setRangePreset('1h');
    const { calls } = await mountView(report());
    const call = calls.find((url) => url.includes('/reports/dlr-performance')) ?? '';
    const parsed = new URL(call);
    const from = Date.parse(parsed.searchParams.get('from') ?? '');
    const to = Date.parse(parsed.searchParams.get('to') ?? '');
    expect(Number.isNaN(from)).toBe(false);
    expect(Math.round((to - from) / 60_000)).toBe(60);
    setRangePreset('24h');
  });

  it('re-reads when the shared range changes, so two screens never disagree', async () => {
    setRangePreset('24h');
    const { calls } = await mountView(report());
    const before = calls.length;
    setRangePreset('7d');
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    setRangePreset('24h');
  });

  it('refuses to print a zero for expiry the engine cannot distinguish', async () => {
    const { wrapper } = await mountView(report());
    const expired = wrapper.get('[data-testid="dlr-outcome-expired"]').text();
    expect(expired).toContain('not distinguishable');
    expect(expired).toContain('no expiry value');
    expect(expired).not.toMatch(/\b0\b/);
  });

  it('says the message store was unreadable rather than reporting no traffic', async () => {
    const detail = 'Delivery data unavailable: relation "sent_sms" does not exist';
    const { wrapper } = await mountView(
      report({
        available: false,
        detail,
        overall: quality({
          funnel: funnel({ submitted: 0, accepted: 0, delivered: 0, pending: 0 }),
          deliveryRate: null,
          deliveryRateIncludingPending: null,
          noReceiptRate: null,
          maturity: { immature: true, pendingShare: 0, windowOverlapShare: 1, warning: WARNING },
        }),
        byBind: [],
      }),
    );
    const block = wrapper.get('[data-testid="dlr-state"]');
    expect(block.attributes('data-state')).toBe('error');
    expect(wrapper.get('[data-testid="dlr-error"]').text()).toBe(detail);
    // No figures on the page, so the maturity banner would only bury the cause.
    expect(wrapper.find('[data-testid="dlr-maturity-warning"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="dlr-funnel-panel"]').exists()).toBe(false);
  });

  it('keeps its panels on an empty window, and says why every figure reads as it does', async () => {
    const { wrapper } = await mountView(
      report({
        overall: quality({
          funnel: funnel({
            submitted: 0,
            accepted: 0,
            delivered: 0,
            failed: 0,
            rejected: 0,
            pending: 0,
            receiptsReceived: 0,
          }),
          deliveryRate: null,
          deliveryRateIncludingPending: null,
          noReceiptRate: null,
        }),
        byBind: [],
      }),
    );
    /*
     * An empty window used to collapse the whole screen into one sentence,
     * taking five panels of structure with it — which is what made a working
     * screen read as a dead menu item.
     *
     * The notice still explains it. The panels stay, because they can show an
     * empty window honestly: a count of zero really is zero messages, and
     * `empty` is not an untrustworthy state so nothing is invented by leaving
     * them up.
     */
    const notice = wrapper.get('[data-testid="dlr-empty-notice"]');
    expect(notice.text()).toContain('No message was submitted in this window');
    expect(wrapper.find('[data-testid="dlr-funnel-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="dlr-carrier-panel"]').exists()).toBe(true);
    // And the rate in them is not a confident 0%. A delivery rate over zero
    // messages has no value, and 0% would read as a total delivery failure.
    const settled = wrapper.get('[data-testid="dlr-rate-settled"]').text();
    expect(settled).not.toContain('0%');
    expect(['—', 'unknown']).toContain(settled);
  });

  it('reports a permission failure as such', async () => {
    const { wrapper } = await mountView(null, 403);
    expect(wrapper.get('[data-testid="dlr-state"]').attributes('data-state')).toBe(
      'permission-denied',
    );
    expect(wrapper.get('[data-testid="dlr-state"]').text()).toContain('reports.view');
  });
});
