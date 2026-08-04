import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set(['system.manage', 'users.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import ModuleWorkspace from '../src/views/ModuleWorkspace.vue';

const mountWorkspace = async (path: string, title: string) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path, name: path.slice(1), component: ModuleWorkspace, meta: { title } }],
  });
  await router.push(path);
  await router.isReady();
  return mount(ModuleWorkspace, { global: { plugins: [router] } });
};

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

const gridPage = (items: unknown[], total = items.length) => ({
  items,
  total,
  limit: 50,
  offset: 0,
});

const stubDownloads = () => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:jkannel-export'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
};

const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

describe('module workspace per-module enhancements', () => {
  it('creates a user with roles, opens the detail drawer, edits, and archives', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/users/roles'))
        return apiResponse([
          { id: 'r1', name: 'NOC', description: 'Ops', user_count: 3, permissions: ['smsc.read'] },
          { id: 'r2', name: 'Admin', description: 'All', user_count: 1, permissions: [] },
        ]);
      if (/\/users\/u1$/.test(url) && init?.method === 'DELETE') return apiResponse({ id: 'u1' });
      if (/\/users\/u1$/.test(url) && init?.method === 'PATCH') return apiResponse({ id: 'u1' });
      if (/\/users\/u1$/.test(url))
        return apiResponse({
          id: 'u1',
          username: 'amina',
          status: 'active',
          roles: [{ id: 'r1', name: 'NOC' }],
          permissions: ['smsc.read', 'reports.read'],
          created_at: '2026-07-01',
        });
      if (url.endsWith('/users') && init?.method === 'POST') return apiResponse({ id: 'u2' });
      return apiResponse(gridPage([{ id: 'u1', username: 'amina', status: 'active' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/users', 'Users');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    // Create user with a role (roles render as a labelled checkbox list).
    await wrapper.get('[data-testid="create-user"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid^="new-role-"]').length).toBe(2));
    expect(wrapper.get('[data-testid="new-roles"]').text()).toContain('Ops');
    await wrapper.get('[data-testid="new-username"]').setValue('joel');
    await wrapper.get('[data-testid="new-password"]').setValue('longenoughpwd');
    await wrapper.get('[data-testid="new-role-r1"]').get('input').setValue(true);
    await wrapper.get('[data-testid="create-user-submit"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]).endsWith('/users') && call[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toEqual({
        username: 'joel',
        password: 'longenoughpwd',
        roleIds: ['r1'],
      });
    });

    // Open the detail drawer for the row.
    await wrapper.get('[data-testid="record-u1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="user-detail-status"]').text()).toBe('active'),
    );
    expect(wrapper.get('[data-testid="detail-panel"]').text()).toContain('smsc.read');
    expect(wrapper.get('[data-testid="detail-panel"]').text()).toContain('NOC');

    // Edit the status and save.
    await wrapper.get('[data-testid="detail-edit"]').trigger('click');
    await wrapper.get('[data-testid="user-status"]').setValue('disabled');
    await wrapper.get('[data-testid="user-save"]').trigger('click');
    await vi.waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => /\/users\/u1$/.test(String(call[0])) && call[1]?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(bodyOf(patch)).toEqual({ status: 'disabled', roleIds: ['r1'] });
    });

    // Archive with confirm.
    await wrapper.get('[data-testid="record-u1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="user-archive"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="user-archive"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => /\/users\/u1$/.test(String(call[0])) && call[1]?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('renders SMSC status dots and loads a detail panel with health samples', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (/\/smscs\/s1$/.test(url))
        return apiResponse({
          id: 's1',
          name: 'Primary SMPP',
          host: 'smpp.example',
          port: 2775,
          tps: 20,
          enabled: true,
          lifecycle_state: 'active',
          health: [{ state: 'reachable', latency_ms: 42, detail: 'ok', observed_at: 't1' }],
          deployments: [{ operation: 'deploy', status: 'success', detail: 'v3', created_at: 't0' }],
        });
      return apiResponse(
        gridPage([
          { id: 's1', name: 'Primary SMPP', enabled: true, lifecycle_state: 'active' },
          { id: 's2', name: 'Backup', enabled: false, lifecycle_state: 'archived' },
        ]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/smsc', 'SMSC Manager');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    expect(wrapper.get('[data-testid="smsc-dot-s1"]').classes()).toContain('good');
    expect(wrapper.get('[data-testid="smsc-dot-s2"]').classes()).toContain('bad');

    await wrapper.get('[data-testid="record-s1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="smsc-health"]').text()).toContain('reachable'),
    );
    expect(wrapper.get('[data-testid="smsc-health"]').text()).toContain('42 ms');
    expect(wrapper.get('[data-testid="smsc-deployments"]').text()).toContain('deploy');
  });

  it('opens an audit event detail panel with pretty-printed JSON', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (/\/audit-events\/evt-1$/.test(url))
        return apiResponse({
          id: 'evt-1',
          action: 'smsc.update',
          entity_type: 'smsc',
          entity_id: 's1',
          actor_id: 'user-7',
          reason: 'tps change',
          correlation_id: 'corr-9',
          source_ip: '10.0.0.4',
          created_at: '2026-07-09T05:00:00Z',
          old_value: { tps: 10 },
          new_value: { tps: 20 },
        });
      return apiResponse(gridPage([{ id: 'evt-1', action: 'smsc.update', actor_id: 'user-7' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/logs-audit', 'Logs & Audit');
    await vi.waitFor(() => expect(wrapper.text()).toContain('smsc.update'));

    await wrapper.get('[data-testid="record-evt-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="audit-old"]').text()).toContain('"tps": 10'),
    );
    expect(wrapper.get('[data-testid="audit-new"]').text()).toContain('"tps": 20');
    expect(wrapper.get('[data-testid="detail-panel"]').text()).toContain('corr-9');
  });

  it('paginates and searches the queue with a cursor and depth summary', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const cursor = new URL(`http://x${url}`).searchParams.get('cursor');
      return apiResponse({
        items: [
          {
            id: cursor === 'c2' ? 'm2' : 'm1',
            sender: 'JKANNEL',
            receiver: '+256700',
            smsc: 'primary',
            text: 'hi',
            timestamp: 't',
          },
        ],
        nextCursor: cursor === 'c2' ? null : 'c2',
        summary: { queued: 5, oldestEpoch: 1720000000 },
        source: 'runtime',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/queues', 'Queues');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    expect(wrapper.get('[data-testid="queue-depth"]').text()).toBe('5');
    expect(wrapper.get('[data-testid="queue-row-0"]').text()).toContain('m1');

    await wrapper.get('[data-testid="cursor-next"]').trigger('click');
    await vi.waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('cursor=c2'));
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="queue-row-0"]').text()).toContain('m2'),
    );

    await wrapper.get('[data-testid="workspace-search"]').setValue('primary');
    await vi.waitFor(
      () => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('query=primary'),
      { timeout: 2000 },
    );
  });

  it('renders delivery reports with an smscId filter and CSV export', async () => {
    const click = stubDownloads();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/reports/delivery/export.csv'))
        return Promise.resolve(
          new Response('id,status\r\n1,delivered', {
            status: 200,
            headers: {
              'content-disposition': 'attachment; filename="dlr.csv"',
              'x-jkannel-export-row-count': '1',
            },
          }),
        );
      return apiResponse({
        items: [{ id: 'd1', recipient: '+256700', status: 'delivered', smsc: 'primary' }],
        nextCursor: null,
        summary: { total: 12 },
        source: { status: 'available', type: 'kamex-sqlbox' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/delivery-reports', 'Delivery Reports');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    expect(wrapper.get('[data-testid="dlr-total"]').text()).toBe('12');
    expect(wrapper.get('[data-testid="dlr-row-0"]').text()).toContain('delivered');

    await wrapper.get('[data-testid="dlr-smsc-filter"]').setValue('primary');
    await wrapper.get('[data-testid="dlr-smsc-filter"]').trigger('change');
    await vi.waitFor(() =>
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('smscId=primary'),
    );
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    await wrapper.get('[data-testid="dlr-export"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/reports/delivery/export.csv')),
    ).toBe(true);
    click.mockRestore();
  });

  /**
   * The list endpoint returns the SQLBox read model's whole normalised row per
   * receipt, and there is no per-receipt endpoint — so the drawer is built from
   * the row itself rather than a second request.
   */
  it('opens a delivery report row into a detail drawer with the full receipt', async () => {
    const receipt = {
      id: '9911',
      source: 'sent_sms',
      externalRef: 'campaign-77',
      direction: 'DLR',
      sender: '+256700000001',
      receiver: '+256700123456',
      text: 'Delivered to handset',
      smscId: 'smsc-primary',
      service: 'alerts',
      account: 'acme',
      dlrMask: 31,
      dlrUrl: 'https://acme.example/dlr',
      boxcId: 'smsbox-1',
      timestamp: '2026-08-04T09:00:00Z',
      status: 'delivery_report',
      deliveryStatus: 'delivered',
      dlrEvent: 1,
      dlrAt: '2026-08-04T09:00:04Z',
      coding: 0,
      charset: 'UTF-8',
      udhData: null,
      binfo: 'bundle-3',
      metaData: '?smpp?dlr_err=000',
      segments: 1,
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      apiResponse({
        items: [receipt],
        nextCursor: null,
        summary: { total: 1 },
        source: { status: 'available', type: 'kamex-sqlbox' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/delivery-reports', 'Delivery Reports');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    expect(wrapper.find('[data-testid="dlr-detail-panel"]').exists()).toBe(false);
    await wrapper.get('[data-testid="dlr-row-0"]').trigger('click');

    const drawer = wrapper.get('[data-testid="dlr-detail-panel"]');
    const shown = drawer.text();
    // Identifiers, parties, SMSC, delivery outcome, DLR event, timestamps, cause.
    expect(shown).toContain('9911');
    expect(shown).toContain('campaign-77');
    expect(shown).toContain('+256700000001');
    expect(shown).toContain('+256700123456');
    expect(shown).toContain('smsc-primary');
    expect(shown).toContain('2026-08-04T09:00:00Z');
    expect(shown).toContain('2026-08-04T09:00:04Z');
    expect(shown).toContain('https://acme.example/dlr');
    expect(shown).toContain('?smpp?dlr_err=000');
    expect(drawer.get('[data-testid="dlr-detail-delivery-status"]').text()).toBe('delivered');
    // The Kannel DLR mask is translated, not printed raw as "1".
    expect(drawer.get('[data-testid="dlr-detail-event"]').text()).toBe('delivered');

    // No second request: the row already carried everything.
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/reports/delivery')).length,
    ).toBe(1);

    await drawer.get('[data-testid="dlr-detail-close"]').trigger('click');
    expect(wrapper.find('[data-testid="dlr-detail-panel"]').exists()).toBe(false);
  });

  it('shows a dash rather than a guess for receipt fields the store did not supply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        apiResponse({
          items: [{ id: 'd2', receiver: '+256700000002' }],
          nextCursor: null,
          summary: { total: 1 },
          source: { status: 'available', type: 'kamex-sqlbox' },
        }),
      ),
    );
    const wrapper = await mountWorkspace('/delivery-reports', 'Delivery Reports');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="dlr-row-0"]').trigger('click');
    const drawer = wrapper.get('[data-testid="dlr-detail-panel"]');
    expect(drawer.text()).toContain('—');
    expect(drawer.get('[data-testid="dlr-detail-event"]').text()).toBe('no report yet');
  });

  it('enables and disables plugins gated on system.manage', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/plugins/p1/enable') && init?.method === 'POST') return apiResponse({});
      if (url.includes('/plugins/p1/disable') && init?.method === 'POST') return apiResponse({});
      return apiResponse([
        {
          id: 'p1',
          plugin_id: 'sms-archiver',
          name: 'SMS Archiver',
          version: '1.2.0',
          publisher: 'Acme',
          status: 'installed',
          permissions: ['messages.read'],
          events: ['message.sent'],
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/plugins', 'Plugins');
    await vi.waitFor(() => expect(wrapper.text()).toContain('SMS Archiver'));
    expect(wrapper.find('[data-testid="plugins-help"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('messages.read');
    expect(wrapper.text()).toContain('message.sent');

    await wrapper.get('[data-testid="plugin-enable-p1"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/plugins/p1/enable')),
      ).toBe(true),
    );
    await wrapper.get('[data-testid="plugin-disable-p1"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/plugins/p1/disable')),
      ).toBe(true),
    );
  });

  it('creates a scoped backup through a naming/scope modal and restores with a reason', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/backup-dr') && init?.method === 'POST') return apiResponse({ id: 'b2' });
      if (url.includes('/backup-dr/b1/restore') && init?.method === 'POST') return apiResponse({});
      if (url.includes('/backup-dr/b1/verify')) return apiResponse({ status: 'verified' });
      return apiResponse([
        {
          id: 'b1',
          label: 'nightly',
          scope: 'full',
          kind: 'full',
          status: 'complete',
          size_bytes: 2048000,
          checksum: 'abc',
          started_at: 't0',
          completed_at: 't1',
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/backup', 'Backup');
    await vi.waitFor(() => expect(wrapper.text()).toContain('nightly'));
    expect(wrapper.find('[data-testid="backup-help"]').exists()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('/backup-dr');

    // The primary action opens a modal to name the backup and choose its scope.
    await wrapper.get('[data-testid="primary-action"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="backup-modal"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="backup-label"]').setValue('pre-upgrade');
    await wrapper.get('[data-testid="backup-scope-database"]').setValue();
    await wrapper.get('[data-testid="backup-submit"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]).endsWith('/backup-dr') && call[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toEqual({
        kind: 'full',
        retentionClass: 'manual',
        scope: 'database',
        label: 'pre-upgrade',
      });
    });
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    // Verify uses GET /backup-dr/:id/verify.
    await wrapper.get('[data-testid="backup-verify-b1"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/backup-dr/b1/verify')),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    // Restore requires a reason and posts confirm:true to /backup-dr/:id/restore.
    await wrapper.get('[data-testid="backup-restore-b1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="restore-form"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="restore-submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="restore-reason"]').setValue('DR drill');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="restore-submit"]').trigger('click');
    await vi.waitFor(() => {
      const restore = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes('/backup-dr/b1/restore'),
      );
      expect(restore).toBeTruthy();
      expect(bodyOf(restore)).toEqual({ confirm: true, reason: 'DR drill' });
    });
  });

  it('creates an API client and reveals the secret exactly once', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/api-gateway/clients') && init?.method === 'POST')
        return apiResponse({ id: 'c9', name: 'Billing', clientSecret: 'sk_live_secret_value' });
      return apiResponse([
        {
          id: 'c1',
          name: 'Existing',
          client_key: 'ck_1',
          scopes: ['messages.send'],
          status: 'active',
          rate_limit_per_min: 60,
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/api-gateway', 'API Gateway');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Existing'));

    await wrapper.get('[data-testid="primary-action"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="api-client-form"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="api-client-name"]').setValue('Billing');
    await wrapper.get('[data-testid="api-client-scopes"]').setValue('messages.send, reports.read');
    await wrapper.get('[data-testid="api-client-submit"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="secret-value"]').text()).toBe('sk_live_secret_value'),
    );
    const post = fetchMock.mock.calls.find(
      (call) => String(call[0]).endsWith('/api-gateway/clients') && call[1]?.method === 'POST',
    );
    expect(bodyOf(post)).toEqual({ name: 'Billing', scopes: ['messages.send', 'reports.read'] });

    await wrapper.get('[data-testid="secret-dismiss"]').trigger('click');
    expect(wrapper.find('[data-testid="secret-box"]').exists()).toBe(false);
  });

  it('renders system settings grouped and PUTs an inline edit with type coercion', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/system/settings/max_tps') && init?.method === 'PUT')
        return apiResponse({ key: 'max_tps', value: 250 });
      return apiResponse({
        items: [
          {
            key: 'max_tps',
            value: 200,
            is_secret: false,
            group: 'throughput',
            type: 'number',
            description: 'Global TPS ceiling',
            editable: true,
          },
          {
            key: 'build_sha',
            value: 'abc123',
            is_secret: false,
            group: 'system',
            type: 'string',
            description: 'Deployed build',
            editable: false,
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/system', 'System Settings');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    expect(wrapper.find('[data-testid="settings-group-throughput"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="setting-readonly-build_sha"]').text()).toBe('Read-only');

    await wrapper.get('[data-testid="setting-input-max_tps"]').setValue('250');
    await wrapper.get('[data-testid="setting-save-max_tps"]').trigger('click');
    await vi.waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (call) => String(call[0]).includes('/system/settings/max_tps') && call[1]?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      expect(bodyOf(put)).toEqual({ value: 250 });
    });
  });

  it('renders runtime containers with honest health dots and observed badges', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      apiResponse({
        items: [
          {
            name: 'bearerbox',
            service: 'engine',
            image: 'kannel',
            status: 'up',
            health: 'healthy',
            observed: true,
          },
          {
            name: 'sqlbox',
            service: 'store',
            image: 'pg',
            status: 'unknown',
            health: 'unknown',
            observed: false,
          },
        ],
        total: 2,
        observedAt: '2026-07-09T06:00:00Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/docker', 'Runtime');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await vi.waitFor(() => expect(wrapper.find('[data-testid="container-0"]').exists()).toBe(true));

    expect(wrapper.get('[data-testid="container-0"]').find('.dot').classes()).toContain('good');
    expect(wrapper.get('[data-testid="container-observe-0"]').text()).toContain('observed live');
    expect(wrapper.get('[data-testid="container-1"]').find('.dot').classes()).toContain('unknown');
    expect(wrapper.get('[data-testid="container-observe-1"]').text()).toContain('declared');
    expect(wrapper.get('[data-testid="docker-panel"]').text()).toContain('unknown');
  });

  it('shows an honest planned message when a module source is unavailable (customers)', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      apiResponse({
        items: [],
        source: {
          status: 'unavailable',
          message: 'Customer management is planned for a later release.',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/customers', 'Customers');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    expect(wrapper.get('[data-testid="source-unavailable"]').text()).toContain(
      'Customer management is planned',
    );
    expect(wrapper.find('[data-testid="api-state"]').exists()).toBe(false);
  });

  it('opens a message trace drawer with events and summary when a row is clicked', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (/\/messages\/m1\/trace$/.test(url))
        return apiResponse({
          id: 'm1',
          events: [
            { type: 'accepted', detail: 'queued', at: 't0', status: 'ok' },
            { type: 'delivered', detail: 'DLR received', at: 't1', status: 'ok' },
          ],
          summary: { status: 'delivered', direction: 'MT' },
        });
      return apiResponse([
        {
          id: 'm1',
          sender: 'JKANNEL',
          receiver: '+256700',
          smsc: 'primary',
          status: 'delivered',
          direction: 'MT',
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="record-m1"]').exists()).toBe(true));

    await wrapper.get('[data-testid="record-m1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="message-trace-panel"]').exists()).toBe(true),
    );
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="message-trace-events"]').text()).toContain('delivered'),
    );
    expect(wrapper.get('[data-testid="message-trace-events"]').text()).toContain('DLR received');
    expect(wrapper.get('[data-testid="message-trace-panel"]').text()).toContain('+256700');
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/messages/m1/trace')),
    ).toBe(true);
  });

  it('edits and archives an SMSC, surfacing the 409 referenced-by-routes message', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    let deleteCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (/\/smscs\/s1$/.test(url) && init?.method === 'PATCH') return apiResponse({ id: 's1' });
      if (/\/smscs\/s1$/.test(url) && init?.method === 'DELETE') {
        deleteCalls += 1;
        if (deleteCalls === 1)
          return apiResponse('SMSC is referenced by 2 routes and cannot be archived.', 409);
        return apiResponse({ id: 's1' });
      }
      if (/\/smscs\/s1$/.test(url))
        return apiResponse({
          id: 's1',
          name: 'Primary SMPP',
          host: 'smpp.example',
          port: 2775,
          tps: 20,
          enabled: true,
          lifecycle_state: 'active',
          health: [],
          deployments: [],
        });
      return apiResponse(
        gridPage([{ id: 's1', name: 'Primary SMPP', enabled: true, lifecycle_state: 'active' }]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/smsc', 'SMSC Manager');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    await wrapper.get('[data-testid="record-s1"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="smsc-edit"]').exists()).toBe(true));

    // Edit the SMSC.
    await wrapper.get('[data-testid="smsc-edit"]').trigger('click');
    await wrapper.get('[data-testid="smsc-edit-host"]').setValue('smpp2.example');
    await wrapper.get('[data-testid="smsc-edit-tps"]').setValue(50);
    await wrapper.get('[data-testid="smsc-save"]').trigger('click');
    await vi.waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => /\/smscs\/s1$/.test(String(call[0])) && call[1]?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(bodyOf(patch)).toMatchObject({ host: 'smpp2.example', tps: 50, enabled: true });
    });

    // First archive returns 409 (referenced by routes) shown honestly.
    await wrapper.get('[data-testid="record-s1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="smsc-archive"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="smsc-archive"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="api-state"]').text()).toContain('referenced by 2 routes'),
    );

    // Second archive succeeds.
    await wrapper.get('[data-testid="smsc-archive"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          (call) => /\/smscs\/s1$/.test(String(call[0])) && call[1]?.method === 'DELETE',
        ).length,
      ).toBe(2),
    );
  });

  it('loads a configuration baseline into the create form and edits a version as a new one', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/configurations/baseline'))
        return apiResponse({
          scope: 'gateway',
          content: { adminPort: 13000, smsc: [{ id: 'fake', type: 'fake' }] },
          description: 'A working starter configuration.',
          notes: ['Uses a fake SMSC for development.'],
        });
      if (/\/configurations\/cfg-1$/.test(url) && (!init || init.method === undefined))
        return apiResponse({ id: 'cfg-1', scope: 'gateway', content: { adminPort: 14000 } });
      if (url.endsWith('/configurations') && init?.method === 'POST')
        return apiResponse({ id: 'v2' });
      return apiResponse(
        gridPage([{ id: 'cfg-1', scope: 'gateway', version_number: 3, status: 'deployed' }]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/configuration', 'Configuration');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    // Load baseline pre-fills the composer with the starter config + description/notes.
    await wrapper.get('[data-testid="load-baseline"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="configuration-baseline-info"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="configuration-baseline-info"]').text()).toContain(
      'working starter configuration',
    );
    expect(wrapper.get('[data-testid="configuration-baseline-content"]').text()).toContain(
      'adminPort',
    );
    await wrapper.get('[data-testid="save-draft"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]).endsWith('/configurations') && call[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toMatchObject({ scope: 'gateway' });
      expect(bodyOf(post).content).toMatchObject({ adminPort: 13000 });
    });

    // Edit a row loads that version's content for a new version.
    await wrapper.get('[data-testid="config-edit-cfg-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="configuration-baseline-content"]').text()).toContain(
        '14000',
      ),
    );
  });

  it('creates a customer and edits from the detail drawer', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/customers') && init?.method === 'POST') return apiResponse({ id: 'cu2' });
      if (/\/customers\/cu1$/.test(url) && init?.method === 'PATCH')
        return apiResponse({ id: 'cu1' });
      if (/\/customers\/cu1$/.test(url))
        return apiResponse({
          id: 'cu1',
          name: 'Acme',
          code: 'ACME',
          status: 'active',
          contact_email: 'ops@acme.test',
          quota_daily: 1000,
          rate_limit_per_min: 60,
          allowed_sender_ids: ['ACME'],
          notes: 'VIP',
        });
      return apiResponse(gridPage([{ id: 'cu1', name: 'Acme', code: 'ACME', status: 'active' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/customers', 'Customers');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Acme'));
    expect(wrapper.find('[data-testid="customers-help"]').exists()).toBe(true);

    // Create a customer.
    await wrapper.get('[data-testid="primary-action"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="create-customer-form"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="customer-name"]').setValue('Globex');
    await wrapper.get('[data-testid="customer-code"]').setValue('GLBX');
    await wrapper.get('[data-testid="customer-senders"]').setValue('GLBX, INFO');
    await wrapper.get('[data-testid="customer-quota"]').setValue(500);
    await wrapper.get('[data-testid="customer-submit"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]).endsWith('/customers') && call[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post)).toMatchObject({
        name: 'Globex',
        code: 'GLBX',
        allowedSenderIds: ['GLBX', 'INFO'],
        quotaDaily: 500,
        status: 'active',
      });
    });

    // Open detail and edit.
    await wrapper.get('[data-testid="record-cu1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="customer-detail-status"]').text()).toBe('active'),
    );
    await wrapper.get('[data-testid="customer-edit"]').trigger('click');
    await wrapper.get('[data-testid="customer-edit-status"]').setValue('suspended');
    await wrapper.get('[data-testid="customer-save"]').trigger('click');
    await vi.waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => /\/customers\/cu1$/.test(String(call[0])) && call[1]?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(bodyOf(patch)).toMatchObject({ status: 'suspended' });
    });
  });

  it('downloads a sample plugin manifest as plugin.json', async () => {
    const click = stubDownloads();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/plugins/sample-manifest'))
        return apiResponse({ pluginId: 'sample', name: 'Sample', version: '1.0.0' });
      return apiResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/plugins', 'Plugins');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    expect(wrapper.find('[data-testid="plugins-developer"]').exists()).toBe(true);

    await wrapper.get('[data-testid="download-sample-plugin"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/plugins/sample-manifest')),
    ).toBe(true);
  });

  it('renders an API gateway documentation panel', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/api-gateway', 'API Gateway');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    const docs = wrapper.get('[data-testid="api-gateway-docs"]').text();
    expect(docs).toContain('shown exactly once');
    expect(docs).toContain('openapi.json');
    expect(docs).toContain('Bearer');
  });

  it('opens a volume snapshot detail with related breakdown from the reports grid', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (/\/reports\/volume\/rep-1$/.test(url))
        return apiResponse({
          snapshot: { id: 'rep-1', message_count: 120 },
          related: [
            { scope: 'smsc', label: 'primary', message_count: 80, dlr_count: 60 },
            { scope: 'route', label: 'east', message_count: 40, dlr_count: 30 },
          ],
        });
      if (url.includes('/reports/delivery'))
        return apiResponse({ items: [], summary: { total: 0 }, source: 'kamex-sqlbox' });
      return apiResponse(
        gridPage([
          {
            id: 'rep-1',
            period_type: 'daily',
            period_start: '2026-07-08',
            scope: 'total',
            message_count: 120,
            dlr_count: 88,
            generated_at: '2026-07-09',
          },
        ]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/reports', 'Reports');
    await vi.waitFor(() => expect(wrapper.text()).toContain('120'));

    await wrapper.get('[data-testid="record-rep-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="snapshot-panel"]').exists()).toBe(true),
    );
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="snapshot-related"]').text()).toContain('smsc'),
    );
    const related = wrapper.get('[data-testid="snapshot-related"]').text();
    expect(related).toContain('route');
    expect(related).toContain('80');
    expect(related).toContain('40');
  });
});
