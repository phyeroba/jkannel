import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overlay, overlayHas } from './overlay';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['routes.view', 'routes.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import RoutingDepthView from '../src/views/RoutingDepthView.vue';
import { session } from '../src/stores/session';

const grant = (...codes: string[]) => {
  (session as unknown as { value: { displayName: string; permissions: Set<string> } }).value = {
    displayName: 'Amina Operator',
    permissions: new Set(codes),
  };
};

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const SMSC_A = '11111111-1111-4111-8111-111111111111';
const SMSC_B = '22222222-2222-4222-8222-222222222222';

const weightedRoute = {
  id: 'route-1',
  name: 'UG weighted split',
  priority: 10,
  enabled: true,
  routeType: 'weighted',
  strategy: 'load-balance',
  matchPrefix: '25677',
  countryCode: '256',
  operator: 'MTN-UG',
  destinationPrefix: null,
  sender: null,
  cost: 0.012,
  targetSmscId: SMSC_A,
  fallbackSmscId: SMSC_B,
  window: { start: '08:00', end: '20:00', days: [1, 2, 3, 4, 5] },
  targets: [
    { id: 't1', smscId: SMSC_A, weight: 3, cost: 0.01, enabled: true },
    { id: 't2', smscId: SMSC_B, weight: 1, cost: 0.02, enabled: false },
  ],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
};

const stubApi = () => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/smscs'))
      return apiResponse({
        items: [
          { id: SMSC_A, name: 'Primary SMPP', engine_id: 'primary-smpp' },
          { id: SMSC_B, name: 'Backup SMPP', engine_id: 'backup-smpp' },
        ],
        total: 2,
      });
    if (url.includes('/routing/resolve'))
      return apiResponse({
        msisdn: '+256700000000',
        smscId: SMSC_A,
        routeId: 'route-1',
        routeName: 'UG weighted split',
        strategy: 'load-balance',
        fallbackUsed: false,
        reason: 'weighted split selected Primary SMPP',
        trace: ['matched prefix 25677', 'weighted split rotation 0 → Primary SMPP'],
        candidatesConsidered: 4,
      });
    if (/\/routing\/routes\/route-1\/versions\/2$/.test(url))
      return apiResponse({
        id: 'v2',
        route_id: 'route-1',
        version: 2,
        definition: { name: 'UG weighted split', priority: 10 },
        reason: 'weights rebalanced',
        created_by: 'amina',
        created_at: 't1',
      });
    if (url.includes('/routing/routes/route-1/versions'))
      return apiResponse({
        items: [
          {
            id: 'v2',
            version: 2,
            reason: 'weights rebalanced',
            created_by: 'amina',
            created_at: 't1',
          },
          { id: 'v1', version: 1, reason: 'created', created_by: 'amina', created_at: 't0' },
        ],
      });
    if (url.includes('/routing/routes') && init?.method) return apiResponse({ id: 'route-2' });
    if (url.includes('/routing/routes'))
      return apiResponse({ items: [weightedRoute], total: 1, limit: 25, offset: 0 });
    return apiResponse({ items: [], total: 0 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

describe('Advanced routing view', () => {
  beforeEach(() => {
    grant('routes.view', 'routes.manage');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the real routing columns, resolving SMSC ids to names', async () => {
    stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="route-row-route-1"]')).toBe(true),
    );
    const row = overlay(wrapper, '[data-testid="route-row-route-1"]').text();
    expect(row).toContain('weighted');
    expect(row).toContain('load-balance');
    expect(row).toContain('prefix 25677');
    expect(row).toContain('country +256');
    expect(row).toContain('operator MTN-UG');
    // Target ids are shown as SMSC names, and the disabled target is marked.
    expect(row).toContain('Primary SMPP (primary-smpp) ×3');
    expect(row).toContain('Backup SMPP (backup-smpp) ×1 (off)');
    expect(row).toContain('08:00–20:00 Mon,Tue,Wed,Thu,Fri');
    wrapper.unmount();
  });

  it('sends type, strategy and enabled filters as server-side grid parameters', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="route-row-route-1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="route-filter-type"]').setValue('prefix');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('filter.routeType=prefix')),
      ).toBe(true),
    );
    await overlay(wrapper, '[data-testid="route-filter-strategy"]').setValue('least-cost');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('filter.strategy=least-cost')),
      ).toBe(true),
    );
    const last = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(last).toContain('sort=priority');
    expect(last).toContain('limit=25');
    wrapper.unmount();
  });

  it('creates a weighted route with its targets and window in one payload', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="route-create"]')).toBe(true));
    await overlay(wrapper, '[data-testid="route-create"]').trigger('click');
    await overlay(wrapper, '[data-testid="route-name"]').setValue('Split MTN');
    await overlay(wrapper, '[data-testid="route-priority"]').setValue('20');
    await overlay(wrapper, '[data-testid="route-type"]').setValue('weighted');
    await overlay(wrapper, '[data-testid="route-strategy"]').setValue('round-robin');
    await overlay(wrapper, '[data-testid="route-target"]').setValue(SMSC_A);
    await overlay(wrapper, '[data-testid="route-fallback"]').setValue(SMSC_B);
    await overlay(wrapper, '[data-testid="route-window-start"]').setValue('08:00');
    await overlay(wrapper, '[data-testid="route-window-end"]').setValue('20:00');
    await overlay(wrapper, '[data-testid="route-target-add"]').trigger('click');
    await overlay(wrapper, '[data-testid="route-target-smsc-0"]').setValue(SMSC_A);
    await overlay(wrapper, '[data-testid="route-target-weight-0"]').setValue('4');
    await overlay(wrapper, '[data-testid="route-save"]').trigger('click');

    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/routing/routes') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = bodyOf(post);
      expect(body.name).toBe('Split MTN');
      expect(body.priority).toBe(20);
      expect(body.routeType).toBe('weighted');
      expect(body.strategy).toBe('round-robin');
      expect(body.targetSmscId).toBe(SMSC_A);
      expect(body.fallbackSmscId).toBe(SMSC_B);
      expect(body.windowStart).toBe('08:00');
      expect(body.windowEnd).toBe('20:00');
      expect(body.targets).toEqual([{ smscId: SMSC_A, weight: 4, enabled: true }]);
    });
    wrapper.unmount();
  });

  it('refuses a weighted route with no targets rather than letting the API 400', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="route-create"]')).toBe(true));
    await overlay(wrapper, '[data-testid="route-create"]').trigger('click');
    await overlay(wrapper, '[data-testid="route-name"]').setValue('No targets');
    await overlay(wrapper, '[data-testid="route-type"]').setValue('weighted');
    await overlay(wrapper, '[data-testid="route-target"]').setValue(SMSC_A);
    // Switching to weighted surfaces one empty target row; leaving it unset
    // must be caught here rather than by a 400 from the API.
    expect(overlayHas(wrapper, '[data-testid="route-target-0"]')).toBe(true);
    await overlay(wrapper, '[data-testid="route-save"]').trigger('click');
    expect(overlay(wrapper, '[data-testid="route-form-error"]').text()).toContain(
      'at least one target SMSC',
    );
    expect(
      fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
    wrapper.unmount();
  });

  it('previews a route decision with its full explain trace', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="resolve-run"]')).toBe(true));
    await overlay(wrapper, '[data-testid="resolve-msisdn"]').setValue('+256700000000');
    await overlay(wrapper, '[data-testid="resolve-rotation"]').setValue('2');
    await overlay(wrapper, '[data-testid="resolve-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="resolve-result"]')).toBe(true),
    );
    const post = fetchMock.mock.calls.find((call) => String(call[0]).includes('/routing/resolve'));
    expect(bodyOf(post)).toEqual({ msisdn: '+256700000000', rotation: 2 });
    expect(overlay(wrapper, '[data-testid="resolve-smsc"]').text()).toBe(
      'Primary SMPP (primary-smpp)',
    );
    expect(overlay(wrapper, '[data-testid="resolve-trace"]').text()).toContain(
      'matched prefix 25677',
    );
    expect(overlay(wrapper, '[data-testid="resolve-reason"]').text()).toContain('weighted split');
    wrapper.unmount();
  });

  it('opens route version history and shows a stored definition', async () => {
    stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="route-versions-route-1"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="route-versions-route-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="route-version-2"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="route-version-2"]').text()).toContain(
      'weights rebalanced',
    );
    await overlay(wrapper, '[data-testid="route-version-view-2"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="route-version-definition"]').text()).toContain(
        'UG weighted split',
      ),
    );
    wrapper.unmount();
  });

  it('hides route mutations from an operator without routes.manage', async () => {
    grant('routes.view');
    stubApi();
    const wrapper = mount(RoutingDepthView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="route-row-route-1"]')).toBe(true),
    );
    expect(overlayHas(wrapper, '[data-testid="route-create"]')).toBe(false);
    expect(overlayHas(wrapper, '[data-testid="route-edit-route-1"]')).toBe(false);
    expect(overlayHas(wrapper, '[data-testid="route-archive-route-1"]')).toBe(false);
    // History and the resolve preview stay available on routes.view.
    expect(overlayHas(wrapper, '[data-testid="route-versions-route-1"]')).toBe(true);
    expect(overlay(wrapper, '[data-testid="routing-depth-readonly"]').text()).toContain(
      'routes.manage',
    );
    wrapper.unmount();
  });
});
