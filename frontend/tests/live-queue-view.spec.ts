import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['messages.view', 'messages.send', 'smsc.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import LiveQueueView from '../src/views/LiveQueueView.vue';

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const liveSnapshot = (sourceStatus = 'ok') => ({
  observedAt: '2026-08-04T10:00:00Z',
  engine: {
    status: 'running',
    version: '1.8.3',
    uptimeSeconds: 197,
    smsQueuedOut: 4,
    smsQueuedIn: 1,
    dlrQueued: 2,
    storeSize: null,
  },
  binds: [
    {
      engineId: 'local-fake',
      name: 'FAKE:10000',
      status: 'connecting',
      queued: 7,
      failed: 2,
      sent: 40,
      received: 3,
      outboundRate: [0, 0, 0],
      inboundRate: [0, 0, 0],
      known: true,
      smscId: 'smsc-a',
      smscName: 'Fake A',
    },
    {
      engineId: 'local-fake-b',
      name: 'FAKE:10001',
      status: 'connecting',
      queued: 0,
      failed: 0,
      sent: 0,
      received: 0,
      outboundRate: [0, 0, 0],
      inboundRate: [0, 0, 0],
      known: true,
      smscId: 'smsc-b',
      smscName: 'Fake B',
    },
  ],
  spool: { queued: 1, oldestEpoch: 1754300000, bySmsc: [{ smscId: 'local-fake', count: 1 }] },
  source: { status: sourceStatus, detail: sourceStatus === 'ok' ? '' : 'admin port refused' },
});

const spoolPage = {
  items: [
    {
      id: '42',
      source: 'send_sms',
      sender: 'JKANNEL',
      receiver: '+256700000001',
      text: 'queued body',
      smscId: 'local-fake',
      timestamp: '2026-08-04T09:59:00Z',
      externalRef: null,
      status: 'queued',
      raw: { sql_id: '42', time: 1754300000, msgdata: 'queued body', smsc_id: 'local-fake' },
    },
  ],
  nextCursor: null,
  total: 1,
};

const messagePage = {
  items: [
    {
      id: '900',
      direction: 'MT',
      sender: 'JKANNEL',
      receiver: '+256700000001',
      text: 'failed body',
      smscId: 'local-fake',
      status: 'sent',
      deliveryStatus: 'failed',
      timestamp: '2026-08-04T09:50:00Z',
    },
    {
      id: '901',
      direction: 'DLR',
      sender: 'JKANNEL',
      receiver: '+256700000001',
      text: 'Message is undeliverable',
      smscId: 'local-fake',
      status: 'delivery_report',
      deliveryStatus: 'unknown',
      externalRef: 'corr-900',
      timestamp: '2026-08-04T09:51:00Z',
    },
    {
      id: '902',
      direction: 'MT',
      sender: 'JKANNEL',
      receiver: '+256700000002',
      text: 'delivered body',
      smscId: 'local-fake-b',
      status: 'sent',
      deliveryStatus: 'delivered',
      timestamp: '2026-08-04T09:52:00Z',
    },
  ],
  nextCursor: null,
  total: 3,
  counts: {
    delivered: 5,
    failed: 3,
    rejected: 1,
    buffered: 0,
    accepted: 0,
    pending: 2,
    unknown: 0,
    resendable: 4,
    inFlight: 2,
  },
  appliedStatus: 'resendable',
  source: { status: 'available', type: 'kamex-sqlbox' },
};

const smscPage = {
  items: [
    { id: 'smsc-a', name: 'Fake A', engine_id: 'local-fake' },
    { id: 'smsc-b', name: 'Fake B', engine_id: 'local-fake-b' },
  ],
};

function stubApi(overrides: Record<string, unknown> = {}, sourceStatus = 'ok') {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    for (const [fragment, payload] of Object.entries(overrides))
      if (path.includes(fragment)) return apiResponse(payload);
    if (path.includes('/queue-console/spool/reroute'))
      return apiResponse({
        requested: 1,
        rerouted: 1,
        skipped: 0,
        targetSmscId: 'local-fake-b',
        results: [{ sqlId: 42, rerouted: true }],
      });
    if (path.includes('/queue-console/resend'))
      return apiResponse({
        requested: 1,
        resent: 1,
        skipped: 0,
        targetSmscId: 'local-fake-b',
        results: [{ id: '900', sqlId: '1001', originalSmscId: 'local-fake' }],
      });
    if (path.includes('/queue-console/binds/'))
      return apiResponse({ accepted: true, detail: 'bind disabled' });
    if (path.includes('/queue-console/live')) return apiResponse(liveSnapshot(sourceStatus));
    if (path.includes('/queue-console/spool')) return apiResponse(spoolPage);
    if (path.includes('/queue-console/history')) return apiResponse(messagePage);
    if (path.includes('/messages')) return apiResponse(messagePage);
    if (path.includes('/smscs')) return apiResponse(smscPage);
    return apiResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

describe('Live queue console', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the engine strip and one card per bind with queue depth and status', async () => {
    stubApi();
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bind-card-local-fake"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="engine-queued-out"]').text()).toBe('4');
    expect(wrapper.get('[data-testid="engine-dlr-queued"]').text()).toBe('2');
    // The bind rows carry their counters inline now ("7 queued"), because four
    // cards of labelled zeros is what made this section 519px of mostly nothing.
    expect(wrapper.get('[data-testid="bind-queued-local-fake"]').text()).toContain('7');
    expect(wrapper.get('[data-testid="bind-status-local-fake"]').text()).toContain('connecting');
    expect(wrapper.get('[data-testid="bind-status-local-fake"]').classes()).toContain('warn');
    expect(wrapper.find('[data-testid="live-source-banner"]').exists()).toBe(false);
    wrapper.unmount();
  });

  /*
   * The screen was 3,202px tall in a 1,000px viewport: four independent working
   * areas stacked, so an operator scrolled past three of them to reach the
   * fourth, and the message log — the primary flow — started 1,080px down.
   *
   * These pin the two things that fixed it, because both are easy to undo by
   * accident: only one section renders at a time, and the engine strip is NOT
   * one of the sections.
   */
  it('shows one section at a time, and keeps the engine strip outside the tabs', async () => {
    stubApi();
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="bind-panel"]').exists()).toBe(true));

    const shown = (id: string) => {
      const el = wrapper.find(`[data-testid="${id}"]`);
      return el.exists() && !(el.element as HTMLElement).style.display.includes('none');
    };

    expect(shown('bind-panel')).toBe(true);
    expect(shown('log-panel')).toBe(false);
    expect(shown('spool-panel')).toBe(false);

    await wrapper.get('[data-testid="queue-tab-log"]').trigger('click');
    expect(shown('log-panel')).toBe(true);
    expect(shown('bind-panel')).toBe(false);

    // Context for every tab, so it must not be hidden behind one of them.
    expect(wrapper.find('[data-testid="engine-strip"]').exists()).toBe(true);
    wrapper.unmount();
  });

  /*
   * `GET /queue-console/history` has always accepted a cursor and returned a
   * nextCursor; the screen sent neither, so the log showed one page and had no
   * control that could reach the row after it.
   */
  it('pages the message log with the cursor the API already returned', async () => {
    // The history page must advertise a next cursor, or there is nothing to
    // page to — which is also why Next stays disabled on the last page.
    const fetchMock = stubApi({
      '/queue-console/history': { items: [], nextCursor: 4242, total: 250, counts: {} },
    });
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="log-pager"]').exists()).toBe(true));

    // Page one: nothing to go back to.
    expect((wrapper.get('[data-testid="log-prev"]').element as HTMLButtonElement).disabled).toBe(
      true,
    );
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="log-next"]').element as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    await wrapper.get('[data-testid="log-next"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes('/queue-console/history') &&
            String(call[0]).includes('cursor='),
        ),
      ).toBe(true),
    );
    wrapper.unmount();
  });

  /*
   * A bind an operator disabled and a bind whose carrier is refusing BOTH
   * report `dead` from the engine. The console showed the same red badge for
   * each, so "is this my doing or an incident?" could not be answered from the
   * screen — which is exactly what was reported.
   */
  it('tells a bind we disabled apart from one that is simply down', async () => {
    stubApi({
      '/queue-console/live': {
        observedAt: '2026-09-29T00:00:00.000Z',
        engine: { smsQueuedOut: 0, smsQueuedIn: 0, dlrQueued: 0 },
        binds: [
          {
            engineId: 'off-bind',
            name: 'FAKE:1',
            status: 'dead',
            smscName: 'Turned Off',
            enabled: false,
          },
          {
            engineId: 'sick-bind',
            name: 'FAKE:2',
            status: 'dead',
            smscName: 'Actually Down',
            enabled: true,
          },
        ],
        spool: { queued: 0, bySmsc: [] },
        source: { status: 'ok' },
      },
    });
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bind-card-off-bind"]').exists()).toBe(true),
    );

    // The disabled one says so, and is not dressed as a problem.
    expect(wrapper.find('[data-testid="bind-disabled-off-bind"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="bind-card-off-bind"]').classes()).toContain('bind-off');
    expect(wrapper.get('[data-testid="bind-card-off-bind"]').classes()).not.toContain('bind-alert');

    // The one that is genuinely down is the one flagged.
    expect(wrapper.find('[data-testid="bind-disabled-sick-bind"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="bind-card-sick-bind"]').classes()).toContain('bind-alert');

    // And the headline counts only what needs a human.
    expect(wrapper.get('[data-testid="bind-summary"]').text()).toContain('1 need attention');
    expect(wrapper.get('[data-testid="bind-summary"]').text()).toContain('1 disabled here');
    wrapper.unmount();
  });

  /**
   * The reported failure: "I queued a bulk send and it never appeared in the
   * queue." The spool shows only the pending tier, so a healthy engine leaves it
   * empty — the empty state has to say so, and point at where the traffic is.
   */
  it('explains that an empty spool is healthy and links to where traffic lands', async () => {
    stubApi({ '/queue-console/spool': { items: [], nextCursor: null, total: 0 } });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/messages', name: 'messages', component: { template: '<div />' } },
        { path: '/delivery-reports', name: 'dlr', component: { template: '<div />' } },
        { path: '/bulk-send', name: 'bulk-send', component: { template: '<div />' } },
      ],
    });
    await router.push('/');
    await router.isReady();
    const wrapper = mount(LiveQueueView, { global: { plugins: [router] } });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="spool-empty"]').exists()).toBe(true));
    const empty = wrapper.get('[data-testid="spool-empty"]');
    expect(empty.text()).toContain('An empty spool is healthy');
    expect(empty.text()).toContain('will not appear here');
    expect(empty.get('[data-testid="spool-empty-messages"]').attributes('href')).toBe('/messages');
    expect(empty.get('[data-testid="spool-empty-delivery"]').attributes('href')).toBe(
      '/delivery-reports',
    );
    expect(empty.get('[data-testid="spool-empty-bulk"]').attributes('href')).toBe('/bulk-send');
    wrapper.unmount();
  });

  it('warns honestly when the engine runtime is unreachable', async () => {
    stubApi({}, 'unavailable');
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="live-source-banner"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="live-source-banner"]').text()).toContain('unreachable');
    expect(wrapper.get('[data-testid="live-source-banner"]').text()).toContain(
      'Spool and message data',
    );
    wrapper.unmount();
  });

  it('defaults the log to resendable failures and resends the selection to another bind', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="log-row-900"]').exists()).toBe(true));

    // Only the failed message matches the default preset, and the preset count
    // comes from the scope-wide counts rather than the loaded page.
    expect(wrapper.find('[data-testid="log-row-902"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="log-preset-resendable"]').text()).toContain('4');
    expect(wrapper.get('[data-testid="log-preset-inflight"]').text()).toContain('2');
    expect(
      fetchMock.mock.calls.some((entry) =>
        String(entry[0]).includes('/queue-console/history?limit=100&status=resendable'),
      ),
    ).toBe(true);

    await wrapper.get('[data-testid="log-resend-target"]').setValue('local-fake-b');
    await wrapper.get('[data-testid="log-select-all"]').setValue(true);
    await wrapper.get('[data-testid="log-resend"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="log-resend-notice"]').exists()).toBe(true),
    );
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/queue-console/resend'),
    );
    expect(call).toBeDefined();
    expect(bodyOf(call!)).toEqual({ ids: ['900'], targetSmscId: 'local-fake-b' });
    expect(wrapper.get('[data-testid="log-resend-results"]').text()).toContain('1001');
    wrapper.unmount();
  });

  it('resends every message matching the filter, not just the loaded page', async () => {
    const fetchMock = stubApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="log-row-900"]').exists()).toBe(true));

    await wrapper.get('[data-testid="log-resend-target"]').setValue('local-fake-b');
    expect(wrapper.get('[data-testid="log-resend-matching"]').text()).toContain('4');
    await wrapper.get('[data-testid="log-resend-matching"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="log-resend-notice"]').exists()).toBe(true),
    );
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/queue-console/resend'),
    );
    expect(bodyOf(call!)).toEqual({
      filter: { status: 'resendable', limit: 500 },
      targetSmscId: 'local-fake-b',
    });
    wrapper.unmount();
  });

  it('falls back to the plain message list when the history endpoint is absent', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/queue-console/history'))
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404 }),
        );
      if (path.includes('/queue-console/live')) return apiResponse(liveSnapshot());
      if (path.includes('/queue-console/spool')) return apiResponse(spoolPage);
      if (path.includes('/messages')) return apiResponse(messagePage);
      if (path.includes('/smscs')) return apiResponse(smscPage);
      return apiResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="log-row-900"]').exists()).toBe(true));
    expect(fetchMock.mock.calls.some((entry) => String(entry[0]).includes('/messages?'))).toBe(
      true,
    );
    expect(wrapper.get('[data-testid="log-counts-note"]').text()).toContain('this page');
    expect(wrapper.find('[data-testid="log-unavailable"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('never lets a delivery receipt be selected for resend', async () => {
    stubApi();
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="log-row-900"]').exists()).toBe(true));
    await wrapper.get('[data-testid="log-status-filter"]').setValue('all');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="log-row-901"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="log-select-901"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="log-select-900"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('reroutes selected spool rows by numeric sql id and explains skipped messages', async () => {
    const fetchMock = stubApi({
      '/queue-console/spool/reroute': {
        requested: 1,
        rerouted: 0,
        skipped: 1,
        targetSmscId: 'local-fake-b',
        results: [
          {
            sqlId: 42,
            rerouted: false,
            code: 'SPOOL_ALREADY_DRAINED',
            reason: 'no longer in the spool: already handed to the engine',
          },
        ],
      },
    });
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="spool-row-42"]').exists()).toBe(true),
    );

    await wrapper.get('[data-testid="spool-select-42"]').setValue(true);
    await wrapper.get('[data-testid="spool-reroute-target"]').setValue('local-fake-b');
    await wrapper.get('[data-testid="spool-reroute"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="spool-notice"]').exists()).toBe(true),
    );
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/queue-console/spool/reroute'),
    );
    expect(bodyOf(call!)).toEqual({ sqlIds: [42], targetSmscId: 'local-fake-b' });
    expect(wrapper.get('[data-testid="spool-notice"]').text()).toContain('not an error');
    expect(wrapper.get('[data-testid="spool-skip-results"]').text()).toContain(
      'SPOOL_ALREADY_DRAINED',
    );
    wrapper.unmount();
  });

  it('confirms before disabling a single bind and posts the control operation', async () => {
    const fetchMock = stubApi();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bind-toggle-local-fake"]').exists()).toBe(true),
    );
    // The controls live behind the row's disclosure now. Rows are collapsed by
    // default because a bind's detail matters when you are looking INTO one,
    // and four expanded cards is what the section used to be.
    expect(wrapper.find('[data-testid="bind-disable-local-fake"]').exists()).toBe(false);
    await wrapper.get('[data-testid="bind-toggle-local-fake"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bind-disable-local-fake"]').exists()).toBe(true),
    );

    await wrapper.get('[data-testid="bind-disable-local-fake"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="bind-notice"]').exists()).toBe(true));

    expect(confirmSpy.mock.calls[0][0]).toContain('ONLY this one SMPP bind');
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/queue-console/binds/local-fake/control'),
    );
    expect(bodyOf(call!)).toEqual({ operation: 'disable' });
    wrapper.unmount();
  });

  it('polls the live endpoint on an interval and clears the timer on unmount', async () => {
    const fetchMock = stubApi();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bind-card-local-fake"]').exists()).toBe(true),
    );
    const liveCalls = () =>
      fetchMock.mock.calls.filter((entry) => String(entry[0]).includes('/queue-console/live'))
        .length;
    const initial = liveCalls();

    await wrapper.get('[data-testid="live-refresh"]').trigger('click');
    await vi.waitFor(() => expect(liveCalls()).toBeGreaterThan(initial));

    wrapper.unmount();
    expect(clearSpy).toHaveBeenCalled();
    const afterUnmount = liveCalls();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(liveCalls()).toBe(afterUnmount);
  });

  it('stops polling while the tab is hidden and resumes when it becomes visible', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(LiveQueueView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bind-card-local-fake"]').exists()).toBe(true),
    );
    const liveCalls = () =>
      fetchMock.mock.calls.filter((entry) => String(entry[0]).includes('/queue-console/live'))
        .length;

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const whileHidden = liveCalls();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(liveCalls()).toBe(whileHidden);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(liveCalls()).toBeGreaterThan(whileHidden));
    wrapper.unmount();
  });
});
