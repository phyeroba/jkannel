import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overlay, overlayHas } from './overlay';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['system.view']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import LogExplorerView from '../src/views/LogExplorerView.vue';

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const NOTICE =
  'In-memory ring buffer: newest-first, capped, and local to THIS process only. ' +
  'It is not durable — entries are lost on restart, are not shared between replicas, ' +
  'and older lines are evicted once the buffer wraps.';

const ENTRIES = [
  {
    timestamp: '2026-08-04T09:00:02Z',
    level: 'error',
    message: 'SMPP submit_sm rejected',
    context: 'SmscAdapter',
    correlationId: 'corr-abc-123',
    requestId: 'req-1',
    method: 'POST',
    route: '/api/v1/messages',
    status: 502,
    durationMs: 1204,
    tenantId: 't1',
    username: 'amina',
    trace: 'Error: rejected\n    at submit',
  },
  {
    timestamp: '2026-08-04T09:00:01Z',
    level: 'info',
    message: 'request completed',
    correlationId: 'corr-other',
    route: '/api/v1/alerts',
    status: 200,
    durationMs: 12,
  },
];

const result = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  matched: items.length,
  stored: 1000,
  capacity: 1000,
  dropped: 4210,
  oldest: '2026-08-04T08:55:00Z',
  newest: '2026-08-04T09:00:02Z',
  durable: false,
  scope: 'process',
  notice: NOTICE,
  ...extra,
});

const stubApi = (overrides: (url: string) => unknown = () => undefined) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const override = overrides(url);
    if (override !== undefined) return override;
    if (url.includes('correlationId=corr-abc-123'))
      return apiResponse(result([ENTRIES[0]], { matched: 1 }));
    return apiResponse(result(ENTRIES));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('Log explorer view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('states plainly that this is a non-durable, process-local ring buffer', async () => {
    stubApi();
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-row-0"]')).toBe(true));
    const warning = overlay(wrapper, '[data-testid="log-buffer-warning"]').text();
    expect(warning).toContain('not durable log storage');
    expect(warning).toContain('single API process');
    expect(warning).toContain('lost on restart');
    expect(warning).toContain('not shared between replicas');
    // The API's own notice is echoed, not paraphrased away.
    expect(overlay(wrapper, '[data-testid="log-buffer-notice"]').text()).toContain(
      'local to THIS process only',
    );
    // durable:false must never render as a durable claim.
    expect(overlayHas(wrapper, '[data-testid="log-buffer-durable"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="log-buffer-panel"]').text()).toContain('durable: no');
    wrapper.unmount();
  });

  it('reports buffer health including the lines already evicted', async () => {
    stubApi();
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-row-0"]')).toBe(true));
    expect(overlay(wrapper, '[data-testid="log-stored"]').text()).toBe('1000');
    expect(overlay(wrapper, '[data-testid="log-capacity"]').text()).toBe('1000');
    expect(overlay(wrapper, '[data-testid="log-dropped"]').text()).toBe('4210');
    expect(overlay(wrapper, '[data-testid="log-dropped-warning"]').text()).toContain(
      '4210 line(s) have already been evicted',
    );
    wrapper.unmount();
  });

  it('makes correlation-id search the primary control and traces from a row', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-row-0"]')).toBe(true));

    // One click on a row's correlation id re-queries for the whole trace.
    await overlay(wrapper, '[data-testid="log-trace-0"]').trigger('click');
    await vi.waitFor(() => {
      const listed = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(listed.some((url) => url.includes('correlationId=corr-abc-123'))).toBe(true);
    });
    expect(
      (overlay(wrapper, '[data-testid="log-correlation-id"]').element as HTMLInputElement).value,
    ).toBe('corr-abc-123');
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="log-active-filters"]').text()).toContain(
        'correlationId=corr-abc-123',
      ),
    );
    wrapper.unmount();
  });

  it('sends every filter to the API and shows a rejected one inline', async () => {
    const fetchMock = stubApi((url) =>
      url.includes('minLevel=warn')
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                success: false,
                message: 'minLevel must be one of trace, debug, info, warn, error, fatal',
              }),
              { status: 400 },
            ),
          )
        : undefined,
    );
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-row-0"]')).toBe(true));

    await overlay(wrapper, '[data-testid="log-route"]').setValue('/api/v1/messages');
    await overlay(wrapper, '[data-testid="log-contains"]').setValue('rejected');
    await overlay(wrapper, '[data-testid="log-apply"]').trigger('click');
    await vi.waitFor(() => {
      const listed = fetchMock.mock.calls.map((call) => String(call[0]));
      const call = listed.find((url) => url.includes('contains=rejected'));
      expect(call).toContain('route=%2Fapi%2Fv1%2Fmessages');
    });

    await overlay(wrapper, '[data-testid="log-min-level"]').setValue('warn');
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="log-error"]').text()).toContain(
        'minLevel must be one of trace, debug, info, warn, error, fatal',
      ),
    );
    wrapper.unmount();
  });

  it('does not read an empty result as proof the event never happened', async () => {
    stubApi(() => apiResponse(result([], { matched: 0 })));
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-empty"]')).toBe(true));
    const empty = overlay(wrapper, '[data-testid="log-empty"]').text();
    expect(empty).toContain('not proof the event did not happen');
    expect(empty).toContain('4210');
    wrapper.unmount();
  });

  it('warns when the match set is larger than the page returned', async () => {
    stubApi(() => apiResponse(result(ENTRIES, { matched: 940 })));
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-truncated"]')).toBe(true));
    expect(overlay(wrapper, '[data-testid="log-truncated"]').text()).toContain('940 entries match');
    wrapper.unmount();
  });

  it('opens one entry with its correlation id, route and trace', async () => {
    stubApi();
    const wrapper = mount(LogExplorerView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="log-row-0"]')).toBe(true));
    await overlay(wrapper, '[data-testid="log-row-0"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="log-entry-panel"]')).toBe(true),
    );
    const detail = overlay(wrapper, '[data-testid="log-entry-panel"]').text();
    expect(detail).toContain('corr-abc-123');
    expect(detail).toContain('POST /api/v1/messages');
    expect(detail).toContain('1204 ms');
    expect(overlay(wrapper, '[data-testid="log-entry-trace"]').text()).toContain('Error: rejected');
    wrapper.unmount();
  });
});
