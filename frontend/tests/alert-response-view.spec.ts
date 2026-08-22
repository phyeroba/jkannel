import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overlay, overlayAll, overlayHas } from './overlay';

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

/** A fresh install: dashboard works, email/webhook were never configured. */
const readiness = {
  tenantId: 't1',
  channels: [
    { id: 'ch-1', name: 'Default dashboard', type: 'dashboard', enabled: true, deliverable: true },
    {
      id: 'ch-2',
      name: 'NOC mailbox',
      type: 'email',
      enabled: true,
      deliverable: false,
      reason: 'SMTP_URL is not configured',
    },
  ],
  deliverableChannels: 1,
  openAlerts: 3,
  undeliverableAlerts: 2,
  unnotifiedAlerts: 1,
  escalationPolicies: 1,
  warning: '2 open alert(s) had an escalation step that could not be delivered.',
};

const stubApi = (overrides: Record<string, unknown> = {}) => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/monitoring/notifications/readiness/repair'))
      return apiResponse({ channel: true, policy: false, readiness });
    if (url.includes('/monitoring/notifications/readiness'))
      return apiResponse(overrides.readiness ?? readiness);
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
      expect(overlayHas(wrapper, '[data-testid="policy-row-pol-1"]')).toBe(true),
    );
    const row = overlay(wrapper, '[data-testid="policy-row-pol-1"]').text();
    expect(row).toContain('On-call tier 1');
    expect(row).toContain('+5m → email noc@example.com');
    expect(row).toContain('+30m → sms +256700000001');
    expect(overlay(wrapper, '[data-testid="maintenance-active-banner"]').text()).toContain(
      'Carrier SMPP upgrade',
    );
    expect(overlay(wrapper, '[data-testid="correlation-row-smsc:local-fake"]').text()).toContain(
      'critical',
    );
    wrapper.unmount();
  });

  it('creates an escalation policy from the step editor', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="policy-create"]')).toBe(true));
    await overlay(wrapper, '[data-testid="policy-create"]').trigger('click');
    await overlay(wrapper, '[data-testid="policy-name"]').setValue('Weekend rota');
    await overlay(wrapper, '[data-testid="policy-step-after-0"]').setValue('10');
    await overlay(wrapper, '[data-testid="policy-step-channel-0"]').setValue('webhook');
    await overlay(wrapper, '[data-testid="policy-step-target-0"]').setValue(
      'https://hooks.example/x',
    );
    await overlay(wrapper, '[data-testid="policy-save"]').trigger('click');

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
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="policy-create"]')).toBe(true));
    await overlay(wrapper, '[data-testid="policy-create"]').trigger('click');
    await overlay(wrapper, '[data-testid="policy-name"]').setValue('Broken');
    await overlay(wrapper, '[data-testid="policy-save"]').trigger('click');
    expect(overlay(wrapper, '[data-testid="policy-form-error"]').text()).toContain(
      'needs a target',
    );
    expect(
      fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
    wrapper.unmount();
  });

  it('schedules a maintenance window with an ISO range and an explicit scope', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="maintenance-create"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="maintenance-create"]').trigger('click');
    await overlay(wrapper, '[data-testid="maintenance-name"]').setValue('Router swap');
    await overlay(wrapper, '[data-testid="maintenance-starts"]').setValue('2026-09-01T01:00');
    await overlay(wrapper, '[data-testid="maintenance-ends"]').setValue('2026-09-01T03:00');
    await overlay(wrapper, '[data-testid="maintenance-save"]').trigger('click');

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
      expect(overlayHas(wrapper, '[data-testid="maintenance-create"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="maintenance-create"]').trigger('click');
    await overlay(wrapper, '[data-testid="maintenance-name"]').setValue('Backwards');
    await overlay(wrapper, '[data-testid="maintenance-starts"]').setValue('2026-09-01T05:00');
    await overlay(wrapper, '[data-testid="maintenance-ends"]').setValue('2026-09-01T04:00');
    await overlay(wrapper, '[data-testid="maintenance-save"]').trigger('click');
    expect(overlay(wrapper, '[data-testid="maintenance-form-error"]').text()).toContain(
      'end time must be after',
    );
    wrapper.unmount();
  });

  it('hides every mutation and says why when the operator lacks system.manage', async () => {
    grant('alerts.view');
    stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="policy-row-pol-1"]')).toBe(true),
    );
    expect(overlayHas(wrapper, '[data-testid="policy-create"]')).toBe(false);
    expect(overlayHas(wrapper, '[data-testid="maintenance-create"]')).toBe(false);
    expect(overlayHas(wrapper, '[data-testid="policy-edit-pol-1"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="alert-response-readonly"]').text()).toContain(
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
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="policy-error"]')).toBe(true));
    expect(overlay(wrapper, '[data-testid="policy-error"]').text()).toContain('not available');
    expect(overlay(wrapper, '[data-testid="maintenance-error"]').text()).toContain('not available');
    expect(overlay(wrapper, '[data-testid="readiness-error"]').text()).toContain('not available');
    wrapper.unmount();
  });

  it('shows per-channel notification readiness and why a channel cannot deliver', async () => {
    stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="readiness-channel-ch-2"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="readiness-channel-ch-1"]').text()).toContain(
      'deliverable',
    );
    const email = overlay(wrapper, '[data-testid="readiness-channel-ch-2"]').text();
    expect(email).toContain('cannot deliver');
    expect(email).toContain('SMTP_URL is not configured');
    expect(overlay(wrapper, '[data-testid="readiness-deliverable"]').text()).toBe('1');
    expect(overlay(wrapper, '[data-testid="readiness-undeliverable"]').text()).toBe('2');
    // The API's warning is the headline, not a rephrasing of it.
    expect(overlay(wrapper, '[data-testid="readiness-warning"]').text()).toContain(
      'could not be delivered',
    );
    expect(overlayHas(wrapper, '[data-testid="readiness-ok"]')).toBe(false);
    wrapper.unmount();
  });

  it('confirms readiness when a channel can deliver and a policy is enabled', async () => {
    stubApi({ readiness: { ...readiness, undeliverableAlerts: 0, warning: null } });
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() => expect(overlayHas(wrapper, '[data-testid="readiness-ok"]')).toBe(true));
    expect(overlay(wrapper, '[data-testid="readiness-ok"]').text()).toContain('reaches somebody');
    expect(overlayHas(wrapper, '[data-testid="readiness-warning"]')).toBe(false);
    wrapper.unmount();
  });

  it('re-seeds notification defaults, and offers that only with system.manage', async () => {
    const fetchMock = stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="readiness-repair"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="readiness-repair"]').trigger('click');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) =>
        String(entry[0]).includes('/monitoring/notifications/readiness/repair'),
      );
      expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
    });
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="readiness-notice"]').text()).toContain(
        'default dashboard channel',
      ),
    );
    wrapper.unmount();

    grant('alerts.view');
    stubApi();
    const readOnly = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(readOnly.find('[data-testid="readiness-panel"]').exists()).toBe(true),
    );
    expect(readOnly.find('[data-testid="readiness-repair"]').exists()).toBe(false);
    readOnly.unmount();
  });

  /**
   * Regression: the maintenance panel asserted "there is no per-alert
   * 'suppress' action". There is — POST /alerts/:id/suppress — and the Alert
   * Lifecycle screen already ships the control. The note sent operators looking
   * for a capability the console had, and told them it did not exist.
   */
  it('points at the per-alert suppress action instead of denying it exists', async () => {
    stubApi();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<p />' } }],
    });
    await router.push('/alert-response');
    await router.isReady();
    const wrapper = mount(AlertResponseView, { global: { plugins: [router] } });
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="maintenance-scope-note"]')).toBe(true),
    );

    const panel = wrapper.text();
    expect(panel).not.toContain('there is no per-alert');
    expect(panel).toContain('per-alert suppress action');
    expect(
      overlayAll(wrapper, 'a').some((link) => link.attributes('href') === '/alert-lifecycle'),
    ).toBe(true);
    wrapper.unmount();
  });

  /**
   * Regression: the SMSC scope picker sent the row UUID, but
   * MaintenanceWindowService matches `scope.smscs` against the `smsc` metric
   * label, which the status poller writes as the ENGINE id. The window saved,
   * looked correct, and suppressed nothing at all.
   */
  it('scopes a maintenance window by SMSC engine id, which is what suppression matches', async () => {
    stubApi();
    const wrapper = mount(AlertResponseView);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="maintenance-create"]')).toBe(true),
    );
    await overlay(wrapper, '[data-testid="maintenance-create"]').trigger('click');
    const scope = overlay(wrapper, '[data-testid="maintenance-scope-all"]');
    await scope.setValue(scope.findAll('option')[1].element.value);
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="maintenance-smscs"]')).toBe(true),
    );

    const option = overlay(wrapper, '[data-testid="maintenance-smscs"]').get(
      'input[type="checkbox"]',
    );
    expect((option.element as HTMLInputElement).value).toBe('primary-smpp');
    expect(overlay(wrapper, '[data-testid="maintenance-smscs"]').text()).toContain('Primary SMPP');
    wrapper.unmount();
  });
});
