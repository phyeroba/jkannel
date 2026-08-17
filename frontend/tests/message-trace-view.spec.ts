import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['messages.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import MessageTraceView from '../src/views/MessageTraceView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

type Stage = {
  kind: string;
  label: string;
  status: string;
  at: string | null;
  latencyMs: number | null;
  detail: string;
  facts: Record<string, string | number | null>;
};

const routed: Stage = {
  kind: 'routed',
  label: 'Route selected',
  status: 'ok',
  at: '2026-08-17T09:00:00.000Z',
  latencyMs: null,
  detail: 'Matched route MTN direct.',
  facts: {
    route: 'MTN direct',
    strategy: 'priority',
    chosenBind: 'mtn-p1',
    requestedBind: null,
    candidatesConsidered: 3,
    contentRule: null,
  },
};

const submitted: Stage = {
  kind: 'submitted',
  label: 'Handed to the carrier',
  status: 'ok',
  at: '2026-08-17T09:00:00.420Z',
  latencyMs: 420,
  detail: 'The engine accepted the message and submitted it on the bind below.',
  facts: { bind: 'mtn-p1' },
};

const pendingReceipt: Stage = {
  kind: 'receipt',
  label: 'Delivery receipt',
  status: 'pending',
  at: null,
  latencyMs: null,
  detail:
    'No delivery receipt has arrived yet. That is not a failure: receipts follow submission, and some carriers never send one.',
  facts: { status: 'pending', receipts: 0 },
};

const failedReceipt: Stage = {
  kind: 'receipt',
  label: 'Delivery receipt',
  status: 'failed',
  at: '2026-08-17T09:02:00.000Z',
  latencyMs: 119_580,
  detail: 'The carrier reported failed.',
  facts: { status: 'failed', receipts: 2 },
};

const trace = (overrides: Record<string, unknown> = {}) => ({
  id: 'kmx-0001',
  available: true,
  detail: 'Read from the engine message store.',
  events: [{ source: 'send_sms', timestamp: '2026-08-17T09:00:00.000Z' }],
  lifecycle: {
    stages: [routed, submitted, pendingReceipt],
    totalMs: 420,
    firstProblem: null,
    inFlight: true,
  },
  ...overrides,
});

const mountView = async (payload: unknown, path = '/message-trace?id=kmx-0001') => {
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
      { path: '/message-trace', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(MessageTraceView, { global: { plugins: [router] } });
  // `onMounted` fires after the first render, so the loading state is not in
  // the DOM yet at this point — flush before waiting on it, or the wait passes
  // against a screen that has not started reading.
  await flushPromises();
  await vi.waitFor(() => {
    // DataState renders nothing at all when the state is `live`, so an absent
    // banner is the success case rather than a missing element.
    const banner = wrapper.find('[data-testid="trace-state"]');
    expect(banner.exists() ? banner.attributes('data-state') : 'live').not.toBe('loading');
  });
  return { wrapper, calls };
};

describe('Message Trace — the first problem is not left to be found', () => {
  it('puts firstProblem above the timeline, in an alert region', async () => {
    const { wrapper } = await mountView(
      trace({
        lifecycle: {
          stages: [routed, submitted, failedReceipt],
          totalMs: 120_000,
          firstProblem: {
            kind: 'receipt',
            label: 'Delivery receipt',
            detail: 'The carrier reported failed.',
          },
          inFlight: false,
        },
      }),
    );
    const problem = wrapper.get('[data-testid="trace-first-problem"]');
    expect(problem.attributes('role')).toBe('alert');
    expect(problem.text()).toContain('First abnormal stage: Delivery receipt');
    expect(wrapper.get('[data-testid="trace-first-problem-detail"]').text()).toBe(
      'The carrier reported failed.',
    );
    // Above the timeline in document order, not buried inside it.
    const html = wrapper.html();
    expect(html.indexOf('trace-first-problem')).toBeLessThan(html.indexOf('trace-timeline'));
  });

  it('says so plainly when nothing went wrong, and distinguishes in-flight', async () => {
    const { wrapper } = await mountView(trace());
    expect(wrapper.find('[data-testid="trace-first-problem"]').exists()).toBe(false);
    const banner = wrapper.get('[data-testid="trace-no-problem"]').text();
    expect(banner).toContain('No stage went wrong.');
    expect(banner).toContain('still in flight');
  });
});

describe('Message Trace — a pending receipt is not a failure', () => {
  it('renders pending with a neutral badge and the waiting word, never a danger tone', async () => {
    const { wrapper } = await mountView(trace());
    const badge = wrapper.get('[data-testid="trace-status-receipt"]');
    expect(badge.text()).toBe('still waiting');
    expect(badge.classes()).toContain('muted');
    expect(badge.classes()).not.toContain('bad');
    expect(badge.classes()).not.toContain('warn');
    const stage = wrapper.get('[data-testid="trace-stage-receipt"]');
    expect(stage.classes()).toContain('tone-muted');
    expect(stage.attributes('data-status')).toBe('pending');
  });

  it('repeats in its own words that waiting is not failing', async () => {
    const { wrapper } = await mountView(trace());
    const note = wrapper.get('[data-testid="trace-pending-note-receipt"]').text();
    expect(note).toContain('Still waiting is not the same as failed');
    expect(note).toContain('some carriers never send one');
    // The API's own sentence is still there, verbatim.
    expect(wrapper.get('[data-testid="trace-stage-receipt"]').text()).toContain(
      'That is not a failure',
    );
  });

  it('gives a failed receipt the danger treatment, so the two never look alike', async () => {
    const { wrapper } = await mountView(
      trace({
        lifecycle: {
          stages: [routed, submitted, failedReceipt],
          totalMs: 120_000,
          firstProblem: { kind: 'receipt', label: 'Delivery receipt', detail: 'failed' },
          inFlight: false,
        },
      }),
    );
    expect(wrapper.get('[data-testid="trace-status-receipt"]').classes()).toContain('bad');
    expect(wrapper.get('[data-testid="trace-status-receipt"]').text()).toBe('failed');
  });
});

describe('Message Trace — null latency', () => {
  it('renders an unmeasurable latency as an em dash, never 0ms', async () => {
    const { wrapper } = await mountView(trace());
    // First stage: nothing to measure from.
    expect(wrapper.get('[data-testid="trace-latency-routed"]').text()).toBe('—');
    // Pending receipt: no timestamp on either side of the gap.
    expect(wrapper.get('[data-testid="trace-latency-receipt"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="trace-latency-submitted"]').text()).toBe('420ms');
    expect(wrapper.get('[data-testid="trace-at-receipt"]').text()).toBe('not yet');
    expect(wrapper.get('[data-testid="trace-latency-note"]').text()).toContain('never');
  });

  it('renders a null total as an em dash rather than a zero-length lifecycle', async () => {
    const { wrapper } = await mountView(
      trace({
        lifecycle: { stages: [routed], totalMs: null, firstProblem: null, inFlight: false },
      }),
    );
    expect(wrapper.get('[data-testid="trace-total"]').text()).toBe('—');
  });
});

describe('Message Trace — evidence and absence', () => {
  it('keeps the raw engine rows on the page, collapsed', async () => {
    const { wrapper } = await mountView(trace());
    const details = wrapper.get('[data-testid="trace-raw-details"]');
    expect(details.element.tagName.toLowerCase()).toBe('details');
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.get('[data-testid="trace-raw-json"]').text()).toContain('send_sms');
  });

  it('says a missing engine store is unreadable, not evidence the stage never happened', async () => {
    const { wrapper } = await mountView(
      trace({
        available: false,
        detail: 'Engine history unavailable: connection refused',
        events: [],
        lifecycle: { stages: [routed], totalMs: null, firstProblem: null, inFlight: false },
      }),
    );
    expect(wrapper.get('[data-testid="trace-state"]').attributes('data-state')).toBe('partial');
    const banner = wrapper.get('[data-testid="trace-engine-unavailable"]').text();
    expect(banner).toContain('could not be read');
    expect(banner).toContain('connection refused');
    expect(wrapper.get('[data-testid="trace-raw-empty"]').text()).toContain(
      'not evidence of absence',
    );
  });

  it('does not read a not-found id as proof the message never existed', async () => {
    const { wrapper } = await mountView(
      trace({
        events: [],
        lifecycle: { stages: [], totalMs: null, firstProblem: null, inFlight: false },
      }),
    );
    const empty = wrapper.get('[data-testid="trace-state"]');
    expect(empty.attributes('data-state')).toBe('empty');
    expect(empty.text()).toContain('not proof the message never existed');
  });

  it('asks nothing of the API until an id is supplied', async () => {
    const { wrapper, calls } = await mountView(trace(), '/message-trace');
    expect(calls).toHaveLength(0);
    expect(wrapper.get('[data-testid="trace-state"]').text()).toContain('Enter a message id');
  });

  it('links a bind fact to that connection and traces the id typed into the box', async () => {
    const { wrapper, calls } = await mountView(trace());
    expect(calls[0]).toContain('/diagnostics/messages/kmx-0001/lifecycle');
    const link = wrapper
      .findAll('a')
      .find((anchor) => anchor.attributes('href') === '/smsc/mtn-p1');
    expect(link).toBeDefined();

    await wrapper.get('[data-testid="trace-input"]').setValue('kmx-0002');
    await wrapper.get('[data-testid="trace-search-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(calls.some((url) => url.includes('/diagnostics/messages/kmx-0002/lifecycle'))).toBe(
        true,
      ),
    );
  });
});
