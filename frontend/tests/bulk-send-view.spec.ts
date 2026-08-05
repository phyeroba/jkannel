import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set(['messages.view', 'configuration.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import BulkSendView from '../src/views/BulkSendView.vue';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

const job = (id: string, name: string, status = 'completed') => ({
  id,
  name,
  status,
  total: 3,
  submitted: 3,
  failed: 0,
  sender: 'JKANNEL',
  smsc_id: 'smsc-primary',
  created_at: '2026-08-04T10:00:00Z',
});

const smscs = {
  items: [{ id: 's1', name: 'Primary', engine_id: 'smsc-primary' }],
  total: 1,
};

function liveMock(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/smscs')) return apiResponse(smscs);
    if (target.includes('/bulk-send') && init?.method === 'POST')
      return apiResponse(overrides.created ?? job('job-new', 'July reminder', 'queued'));
    if (/\/bulk-send\/[^/]+\/recipients/.test(target))
      return apiResponse(
        overrides.recipients ?? {
          items: [
            {
              id: 'r1',
              receiver: '+256700000001',
              status: 'submitted',
              foreign_id: '9001',
              created_at: '2026-08-04T10:00:01Z',
            },
            {
              id: 'r2',
              receiver: '+256700000002',
              status: 'failed',
              error: 'rejected by SMSC',
              created_at: '2026-08-04T10:00:02Z',
            },
          ],
          total: 2,
          limit: 50,
          offset: 0,
        },
      );
    if (/\/bulk-send\/[^/?]+$/.test(target.split('?')[0]))
      return apiResponse(
        overrides.detail ?? {
          ...job('job-new', 'July reminder', 'completed'),
          recipientCounts: { submitted: 2, failed: 1 },
        },
      );
    if (target.includes('/bulk-send'))
      return apiResponse(
        overrides.jobs ?? {
          items: [job('job-1', 'April notice'), job('job-2', 'May notice', 'failed')],
          total: 2,
          limit: 50,
          offset: 0,
        },
      );
    return apiResponse({});
  });
}

async function mountView(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/bulk-send', name: 'bulk-send', component: BulkSendView, meta: { title: 'Bulk' } },
      { path: '/messages', name: 'messages', component: { template: '<div />' } },
      { path: '/delivery-reports', name: 'dlr', component: { template: '<div />' } },
      { path: '/live-queue', name: 'live-queue', component: { template: '<div />' } },
    ],
  });
  await router.push('/bulk-send');
  await router.isReady();
  const wrapper = mount(BulkSendView, { global: { plugins: [router] } });
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="bulk-job-job-1"]').exists()).toBe(true),
  );
  return wrapper;
}

/** A `datetime-local` value `offsetMs` from now, in the local zone. */
const localAt = (offsetMs: number) => {
  const date = new Date(Date.now() + offsetMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const stubDownloads = () => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:jkannel-export'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
};

describe('Bulk Send view', () => {
  it('counts segments live as the campaign body is typed', async () => {
    const wrapper = await mountView(liveMock());
    const body = wrapper.get('[data-testid="bulk-message"]');

    await body.setValue('Short reminder');
    expect(wrapper.get('[data-testid="bulk-segment-segments"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="bulk-segment-alphabet"]').text()).toBe('GSM-7');
    expect(wrapper.get('[data-testid="bulk-segment-remaining"]').text()).toBe('146');
    expect(wrapper.find('[data-testid="bulk-segment-multipart-warning"]').exists()).toBe(false);

    // 161 GSM-7 septets tips into a second segment and warns.
    await body.setValue('a'.repeat(161));
    expect(wrapper.get('[data-testid="bulk-segment-segments"]').text()).toBe('2');
    expect(wrapper.get('[data-testid="bulk-segment-multipart-warning"]').text()).toContain(
      '2 segments',
    );

    // One curly apostrophe collapses the limit from 160 to 70.
    await body.setValue(`${'a'.repeat(80)}’`);
    const ucs2 = wrapper.get('[data-testid="bulk-segment-ucs2-warning"]').text();
    expect(wrapper.get('[data-testid="bulk-segment-alphabet"]').text()).toBe('UCS-2');
    expect(ucs2).toContain('UCS-2 encoding forced');
    expect(ucs2).toContain('160 to 70');
    expect(ucs2).toContain('’');
  });

  it('projects the campaign cost as segments × recipients', async () => {
    const wrapper = await mountView(liveMock());
    await wrapper.get('[data-testid="bulk-message"]').setValue('a'.repeat(161));
    await wrapper.get('[data-testid="bulk-recipients"]').setValue('+256700000001\n+256700000002');
    expect(wrapper.get('[data-testid="bulk-total-cost"]').text()).toBe('4');
  });

  it('sends now by default, posting no schedule field at all', async () => {
    const fetchMock = liveMock();
    const wrapper = await mountView(fetchMock);
    expect(wrapper.find('[data-testid="bulk-schedule-datetime"]').exists()).toBe(false);
    await wrapper.get('[data-testid="bulk-name"]').setValue('July reminder');
    await wrapper.get('[data-testid="bulk-smsc"]').setValue('smsc-primary');
    await wrapper.get('[data-testid="bulk-message"]').setValue('Balance due');
    await wrapper.get('[data-testid="bulk-recipients"]').setValue('+256700000001');
    await wrapper.get('[data-testid="bulk-submit"]').trigger('click');

    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      name: 'July reminder',
      smscId: 'smsc-primary',
      message: 'Balance due',
      recipients: ['+256700000001'],
    });
  });

  it('schedules a campaign as scheduledAt + validityMinutes, rejecting a past time', async () => {
    const fetchMock = liveMock();
    const wrapper = await mountView(fetchMock);
    await wrapper.get('[data-testid="bulk-name"]').setValue('July reminder');
    await wrapper.get('[data-testid="bulk-smsc"]').setValue('smsc-primary');
    await wrapper.get('[data-testid="bulk-message"]').setValue('Balance due');
    await wrapper.get('[data-testid="bulk-recipients"]').setValue('+256700000001');

    await wrapper.get('[data-testid="bulk-schedule-later"]').trigger('click');
    expect(wrapper.get('[data-testid="bulk-submit"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="bulk-schedule-datetime"]').setValue(localAt(-60 * 60 * 1000));
    expect(wrapper.get('[data-testid="bulk-schedule-error"]').text()).toContain('in the past');
    expect(wrapper.get('[data-testid="bulk-submit"]').attributes('disabled')).toBeDefined();

    const future = localAt(3 * 60 * 60 * 1000);
    await wrapper.get('[data-testid="bulk-schedule-datetime"]').setValue(future);
    await wrapper.get('[data-testid="bulk-schedule-validity"]').setValue('600');
    expect(wrapper.find('[data-testid="bulk-schedule-error"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="bulk-schedule-iso"]').text()).toContain(
      new Date(future).toISOString(),
    );
    expect(wrapper.get('[data-testid="bulk-submit"]').text()).toContain('Schedule campaign');

    await wrapper.get('[data-testid="bulk-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      name: 'July reminder',
      smscId: 'smsc-primary',
      message: 'Balance due',
      recipients: ['+256700000001'],
      scheduledAt: new Date(future).toISOString(),
      validityMinutes: 600,
    });
  });

  it('refuses a validity that would expire before the scheduled delivery', async () => {
    const wrapper = await mountView(liveMock());
    await wrapper.get('[data-testid="bulk-schedule-later"]').trigger('click');
    await wrapper
      .get('[data-testid="bulk-schedule-datetime"]')
      .setValue(localAt(4 * 60 * 60 * 1000));
    await wrapper.get('[data-testid="bulk-schedule-validity"]').setValue('30');
    expect(wrapper.get('[data-testid="bulk-schedule-error"]').text()).toContain(
      'must be longer than',
    );
  });

  it('tells the operator where the traffic will appear, with links', async () => {
    const wrapper = await mountView(liveMock());
    await wrapper.get('[data-testid="bulk-name"]').setValue('July reminder');
    await wrapper.get('[data-testid="bulk-smsc"]').setValue('smsc-primary');
    await wrapper.get('[data-testid="bulk-message"]').setValue('Balance due');
    await wrapper.get('[data-testid="bulk-recipients"]').setValue('+256700000001\n+256700000002');
    await wrapper.get('[data-testid="bulk-submit"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bulk-send-notice"]').exists()).toBe(true),
    );
    const panel = wrapper.get('[data-testid="bulk-send-notice-panel"]');
    expect(panel.text()).toContain('2 recipient(s) × 1 segment(s) = 2 SMS');
    expect(panel.text()).toContain('does not sit in the Live Queue spool');
    expect(panel.get('[data-testid="followup-messages"]').attributes('href')).toBe('/messages');
    expect(panel.get('[data-testid="followup-delivery"]').attributes('href')).toBe(
      '/delivery-reports',
    );
    expect(panel.find('[data-testid="followup-job"]').exists()).toBe(true);
  });

  it('surfaces the API rejection verbatim', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/smscs')) return apiResponse(smscs);
      if (init?.method === 'POST') return apiResponse('recipients[0] must be a valid MSISDN', 400);
      return apiResponse({ items: [job('job-1', 'April notice')], total: 1 });
    });
    const wrapper = await mountView(fetchMock);
    await wrapper.get('[data-testid="bulk-name"]').setValue('Bad campaign');
    await wrapper.get('[data-testid="bulk-smsc"]').setValue('smsc-primary');
    await wrapper.get('[data-testid="bulk-message"]').setValue('Hi');
    await wrapper.get('[data-testid="bulk-recipients"]').setValue('nope');
    await wrapper.get('[data-testid="bulk-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="bulk-form-error"]').text()).toBe(
        'recipients[0] must be a valid MSISDN',
      ),
    );
  });

  it('searches, filters, sorts and page-sizes the jobs grid server-side', async () => {
    const fetchMock = liveMock();
    const wrapper = await mountView(fetchMock);
    const lastJobsUrl = () =>
      String(
        fetchMock.mock.calls
          .map((call) => String(call[0]))
          .filter((url) => url.includes('/bulk-send?'))
          .at(-1),
      );

    // The first load already carries the shared grid vocabulary.
    expect(lastJobsUrl()).toContain('sort=-createdAt');
    expect(lastJobsUrl()).toContain('paginate=cursor');
    expect(lastJobsUrl()).toContain('limit=50');

    await wrapper.get('[data-testid="bulk-jobs-search"]').setValue('April');
    await wrapper.get('[data-testid="bulk-jobs-search"]').trigger('change');
    await vi.waitFor(() => expect(lastJobsUrl()).toContain('search=April'));

    await wrapper.get('[data-testid="bulk-jobs-status"]').setValue('failed');
    await vi.waitFor(() => expect(lastJobsUrl()).toContain('filter.status=failed'));

    await wrapper.get('[data-testid="bulk-jobs-limit"]').setValue('200');
    await vi.waitFor(() => expect(lastJobsUrl()).toContain('limit=200'));

    // Sort is a server parameter, ascending first, then descending.
    await wrapper.get('[data-testid="bulk-jobs-sort-name"]').trigger('click');
    await vi.waitFor(() => expect(lastJobsUrl()).toContain('sort=name'));
    await wrapper.get('[data-testid="bulk-jobs-sort-name"]').trigger('click');
    await vi.waitFor(() => expect(lastJobsUrl()).toContain('sort=-name'));
  });

  it('pages the jobs grid by cursor rather than by a deep offset', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/smscs')) return apiResponse(smscs);
      return apiResponse({
        items: [job('job-1', 'April notice')],
        total: null,
        nextCursor: target.includes('cursor=page-2') ? null : 'page-2',
      });
    });
    const wrapper = await mountView(fetchMock);
    expect(wrapper.get('[data-testid="bulk-jobs-prev"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="bulk-jobs-next"]').trigger('click');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('cursor=page-2'))).toBe(
        true,
      ),
    );
    const paged = fetchMock.mock.calls.find((call) => String(call[0]).includes('cursor=page-2'))!;
    // Keyset, not offset — that is the point of the change.
    expect(String(paged[0])).not.toContain('offset=');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="bulk-jobs-pager-label"]').text()).toContain('Page 2'),
    );

    // Going back replays the previous cursor.
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="bulk-jobs-prev"]').attributes('disabled')).toBeUndefined(),
    );
    await wrapper.get('[data-testid="bulk-jobs-prev"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="bulk-jobs-pager-label"]').text()).toContain('Page 1'),
    );
  });

  it('exports the jobs grid server-side with the active filters', async () => {
    const click = stubDownloads();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/smscs')) return apiResponse(smscs);
      if (target.includes('/bulk-send/export.csv'))
        return Promise.resolve(
          new Response('id,name', {
            status: 200,
            headers: {
              'content-disposition': 'attachment; filename="jobs.csv"',
              'x-jkannel-export-row-count': '17',
            },
          }),
        );
      return apiResponse({ items: [job('job-1', 'April notice')], nextCursor: null });
    });
    const wrapper = await mountView(fetchMock);
    await wrapper.get('[data-testid="bulk-jobs-status"]').setValue('failed');
    await vi.waitFor(() =>
      expect(
        wrapper.get('[data-testid="bulk-jobs-export"]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await wrapper.get('[data-testid="bulk-jobs-export"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());

    const exportUrl = String(
      fetchMock.mock.calls.find((call) => String(call[0]).includes('/bulk-send/export.csv'))?.[0],
    );
    expect(exportUrl).toContain('filter.status=failed');
    expect(exportUrl).toContain('sort=-createdAt');
    // The export is the whole filtered set, so it inherits no paging at all —
    // including `limit`, which the API only defaults to its maximum when the
    // caller sends none. Passing the screen's page size would cap the file.
    expect(exportUrl).not.toContain('cursor=');
    expect(exportUrl).not.toContain('paginate=');
    expect(exportUrl).not.toContain('limit=');
    expect(wrapper.get('[data-testid="bulk-send-notice"]').text()).toContain('Exported 17');
  });

  it('searches, filters, sorts, pages and exports the recipients grid', async () => {
    const click = stubDownloads();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/smscs')) return apiResponse(smscs);
      if (target.includes('/recipients/export.csv'))
        return Promise.resolve(
          new Response('id,receiver', {
            status: 200,
            headers: {
              'content-disposition': 'attachment; filename="recipients.csv"',
              'x-jkannel-export-row-count': '42',
            },
          }),
        );
      if (target.includes('/recipients'))
        return apiResponse({
          items: [{ id: 'r1', receiver: '+256700000001', status: 'failed' }],
          nextCursor: target.includes('cursor=r-2') ? null : 'r-2',
        });
      if (/\/bulk-send\/[^/?]+$/.test(target.split('?')[0]))
        return apiResponse({ ...job('job-1', 'April notice'), recipientCounts: { failed: 1 } });
      return apiResponse({ items: [job('job-1', 'April notice')], nextCursor: null });
    });
    const wrapper = await mountView(fetchMock);
    await wrapper.get('[data-testid="bulk-job-job-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bulk-recipient-0"]').exists()).toBe(true),
    );
    const lastRecipientsUrl = () =>
      String(
        fetchMock.mock.calls
          .map((call) => String(call[0]))
          .filter((url) => url.includes('/recipients?'))
          .at(-1),
      );

    await wrapper.get('[data-testid="bulk-recipients-status"]').setValue('failed');
    await vi.waitFor(() => expect(lastRecipientsUrl()).toContain('filter.status=failed'));
    expect(lastRecipientsUrl()).toContain('paginate=cursor');

    await wrapper.get('[data-testid="bulk-recipients-search"]').setValue('+2567');
    await wrapper.get('[data-testid="bulk-recipients-search"]').trigger('change');
    await vi.waitFor(() => expect(lastRecipientsUrl()).toContain('search='));

    await wrapper.get('[data-testid="bulk-recipients-sort-receiver"]').trigger('click');
    await vi.waitFor(() => expect(lastRecipientsUrl()).toContain('sort=receiver'));

    await wrapper.get('[data-testid="bulk-recipients-next"]').trigger('click');
    await vi.waitFor(() => expect(lastRecipientsUrl()).toContain('cursor=r-2'));
    expect(lastRecipientsUrl()).not.toContain('offset=');

    await wrapper.get('[data-testid="bulk-recipients-export"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    const exportUrl = String(
      fetchMock.mock.calls.find((call) => String(call[0]).includes('/recipients/export.csv'))?.[0],
    );
    expect(exportUrl).toContain('filter.status=failed');
    expect(exportUrl).not.toContain('cursor=');
    expect(exportUrl).not.toContain('limit=');
    expect(wrapper.get('[data-testid="bulk-detail-notice"]').text()).toContain('Exported 42');

    // `error` is in BULK_RECIPIENT_GRID.searchColumns but not sortColumns, so
    // it must not offer a sort control — and must not read as one that broke.
    expect(wrapper.find('[data-testid="bulk-recipients-sort-error"]').exists()).toBe(false);
    const errorHeader = wrapper.findAll('th').find((header) => header.text().startsWith('Error'))!;
    expect(errorHeader.get('.column-static').attributes('title')).toContain('not sortable');
    expect(errorHeader.attributes('aria-sort')).toBeUndefined();
    expect(wrapper.get('[data-testid="bulk-recipients-sort-note"]').text()).toContain(
      'not in the sort whitelist',
    );

    // Both bulk exports are CSV-only, and say so rather than leaving a reader
    // hunting for a PDF button that no route backs.
    expect(wrapper.get('[data-testid="bulk-recipients-csv-only"]').text()).toContain('CSV only');
    expect(wrapper.get('[data-testid="bulk-jobs-csv-only"]').text()).toContain(
      'no PDF route for this export',
    );
  });
});
