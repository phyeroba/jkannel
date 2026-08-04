import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['alerts.view', 'system.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import AlertResponseView from '../src/views/AlertResponseView.vue';
import { session } from '../src/stores/session';

const grant = (...codes: string[]) => {
  (session as unknown as { value: { displayName: string; permissions: Set<string> } }).value = {
    displayName: 'Amina Operator',
    permissions: new Set(codes),
  };
};

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

const policy = {
  id: 'pol-1',
  name: 'On-call tier 1',
  steps: [
    { afterMinutes: 5, channelType: 'email', target: 'noc@example.com' },
    { afterMinutes: 30, channelType: 'sms', target: '+256700000001', severity: 'critical' },
  ],
  enabled: true,
  created_by: 'amina',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
};

const past = new Date(Date.now() - 60 * 60_000).toISOString();
const future = new Date(Date.now() + 60 * 60_000).toISOString();
const activeWindow = {
  id: 'win-1',
  name: 'Carrier SMPP upgrade',
  starts_at: past,
  ends_at: future,
  scope: { all: true },
  reason: 'planned',
  created_by: 'amina',
};

const stubApi = (overrides: Record<string, unknown> = {}) => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/monitoring/escalation/policies') && init?.method)
      return apiResponse({ id: 'pol-1' });
    if (url.includes('/monitoring/escalation/policies')) return apiResponse([policy]);
    if (url.includes('/monitoring/maintenance/active')) return apiResponse([activeWindow]);
    if (url.includes('/monitoring/maintenance') && init?.method)
      return apiResponse({ id: 'win-1' });
    if (url.includes('/monitoring/maintenance')) return apiResponse([activeWindow]);
    if (url.includes('/monitoring/correlations'))
      return apiResponse([
        {
          correlation_group: 'smsc:local-fake',
          alert_count: 3,
          total_occurrences: 9,
          max_severity: 'critical',
          first_seen: 't0',
          last_seen: 't1',
        },
      ]);
    if (url.includes('/smscs'))
      return apiResponse({
        items: [{ id: 'smsc-1', name: 'Primary SMPP', engine_id: 'primary-smpp' }],
        total: 1,
      });
    return apiResponse(overrides.fallback ?? []);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

describe('Escalation & maintenance view', () => {
  beforeEach(() => {
    grant('alerts.view', 'system.manage');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists escalation policies with their step chain and the active maintenance banner', async () => {
    stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="policy-row-pol-1"]').exists()).toBe(true),
    );
    const row = wrapper.get('[data-testid="policy-row-pol-1"]').text();
    expect(row).toContain('On-call tier 1');
    expect(row).toContain('+5m → email noc@example.com');
    expect(row).toContain('+30m → sms +256700000001');
    expect(wrapper.get('[data-testid="maintenance-active-banner"]').text()).toContain(
      'Carrier SMPP upgrade',
    );
    expect(wrapper.get('[data-testid="correlation-row-smsc:local-fake"]').text()).toContain(
      'critical',
    );
    wrapper.unmount();
  });

  it('creates an escalation policy from the step editor', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="policy-create"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="policy-create"]').trigger('click');
    await wrapper.get('[data-testid="policy-name"]').setValue('Weekend rota');
    await wrapper.get('[data-testid="policy-step-after-0"]').setValue('10');
    await wrapper.get('[data-testid="policy-step-channel-0"]').setValue('webhook');
    await wrapper.get('[data-testid="policy-step-target-0"]').setValue('https://hooks.example/x');
    await wrapper.get('[data-testid="policy-save"]').trigger('click');

    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/monitoring/escalation/policies') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toEqual({
        name: 'Weekend rota',
        steps: [{ afterMinutes: 10, channelType: 'webhook', target: 'https://hooks.example/x' }],
        enabled: true,
      });
    });
    wrapper.unmount();
  });

  it('refuses a step with no target rather than posting an invalid policy', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="policy-create"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="policy-create"]').trigger('click');
    await wrapper.get('[data-testid="policy-name"]').setValue('Broken');
    await wrapper.get('[data-testid="policy-save"]').trigger('click');
    expect(wrapper.get('[data-testid="policy-form-error"]').text()).toContain('needs a target');
    expect(
      fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
    wrapper.unmount();
  });

  it('schedules a maintenance window with an ISO range and an explicit scope', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="maintenance-create"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="maintenance-create"]').trigger('click');
    await wrapper.get('[data-testid="maintenance-name"]').setValue('Router swap');
    await wrapper.get('[data-testid="maintenance-starts"]').setValue('2026-09-01T01:00');
    await wrapper.get('[data-testid="maintenance-ends"]').setValue('2026-09-01T03:00');
    await wrapper.get('[data-testid="maintenance-save"]').trigger('click');

    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/monitoring/maintenance') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = bodyOf(post);
      expect(body.name).toBe('Router swap');
      expect(body.scope).toEqual({ all: true });
      expect(new Date(body.startsAt).getTime()).toBe(new Date('2026-09-01T01:00').getTime());
      expect(new Date(body.endsAt).getTime()).toBeGreaterThan(new Date(body.startsAt).getTime());
    });
    wrapper.unmount();
  });

  it('rejects an end time that is not after the start time', async () => {
    stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="maintenance-create"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="maintenance-create"]').trigger('click');
    await wrapper.get('[data-testid="maintenance-name"]').setValue('Backwards');
    await wrapper.get('[data-testid="maintenance-starts"]').setValue('2026-09-01T05:00');
    await wrapper.get('[data-testid="maintenance-ends"]').setValue('2026-09-01T04:00');
    await wrapper.get('[data-testid="maintenance-save"]').trigger('click');
    expect(wrapper.get('[data-testid="maintenance-form-error"]').text()).toContain(
      'end time must be after',
    );
    wrapper.unmount();
  });

  it('hides every mutation and says why when the operator lacks system.manage', async () => {
    grant('alerts.view');
    stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="policy-row-pol-1"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="policy-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="maintenance-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="policy-edit-pol-1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="alert-response-readonly"]').text()).toContain(
      'system.manage',
    );
    wrapper.unmount();
  });

  it('reports an absent monitoring-depth API plainly instead of rendering an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ success: false, message: 'Not found' }), { status: 404 }),
          ),
        ),
    );
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="policy-error"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="policy-error"]').text()).toContain('not available');
    expect(wrapper.get('[data-testid="maintenance-error"]').text()).toContain('not available');
    wrapper.unmount();
  });
});
