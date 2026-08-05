import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set(['system.manage']),
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
const records = [
  {
    id: 'record-1',
    name: 'Primary record',
    detail: 'Operational',
    status: 'Active',
    updatedAt: 'now',
  },
  { id: 'record-2', name: 'Secondary record', status: 'Draft' },
];
const gridPage = (items: unknown[], total = items.length, limit = 50, offset = 0) => ({
  items,
  total,
  limit,
  offset,
});
const stubDownloads = () => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:jkannel-export'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
};

describe('module workspace behavior', () => {
  /**
   * Regression: Customers, API Gateway, Plugins and Backup had no grid config,
   * so each loaded the API's default first page (50 rows), rendered no pager,
   * and searched only those rows in the browser — while the backend exposed a
   * full search/sort/filter whitelist for all four. Row 51 was unreachable and
   * a search that "found nothing" had never looked past page one.
   */
  it('sends the customers search, sort and filter to the API and pages the result', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        apiResponse(String(url).includes('search=') ? gridPage([], 0) : gridPage(records, 120)),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/customers', 'Customers');
    await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2));

    // The pager exists at all, and knows there are more than one page of rows.
    expect(wrapper.get('[data-testid="grid-range"]').text()).toContain('120');
    // Sort and filter controls are offered because the API honours them.
    expect(wrapper.get('[data-testid="grid-sort"]').findAll('option').length).toBe(4);
    expect(wrapper.find('[data-testid="grid-filter-status"]').exists()).toBe(true);

    await wrapper.get('[data-testid="workspace-search"]').setValue('no-such-customer');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('search=no-such-customer')),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="empty-state"]').text()).toBe(
        'No records match these filters.',
      ),
    );
    wrapper.unmount();
  });

  /**
   * Regression: the Messages search box searched nothing.
   *
   * It never triggered a request (the debounce watcher only fired for grid and
   * cursor workspaces), and `visibleRows` then filtered the API's own matches
   * against `id name detail status` — fields a SQLBox message row does not
   * carry. Searching a recipient or message body matched on the server and was
   * discarded in the browser, so the operator saw "No records match".
   */
  it('sends the messages search term to the API and keeps the rows it returns', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse(records));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2));

    await wrapper.get('[data-testid="workspace-search"]').setValue('+256700000000');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('query=%2B256700000000')),
      ).toBe(true),
    );
    // The server answered with rows; none of them may be filtered back out here.
    await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2));

    // And the coarse client-side Status dropdown is gone: Messages has a real
    // server-side "Delivery status" filter, and two Status controls with
    // different vocabularies on one screen contradicted each other.
    expect(wrapper.find('[data-testid="status-filter"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('creates a route with target/fallback SMSC dropdowns and labels row actions for assistive technology', async () => {
    const smscRows = [
      { id: 'smsc-1', engine_id: 'primary-smpp', name: 'Primary SMPP' },
      { id: 'smsc-2', engine_id: 'backup-smpp', name: 'Backup SMPP' },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/smscs')) return apiResponse(gridPage(smscRows));
      return apiResponse(gridPage(records));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/routing', 'Routing');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="primary-action"]').trigger('click');
    expect(wrapper.get('section[aria-label="Create route"] h2').text()).toBe('Create route');

    // Target/fallback are dropdowns populated from GET /smscs (value = SMSC id).
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="draft-target"]').findAll('option').length).toBe(3),
    );
    expect(wrapper.get('[data-testid="draft-fallback"]').findAll('option').length).toBe(3);
    expect(wrapper.get('[data-testid="draft-target"]').text()).toContain('primary-smpp');

    await wrapper.get('[data-testid="draft-name"]').setValue('East Africa fallback');
    await wrapper.get('[data-testid="draft-target"]').setValue('smsc-1');
    await wrapper.get('[data-testid="draft-fallback"]').setValue('smsc-2');
    await wrapper.get('[data-testid="save-draft"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]).endsWith('/routes') && call[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        name: 'East Africa fallback',
        priority: 100,
        targetSmscId: 'smsc-1',
        fallbackSmscId: 'smsc-2',
      });
    });
    expect(wrapper.get('th').attributes('scope')).toBe('col');
  });

  it('refreshes a read-only workspace through its primary action', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse(records));
    vi.stubGlobal('fetch', fetchMock);
    const monitoring = await mountWorkspace('/monitoring', 'Monitoring');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(monitoring.attributes('aria-busy')).toBe('false'));
    await monitoring.get('[data-testid="primary-action"]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(monitoring.attributes('aria-busy')).toBe('false'));
    expect(monitoring.text()).toContain('2 records shown');
  });

  it('offers SQLBox export and retention controls for the messages workspace', async () => {
    const click = stubDownloads();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/messages/export.csv')) {
        expect(init?.headers).toBeTruthy();
        return Promise.resolve(
          new Response('id,status\r\n1,sent', {
            status: 200,
            headers: {
              'x-jkannel-export-row-count': '1',
              'content-disposition': 'attachment; filename="messages.csv"',
            },
          }),
        );
      }
      if (url.includes('/messages/retention/status')) {
        return apiResponse({ eligibleRows: 2, totalRows: 10, retentionDays: 90 });
      }
      return apiResponse(records);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    await wrapper.get('[data-testid="export-messages"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(wrapper.text()).toContain('Exported 1 SQLBox rows.'));

    await wrapper.get('[data-testid="retention-dry-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="retention-result"]').text()).toContain(
        '2 of 10 SQLBox rows',
      ),
    );
    click.mockRestore();
  });

  it('renders loading, API error, unavailable, and empty states safely', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const loading = await mountWorkspace('/messages', 'Messages');
    expect(loading.attributes('aria-busy')).toBe('true');
    expect(loading.text()).toContain('Loading records');
    resolve(new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
    await vi.waitFor(() =>
      expect(loading.get('[data-testid="empty-state"]').text()).toContain('No message records'),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, message: 'Endpoint pending' }), {
        status: 501,
      }),
    );
    await loading.get('[data-testid="primary-action"]').trigger('click');
    await vi.waitFor(() =>
      expect(loading.get('[data-testid="api-state"]').text()).toContain(
        'Workspace API not available yet',
      ),
    );
    expect(loading.get('[role="alert"]').text()).toContain('Endpoint pending');
  });

  it('builds server-side grid queries for search, sort, filters, and pagination', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse(gridPage(records, 120, 50, 0)));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/alerts', 'Alerts');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    // Initial load applies the module default sort and page bounds.
    expect(fetchMock.mock.calls[0][0]).toContain('/alerts?sort=-openedAt&limit=50&offset=0');
    expect(wrapper.get('[data-testid="grid-range"]').text()).toBe('Showing 1–2 of 120');

    // The search input is debounced before it reaches the server.
    await wrapper.get('[data-testid="workspace-search"]').setValue('gateway');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(fetchMock.mock.calls[1][0]).toContain('search=gateway');
    expect(fetchMock.mock.calls[1][0]).toContain('sort=-openedAt');

    // Sort field and direction changes reload immediately.
    await wrapper.get('[data-testid="grid-sort"]').setValue('severity');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toContain('sort=-severity');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="grid-sort-direction"]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3][0]).toContain('sort=severity');

    // Enum filters render as dropdowns and produce filter.<field> params.
    await wrapper.get('[data-testid="grid-filter-status"]').setValue('open');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock.mock.calls[4][0]).toContain('filter.status=open');

    // Pagination advances the offset and keeps every other parameter.
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="grid-next"]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(fetchMock.mock.calls[5][0]).toContain('offset=50');
    expect(fetchMock.mock.calls[5][0]).toContain('filter.status=open');
  });

  it('normalizes both bare arrays and grid envelopes defensively', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => apiResponse(records));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/alerts', 'Alerts');
    await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2));
    expect(wrapper.get('[data-testid="grid-range"]').text()).toBe('Showing 1–2 of 2');
  });

  it('exports grid workspaces as CSV and PDF with the active filters', async () => {
    const click = stubDownloads();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/smscs/export.pdf'))
        return Promise.resolve(
          new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="smscs.pdf"',
              'x-jkannel-export-row-count': '2',
            },
          }),
        );
      if (url.includes('/smscs/export.csv'))
        return Promise.resolve(
          new Response('id,name\r\n1,one', {
            status: 200,
            headers: {
              'content-disposition': 'attachment; filename="smscs.csv"',
              'x-jkannel-export-row-count': '2',
            },
          }),
        );
      return apiResponse(gridPage(records));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/smsc', 'SMSC Manager');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    await wrapper.get('[data-testid="export-csv"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const csvCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/smscs/export.csv'),
    );
    expect(csvCall?.[0]).toContain('limit=500');

    await wrapper.get('[data-testid="export-pdf"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(wrapper.text()).toContain('Exported 2 rows as PDF.'));
    click.mockRestore();
  });

  it('shows the volume report grid with a permission-gated generate action', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/reports/volume/run') && init?.method === 'POST')
        return apiResponse({ results: [] });
      if (url.includes('/reports/volume'))
        return apiResponse(
          gridPage([
            {
              id: 'v1',
              period_type: 'daily',
              period_start: '2026-07-08',
              period_end: '2026-07-09',
              scope: 'total',
              scope_label: null,
              message_count: 120,
              dlr_count: 88,
              generated_at: '2026-07-09T00:05:00Z',
            },
          ]),
        );
      if (url.includes('/reports/delivery'))
        return apiResponse({
          items: [],
          summary: { total: 3 },
          source: { status: 'available', type: 'kamex-sqlbox' },
        });
      return apiResponse(gridPage([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/reports', 'Reports');
    await vi.waitFor(() => expect(wrapper.text()).toContain('120'));
    expect(fetchMock.mock.calls[0][0]).toContain('/reports/volume?sort=-periodStart');
    expect(wrapper.find('[data-testid="grid-filter-periodType"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="grid-filter-scope"]').exists()).toBe(true);
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="delivery-summary"]').text()).toContain(
        '3 delivery receipts',
      ),
    );

    await wrapper.get('[data-testid="generate-reports"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes('/reports/volume/run') &&
            (call[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(wrapper.text()).toContain('Volume report generation completed'));
  });

  it('renders the audit trail columns for the logs-audit workspace', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      apiResponse(
        gridPage([
          {
            id: 'evt-1',
            created_at: '2026-07-09T05:00:00Z',
            actor_id: 'user-7',
            action: 'route.deploy',
            entity_type: 'route',
            entity_id: 'route-9',
            reason: 'deploy requested from console',
            correlation_id: 'corr-42',
            source_ip: '10.0.0.9',
          },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/logs-audit', 'Logs & Audit');
    await vi.waitFor(() => expect(wrapper.text()).toContain('route.deploy'));
    expect(fetchMock.mock.calls[0][0]).toContain('/audit-events?sort=-createdAt');
    const headers = wrapper.findAll('th').map((th) => th.text());
    expect(headers).toEqual(
      expect.arrayContaining([
        'When',
        'Actor',
        'Action',
        'Entity',
        'Reason',
        'Correlation',
        'Source IP',
      ]),
    );
    const row = wrapper.get('[data-testid="record-evt-1"]').text();
    expect(row).toContain('user-7');
    expect(row).toContain('corr-42');
    expect(row).toContain('10.0.0.9');
    expect(wrapper.find('[data-testid="export-csv"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="export-pdf"]').exists()).toBe(true);
  });

  it('lists notifications and marks a single one as read', async () => {
    let read = false;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/notifications/n1/read') && init?.method === 'POST') {
        read = true;
        return apiResponse({ id: 'n1' });
      }
      if (url.includes('/notifications'))
        return apiResponse(
          gridPage([
            {
              id: 'n1',
              category: 'reports',
              title: 'Daily volume report ready',
              body: 'Snapshot generated.',
              read_at: read ? '2026-07-09T06:00:00Z' : null,
              created_at: '2026-07-09T05:00:00Z',
            },
          ]),
        );
      return apiResponse(gridPage([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/notifications', 'Notifications');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Daily volume report ready'));
    expect(wrapper.get('[data-testid="record-n1"]').text()).toContain('unread');

    await wrapper.get('[data-testid="mark-read-n1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mark-read-n1"]').exists()).toBe(false),
    );
    expect(wrapper.get('[data-testid="record-n1"]').text()).toContain('read');
  });

  it('requires an SMSC engine id before submitting a message', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/smscs'))
        return apiResponse(
          gridPage([
            { id: 'uuid-1', engine_id: 'primary-smpp', name: 'Primary SMPP', type: 'smpp' },
          ]),
        );
      if (url.includes('/messages') && init?.method === 'POST') return apiResponse({ id: 9 });
      return apiResponse({ items: records, nextCursor: null, source: 'kamex-sqlbox' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));

    await wrapper.get('[data-testid="open-send-message"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="send-smsc"]').findAll('option')).toHaveLength(2),
    );
    await wrapper.get('[data-testid="send-sender"]').setValue('JKANNEL');
    await wrapper.get('[data-testid="send-receiver"]').setValue('+256700000001');
    await wrapper.get('[data-testid="send-text"]').setValue('Hello from the console');
    expect(wrapper.get('[data-testid="send-submit"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="send-smsc"]').setValue('primary-smpp');
    expect(wrapper.get('[data-testid="send-submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="send-submit"]').trigger('click');
    await vi.waitFor(() => {
      const submit = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/messages') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(submit).toBeTruthy();
      expect(JSON.parse(String((submit?.[1] as RequestInit | undefined)?.body))).toEqual({
        sender: 'JKANNEL',
        receiver: '+256700000001',
        text: 'Hello from the console',
        smscId: 'primary-smpp',
      });
    });
  });

  const sendMock = () =>
    vi.fn().mockImplementation((url: string) => {
      if (url.includes('/smscs'))
        return apiResponse(
          gridPage([{ id: 'uuid-1', engine_id: 'primary-smpp', name: 'Primary SMPP' }]),
        );
      return apiResponse({ items: records, nextCursor: null, source: 'kamex-sqlbox' });
    });

  it('counts segments live in the single-message composer', async () => {
    vi.stubGlobal('fetch', sendMock());
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="open-send-message"]').trigger('click');

    const body = wrapper.get('[data-testid="send-text"]');
    await body.setValue('a'.repeat(160));
    expect(wrapper.get('[data-testid="send-segment-segments"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="send-segment-remaining"]').text()).toBe('0');
    expect(wrapper.find('[data-testid="send-segment-multipart-warning"]').exists()).toBe(false);

    await body.setValue('a'.repeat(161));
    expect(wrapper.get('[data-testid="send-segment-segments"]').text()).toBe('2');
    expect(wrapper.find('[data-testid="send-segment-multipart-warning"]').exists()).toBe(true);

    // A single emoji is one character, two UCS-2 units, and collapses the limit.
    await body.setValue('Thanks 🙂');
    expect(wrapper.get('[data-testid="send-segment-characters"]').text()).toBe('8');
    expect(wrapper.get('[data-testid="send-segment-alphabet"]').text()).toBe('UCS-2');
    expect(wrapper.get('[data-testid="send-segment-remaining"]').text()).toBe('61');
    expect(wrapper.get('[data-testid="send-segment-ucs2-warning"]').text()).toContain('160 to 70');
  });

  it('schedules a single message as scheduledAt + validityMinutes, rejecting the past', async () => {
    const fetchMock = sendMock();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountWorkspace('/messages', 'Messages');
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await wrapper.get('[data-testid="open-send-message"]').trigger('click');
    await wrapper.get('[data-testid="send-sender"]').setValue('JKANNEL');
    await wrapper.get('[data-testid="send-receiver"]').setValue('+256700000001');
    await wrapper.get('[data-testid="send-text"]').setValue('Balance due');
    await wrapper.get('[data-testid="send-smsc"]').setValue('primary-smpp');

    // Send now is the default and posts no schedule.
    expect(wrapper.find('[data-testid="send-schedule-datetime"]').exists()).toBe(false);

    await wrapper.get('[data-testid="send-schedule-later"]').trigger('click');
    // Committing to Send later with no time chosen blocks submission.
    expect(wrapper.get('[data-testid="send-schedule-error"]').text()).toContain(
      'Choose the date and time',
    );
    expect(wrapper.get('[data-testid="send-submit"]').attributes('disabled')).toBeDefined();

    // A past instant is rejected in the UI, before any request is made.
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const local = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(
        date.getMinutes(),
      ).padStart(2, '0')}`;
    await wrapper.get('[data-testid="send-schedule-datetime"]').setValue(local(past));
    expect(wrapper.get('[data-testid="send-schedule-error"]').text()).toContain('in the past');
    expect(wrapper.get('[data-testid="send-submit"]').attributes('disabled')).toBeDefined();

    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await wrapper.get('[data-testid="send-schedule-datetime"]').setValue(local(future));
    // Validity must outlast the wait, or the message expires before delivery.
    await wrapper.get('[data-testid="send-schedule-validity"]').setValue('5');
    expect(wrapper.get('[data-testid="send-schedule-error"]').text()).toContain(
      'must be longer than',
    );
    await wrapper.get('[data-testid="send-schedule-validity"]').setValue('240');
    expect(wrapper.find('[data-testid="send-schedule-error"]').exists()).toBe(false);
    // The honest caveat about what deferral actually is.
    expect(wrapper.get('[data-testid="send-schedule-caveat"]').text()).toContain(
      'request to the carrier',
    );

    await wrapper.get('[data-testid="send-submit"]').trigger('click');
    await vi.waitFor(() => {
      const submit = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/messages') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(submit).toBeTruthy();
      expect(JSON.parse(String((submit?.[1] as RequestInit | undefined)?.body))).toEqual({
        sender: 'JKANNEL',
        receiver: '+256700000001',
        text: 'Balance due',
        smscId: 'primary-smpp',
        scheduledAt: new Date(local(future)).toISOString(),
        validityMinutes: 240,
      });
    });
  });
});
