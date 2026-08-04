import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set([
      'alerts.view',
      'alerts.acknowledge',
      'messages.view',
      'messages.export',
      'smsc.view',
      'system.manage',
      'users.view',
    ]),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import ModuleWorkspace from '../src/views/ModuleWorkspace.vue';
import { session } from '../src/stores/session';

const grant = (...codes: string[]) => {
  (session as unknown as { value: { displayName: string; permissions: Set<string> } }).value = {
    displayName: 'Amina Operator',
    permissions: new Set(codes),
  };
};
const ALL = [
  'alerts.view',
  'alerts.acknowledge',
  'messages.view',
  'messages.export',
  'smsc.view',
  'system.manage',
  'users.view',
];

const mountWorkspace = async (path: string, title: string) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path, name: path.slice(1), component: ModuleWorkspace, meta: { title } },
      {
        path: '/alert-response',
        name: 'alert-response',
        component: ModuleWorkspace,
        meta: { title: 'Escalation' },
      },
    ],
  });
  await router.push(path);
  await router.isReady();
  return mount(ModuleWorkspace, { global: { plugins: [router] } });
};

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
const gridPage = (items: unknown[], total = items.length) => ({
  items,
  total,
  limit: 50,
  offset: 0,
});
const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body || '{}'));

const alertRow = {
  id: 'al-1',
  rule_id: 'rule-1',
  rule_name: 'Queue depth above threshold',
  status: 'open',
  severity: 'critical',
  source: 'rule',
  summary: 'Outbound queue depth 4200',
  dedup_count: 7,
  correlation_group: 'smsc:local-fake',
  opened_at: '2026-08-04T09:00:00Z',
  resolved_at: null,
  acknowledged_by: null,
  acknowledged_at: null,
};

const messageRow = {
  id: '900',
  direction: 'MT',
  sender: 'JKANNEL',
  receiver: '+256700000001',
  text: 'Your OTP is 123456',
  smscId: 'primary-smpp',
  service: 'otp',
  account: 'acme',
  status: 'sent',
  deliveryStatus: 'failed',
  dlrEvent: 2,
  dlrAt: '2026-08-04T09:05:00Z',
  externalRef: 'corr-900',
  timestamp: '2026-08-04T09:00:00Z',
};

describe('module workspace operational density', () => {
  beforeEach(() => {
    grant(...ALL);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the alert grid with severity, source, dedup count and correlation group', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => apiResponse(gridPage([alertRow]))),
    );
    const wrapper = await mountWorkspace('/alerts', 'Alerts');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-al-1"]').exists()).toBe(true));
    const headers = wrapper.findAll('th').map((th) => th.text());
    expect(headers).toEqual(
      expect.arrayContaining([
        'Severity',
        'Condition',
        'Status',
        'Source',
        'Rule',
        'Occurrences',
        'Correlation',
        'Opened',
        'Acknowledged',
        'Resolved',
      ]),
    );
    const row = wrapper.get('[data-testid="record-al-1"]').text();
    expect(row).toContain('critical');
    expect(row).toContain('Outbound queue depth 4200');
    expect(row).toContain('smsc:local-fake');
    expect(row).toContain('7');
    wrapper.unmount();
  });

  it('acknowledges an alert and states honestly that resolve/suppress have no endpoint', async () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('taking it'));
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/acknowledgements') && init?.method === 'POST')
        return apiResponse({ id: 'ack-1' });
      return apiResponse(gridPage([alertRow]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/alerts', 'Alerts');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="alert-ack-al-1"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="alert-actions-note"]').text()).toContain(
      'no manual resolve, assign or per-alert suppress endpoint',
    );

    await wrapper.get('[data-testid="alert-ack-al-1"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).includes('/alerts/al-1/acknowledgements') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toEqual({ note: 'taking it' });
    });
    wrapper.unmount();
  });

  it('hides alert actions from an operator without alerts.acknowledge', async () => {
    grant('alerts.view');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => apiResponse(gridPage([alertRow]))),
    );
    const wrapper = await mountWorkspace('/alerts', 'Alerts');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-al-1"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="alert-ack-al-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="alert-notify-al-1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="record-al-1"]').text()).toContain(
      'Requires alerts.acknowledge',
    );
    wrapper.unmount();
  });

  it('offers a live refresh strip on alerts and lets it be switched off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => apiResponse(gridPage([alertRow]))),
    );
    const wrapper = await mountWorkspace('/alerts', 'Alerts');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="live-controls"]').exists()).toBe(true),
    );
    expect(
      (wrapper.get('[data-testid="live-auto-toggle"]').element as HTMLSelectElement).value,
    ).toBe('true');
    await wrapper.get('[data-testid="live-auto-toggle"]').setValue(false);
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="live-last-refreshed"]').text()).toContain(
        'auto refresh is off',
      ),
    );
    wrapper.unmount();
  });

  it('gives the SMSC grid its real connection columns while keeping the state dot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        apiResponse(
          gridPage([
            {
              id: 's1',
              engine_id: 'primary-smpp',
              name: 'Primary SMPP',
              type: 'smpp',
              host: 'smpp.example',
              port: 2775,
              credential_secret_ref: 'sysid-primary',
              tps: 25,
              priority: 1,
              tags: ['ug', 'mtn'],
              enabled: true,
              lifecycle_state: 'active',
              last_error: null,
              health: { state: 'reachable', latency_ms: 42 },
              updated_at: '2026-08-04T09:00:00Z',
            },
          ]),
        ),
      ),
    );
    const wrapper = await mountWorkspace('/smsc', 'SMSC Manager');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-s1"]').exists()).toBe(true));
    const row = wrapper.get('[data-testid="record-s1"]').text();
    expect(row).toContain('smpp.example:2775');
    expect(row).toContain('sysid-primary');
    expect(row).toContain('25');
    expect(row).toContain('reachable · 42 ms');
    expect(row).toContain('ug, mtn');
    // The reachability dot the SMSC screen has always shown survives the change.
    expect(wrapper.get('[data-testid="smsc-dot-s1"]').classes()).toContain('good');
    wrapper.unmount();
  });

  it('sends message filters to the read model and carries them into the export', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:x'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/messages/export.csv'))
        return Promise.resolve(
          new Response('id\r\n1', {
            status: 200,
            headers: {
              'x-jkannel-export-row-count': '1',
              'content-disposition': 'attachment; filename="m.csv"',
            },
          }),
        );
      return apiResponse({ items: [messageRow], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-900"]').exists()).toBe(true));

    await wrapper.get('[data-testid="message-status"]').setValue('resendable');
    await wrapper.get('[data-testid="message-direction"]').setValue('MT');
    await wrapper.get('[data-testid="message-smsc"]').setValue('primary-smpp');
    await wrapper.get('[data-testid="message-apply"]').trigger('click');
    await vi.waitFor(() => {
      const listed = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(listed).toContain('status=resendable');
      expect(listed).toContain('direction=MT');
      expect(listed).toContain('smscId=primary-smpp');
    });

    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="export-messages"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    const exportCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/messages/export.csv'),
    );
    expect(String(exportCall?.[0])).toContain('status=resendable');
    expect(String(exportCall?.[0])).toContain('direction=MT');
    expect(String(exportCall?.[0])).toContain('smscId=primary-smpp');
    expect(String(exportCall?.[0])).toContain('limit=5000');
    click.mockRestore();
    wrapper.unmount();
  });

  it('shows the sent_sms fields the grid used to drop, and is honest about the date filter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => apiResponse({ items: [messageRow], nextCursor: null })),
    );
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-900"]').exists()).toBe(true));
    const row = wrapper.get('[data-testid="record-900"]').text();
    expect(row).toContain('failed');
    expect(row).toContain('MT');
    expect(row).toContain('otp');
    expect(row).toContain('acme');
    expect(row).toContain('corr-900');
    // dlr_mask 2 on the correlated receipt means "failed", not "requested mask 2".
    expect(row).toContain('failed');

    await wrapper.get('[data-testid="message-from"]').setValue('2026-08-05T00:00');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="message-date-note"]').text()).toContain(
        'does not accept a date range yet',
      ),
    );
    // The row is outside the range, so the console filters it out of the page.
    expect(wrapper.find('[data-testid="record-900"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('lists backup schedules and creates one with a retention class', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/backup-dr/schedules') && init?.method === 'POST')
        return apiResponse({ id: 'sch-2' });
      if (url.includes('/backup-dr/schedules'))
        return apiResponse(
          gridPage([
            {
              id: 'sch-1',
              name: 'Nightly full',
              cron: '0 2 * * *',
              interval_minutes: null,
              kind: 'full',
              retention_class: 'daily',
              enabled: true,
              last_run_at: 't0',
              next_run_at: 't1',
            },
          ]),
        );
      return apiResponse(gridPage([{ id: 'b1', label: 'nightly', status: 'complete' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/backup', 'Backup');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="schedule-row-sch-1"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="schedule-row-sch-1"]').text()).toContain('0 2 * * *');
    expect(wrapper.get('[data-testid="schedule-row-sch-1"]').text()).toContain('daily');

    await wrapper.get('[data-testid="schedule-new"]').trigger('click');
    await wrapper.get('[data-testid="schedule-name"]').setValue('Hourly schema');
    await wrapper.get('[data-testid="schedule-interval"]').setValue('60');
    await wrapper.get('[data-testid="schedule-kind"]').setValue('schema');
    await wrapper.get('[data-testid="schedule-retention"]').setValue('hourly');
    await wrapper.get('[data-testid="schedule-submit"]').trigger('click');

    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/backup-dr/schedules') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toEqual({
        name: 'Hourly schema',
        kind: 'schema',
        retentionClass: 'hourly',
        enabled: true,
        intervalMinutes: 60,
      });
    });
    wrapper.unmount();
  });

  it('hides schedule creation and the retention sweep without system.manage', async () => {
    grant('system.view', 'alerts.view');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => apiResponse(gridPage([]))),
    );
    const wrapper = await mountWorkspace('/backup', 'Backup');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="backup-schedules"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="schedule-new"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="retention-apply"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="backup-schedules"]').text()).toContain('system.manage');
    wrapper.unmount();
  });

  it('gives the users grid its roles and lifecycle columns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/users/roles')) return apiResponse([]);
        return apiResponse(
          gridPage([
            {
              id: 'u1',
              username: 'amina',
              status: 'active',
              roles: ['administrator', 'auditor'],
              created_at: 'c0',
              updated_at: 'c1',
            },
          ]),
        );
      }),
    );
    const wrapper = await mountWorkspace('/users', 'Users & Roles');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-u1"]').exists()).toBe(true));
    const headers = wrapper.findAll('th').map((th) => th.text());
    expect(headers).toEqual(
      expect.arrayContaining(['User', 'Status', 'Roles', 'Created', 'Updated']),
    );
    expect(wrapper.get('[data-testid="record-u1"]').text()).toContain('administrator, auditor');
    wrapper.unmount();
  });
});
