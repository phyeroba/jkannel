import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['messages.view', 'messages.send']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import MoRoutingView from '../src/views/MoRoutingView.vue';
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
const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

const SSRF_REJECTION =
  'webhook target host "169.254.169.254" is a loopback, link-local or private address. ' +
  'Set MO_WEBHOOK_ALLOW_PRIVATE=true only if forwarding to an internal service is intended.';

const rule = {
  id: 'rule-1',
  name: 'STOP keyword',
  description: 'Opt-out handling',
  enabled: true,
  priority: 10,
  match_smsc_id: null,
  match_destination: '4455',
  match_destination_type: 'exact',
  match_sender_prefix: null,
  match_keyword: 'STOP',
  match_keyword_type: 'first_word',
  case_sensitive: false,
  continue_after_match: false,
  customer_id: null,
  created_by: 'amina',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};
const destination = {
  id: 'dest-1',
  rule_id: 'rule-1',
  kind: 'webhook',
  target: 'https://example.com/hooks/mo',
  enabled: true,
  config: { method: 'POST' },
  max_attempts: 5,
  created_by: 'amina',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};
const ingestStatus = {
  id: 'state-1',
  watermark_sql_id: '4821',
  polling_enabled: false,
  poll_interval_seconds: 30,
  last_polled_at: '2026-08-04T10:00:00Z',
  last_error: null,
  ingested_total: '17',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-08-04T10:00:00Z',
};

function stubApi(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/smscs'))
      return apiResponse({ items: [{ id: 's1', name: 'Primary', engine_id: 'primary-smpp' }] });
    if (target.includes('/mo/ingest/status')) return apiResponse(overrides.ingest ?? ingestStatus);
    if (target.includes('/mo/ingest/sweep'))
      return apiResponse(
        overrides.sweep ?? {
          scanned: 3,
          ingested: 2,
          duplicates: 1,
          deliveries: 2,
          watermark: '4830',
          available: true,
        },
      );
    if (target.includes('/mo/ingest/polling'))
      return apiResponse({ ...ingestStatus, polling_enabled: true });
    if (target.includes('/mo/rules/preview')) return apiResponse(overrides.preview ?? {});
    if (/\/mo\/rules\/[^/]+\/destinations/.test(target) && init?.method === 'POST') {
      if (overrides.destinationError) return apiResponse(overrides.destinationError, 400);
      return apiResponse(destination);
    }
    if (/\/mo\/rules\/[^/?]+$/.test(target.split('?')[0]) && !init?.method)
      return apiResponse({ ...rule, destinations: [destination] });
    if (target.includes('/mo/rules'))
      return apiResponse(overrides.rules ?? { items: [rule], total: 1, limit: 50, offset: 0 });
    if (target.includes('/mo/messages')) {
      if (target.includes('filter.source=http'))
        return apiResponse({ items: [], total: overrides.httpTotal ?? 0 });
      if (target.includes('filter.source=sqlbox'))
        return apiResponse({ items: [], total: overrides.sqlboxTotal ?? 12 });
      return apiResponse({ items: [], total: 0 });
    }
    if (target.includes('/mo/deliveries'))
      return apiResponse(
        overrides.deliveries ?? {
          items: [
            {
              id: 'del-failed',
              kind: 'webhook',
              target: 'https://example.com/hooks/mo',
              rule_name: 'STOP keyword',
              status: 'failed',
              attempts: 3,
              max_attempts: 5,
              manual_retries: 0,
              last_error: 'refusing to POST to private host 10.0.0.5',
            },
            {
              id: 'del-pending',
              kind: 'email',
              target: 'ops@example.com',
              rule_name: 'STOP keyword',
              status: 'pending',
              attempts: 0,
              max_attempts: 5,
              manual_retries: 0,
              last_error: null,
            },
          ],
          total: 2,
        },
      );
    return apiResponse({ items: [], total: 0 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const mountView = async (fetchMock = stubApi()) => {
  const wrapper = mount(MoRoutingView);
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="mo-rule-rule-1"]').exists()).toBe(true),
  );
  return { wrapper, fetchMock };
};

describe('inbound (MO) routing view', () => {
  beforeEach(() => {
    grant('messages.view', 'messages.send');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('states which ingest path is active without claiming the push path is wired', async () => {
    const { wrapper } = await mountView();
    const sweep = wrapper.get('[data-testid="mo-ingest-sweep-claim"]').text();
    expect(sweep).toContain('the path that works on the topology deployed today');
    expect(sweep).toContain('needs no Kannel change');
    expect(sweep).toContain('4821');

    const push = wrapper.get('[data-testid="mo-ingest-push-claim"]').text();
    expect(push).toContain('cannot be confirmed from here');
    expect(push).toContain('none of them describes the push path');
    expect(push).toContain('cannot tell those two apart');

    const shipped = wrapper.get('[data-testid="mo-ingest-shipped-default"]').text();
    expect(shipped).toContain('No service specified');
    expect(shipped).toContain('forwards nothing to JKANNEL');
    wrapper.unmount();
  });

  it('reports observed per-path counts rather than guessing zero', async () => {
    const { wrapper } = await mountView(stubApi({ httpTotal: 0, sqlboxTotal: 12 }));
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="mo-source-sqlbox"]').text()).toBe('12'),
    );
    expect(wrapper.get('[data-testid="mo-source-http"]').text()).toBe('0');
    wrapper.unmount();
  });

  it('says "unknown", not "0", when the per-source counts could not be read', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes('/mo/messages') && target.includes('filter.source'))
        return apiResponse('boom', 500);
      if (target.includes('/mo/ingest/status')) return apiResponse(ingestStatus);
      if (target.includes('/mo/rules'))
        return apiResponse({ items: [rule], total: 1, limit: 50, offset: 0 });
      return apiResponse({ items: [], total: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(MoRoutingView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-source-http"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="mo-source-http"]').text()).toBe('unknown');
    wrapper.unmount();
  });

  it('lists rules in evaluation order by sending no sort parameter', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    const listCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes('/mo/rules?') && !String(call[0]).includes('preview'),
    );
    expect(String(listCall?.[0])).not.toContain('sort=');
    expect(wrapper.get('[data-testid="mo-rule-rule-1"]').text()).toContain('keyword first_word');
    expect(wrapper.find('[data-testid="mo-rule-order-warning"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('sends only whitelisted MO rule filters', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    await wrapper.get('[data-testid="mo-rule-filter-keyword-type"]').setValue('exact');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes('filter.matchKeywordType=exact'),
        ),
      ).toBe(true),
    );
    // matchDestination and matchSenderPrefix are searchable, not filterable.
    expect(wrapper.find('[data-testid="mo-rule-filter-destination"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mo-rule-filter-sender-prefix"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('surfaces the SSRF rejection verbatim, naming the host and the reason', async () => {
    const fetchMock = stubApi({ destinationError: SSRF_REJECTION });
    const { wrapper } = await mountView(fetchMock);
    await wrapper.get('[data-testid="mo-rule-open-rule-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-destination-target"]').exists()).toBe(true),
    );
    await wrapper
      .get('[data-testid="mo-destination-target"]')
      .setValue('http://169.254.169.254/latest/meta-data/');
    await wrapper.get('[data-testid="mo-destination-add"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-destination-error"]').exists()).toBe(true),
    );
    const error = wrapper.get('[data-testid="mo-destination-error"]').text();
    expect(error).toContain('169.254.169.254');
    expect(error).toContain('loopback, link-local or private address');
    expect(error).not.toBe('Bad request');
    const post = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes('/mo/rules/rule-1/destinations') &&
        (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(bodyOf(post)).toEqual({
      kind: 'webhook',
      target: 'http://169.254.169.254/latest/meta-data/',
      enabled: true,
      config: { method: 'POST' },
      maxAttempts: 5,
    });
    wrapper.unmount();
  });

  it('warns about the double SSRF check before a webhook URL is typed', async () => {
    const { wrapper } = await mountView();
    await wrapper.get('[data-testid="mo-rule-open-rule-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-webhook-ssrf-note"]').exists()).toBe(true),
    );
    const note = wrapper.get('[data-testid="mo-webhook-ssrf-note"]').text();
    expect(note).toContain('once when it is saved and again on every delivery attempt');
    expect(note).toContain('169.254.169.254');
    // The header is a bearer secret, not an HMAC — do not let anyone assume it is.
    expect(note).toContain('not an HMAC of the payload');
    // The note is for webhooks only.
    await wrapper.get('[data-testid="mo-destination-kind"]').setValue('email');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-webhook-ssrf-note"]').exists()).toBe(false),
    );
    wrapper.unmount();
  });

  it('offers Retry only for the statuses the API accepts', async () => {
    const { wrapper } = await mountView();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-delivery-retry-del-failed"]').exists()).toBe(true),
    );
    expect(
      wrapper.get('[data-testid="mo-delivery-retry-del-failed"]').attributes('disabled'),
    ).toBeUndefined();
    // pending is not retryable; the control explains itself rather than 400-ing.
    const pending = wrapper.get('[data-testid="mo-delivery-retry-del-pending"]');
    expect(pending.attributes('disabled')).toBeDefined();
    expect(pending.attributes('title')).toContain('Only a failed, dead-lettered or cancelled');
    wrapper.unmount();
  });

  it('says the attempt budget is reset when a delivery is retried', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    await wrapper.get('[data-testid="mo-delivery-retry-del-failed"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-delivery-notice"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="mo-delivery-notice"]').text()).toContain(
      'attempt counter is reset to zero',
    );
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes('/mo/deliveries/del-failed/retry'),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it('explains that a terminal rule left later rules unevaluated', async () => {
    const { wrapper } = await mountView(
      stubApi({
        preview: {
          matches: [
            {
              ruleId: 'rule-1',
              ruleName: 'STOP keyword',
              priority: 10,
              matchedOn: ['keyword first_word "STOP"'],
              destinationCount: 1,
              continueAfterMatch: false,
            },
          ],
          rulesEvaluated: 1,
          rulesLoaded: 4,
          stoppedEarly: true,
          deliveries: [
            {
              ruleId: 'rule-1',
              ruleName: 'STOP keyword',
              destinationId: 'dest-1',
              kind: 'webhook',
              target: 'https://example.com/hooks/mo',
            },
          ],
        },
      }),
    );
    await wrapper.get('[data-testid="mo-preview-sender"]').setValue('+256700000001');
    await wrapper.get('[data-testid="mo-preview-receiver"]').setValue('4455');
    await wrapper.get('[data-testid="mo-preview-body"]').setValue('STOP');
    await wrapper.get('[data-testid="mo-preview-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-preview-result"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="mo-preview-match-count"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="mo-preview-delivery-count"]').text()).toBe('1');
    const stopped = wrapper.get('[data-testid="mo-preview-stopped-early"]').text();
    expect(stopped).toContain('3 rule(s) never evaluated');
    // The API cannot name them, and the copy must not pretend otherwise.
    expect(stopped).toContain('The API does not name them');
    wrapper.unmount();
  });

  it('reports a sweep against an unreachable engine as unreachable, not as empty', async () => {
    const { wrapper } = await mountView(
      stubApi({
        sweep: {
          scanned: 0,
          ingested: 0,
          duplicates: 0,
          deliveries: 0,
          watermark: '0',
          available: false,
          evidence: 'sqlbox container is not running',
        },
      }),
    );
    await wrapper.get('[data-testid="mo-sweep-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mo-ingest-notice"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="mo-ingest-notice"]').text()).toContain('was not reachable');
    expect(wrapper.get('[data-testid="mo-sweep-evidence"]').text()).toContain(
      'sqlbox container is not running',
    );
    wrapper.unmount();
  });

  it('hides ingest control and mutations from an operator without messages.send', async () => {
    grant('messages.view');
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="mo-ingest-controls"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mo-rule-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mo-delivery-retry-del-failed"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="mo-readonly"]').text()).toContain('messages.send');
    // Reading the ingest state and the preview stay available.
    expect(wrapper.find('[data-testid="mo-watermark"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mo-preview-run"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
