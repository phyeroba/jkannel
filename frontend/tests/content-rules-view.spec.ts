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

import ContentRulesView from '../src/views/ContentRulesView.vue';
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

const QUARANTINE_REASON =
  'Regex execution exceeded the send-path budget. The rule was disabled automatically to protect ' +
  'the sender; review the pattern and re-enable it.';

const healthyRule = {
  id: 'rule-block',
  name: 'Block loan spam',
  description: 'Regulator complaint 2026-04',
  match_field: 'body',
  match_type: 'substring',
  pattern: 'quick loan',
  case_sensitive: false,
  action: 'block',
  smsc_id: null,
  customer_id: null,
  enabled: true,
  priority: 10,
  expires_at: null,
  reason: 'Refused: unsolicited credit offer',
  match_count: '412',
  last_matched_at: '2026-08-04T09:00:00Z',
  quarantined_at: null,
  quarantine_reason: null,
  created_by: 'amina',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};
const quarantinedRule = {
  ...healthyRule,
  id: 'rule-regex',
  name: 'Catastrophic pattern',
  match_type: 'regex',
  pattern: '(a+)+b',
  enabled: false,
  priority: 20,
  quarantined_at: '2026-08-04T10:15:00Z',
  quarantine_reason: QUARANTINE_REASON,
};

const policy = {
  precedence: 'first_match_wins',
  order: 'priority ASC, created_at ASC, id ASC',
  defaultOutcome: 'allow',
  explanation:
    'Rules are evaluated in priority order (lowest number first); the first rule that matches decides.',
  matchFields: ['body', 'sender', 'recipient', 'any'],
  matchTypes: ['substring', 'exact', 'prefix', 'regex'],
  maxRules: 500,
  maxRegexRules: 50,
  cacheTtlMs: 15000,
  cacheNote: 'A rule change takes effect immediately in the process that made it.',
};

const previewWithShadow = {
  allowed: false,
  outcome: 'block',
  reason:
    'content rule "Block loan spam" (rule-block, priority 10) blocked this message: substring match on body',
  decidedBy: {
    ruleId: 'rule-block',
    ruleName: 'Block loan spam',
    action: 'block',
    field: 'body',
    matchType: 'substring',
    pattern: 'quick loan',
    priority: 10,
    matchedOn: 'body',
    reason: null,
  },
  matches: [
    {
      ruleId: 'rule-block',
      ruleName: 'Block loan spam',
      action: 'block',
      matchType: 'substring',
      pattern: 'quick loan',
      priority: 10,
      matchedOn: 'body',
      shadowed: false,
    },
    {
      ruleId: 'rule-allow',
      ruleName: 'Allow partner loans',
      action: 'allow',
      matchType: 'substring',
      pattern: 'loan',
      priority: 90,
      matchedOn: 'body',
      shadowed: true,
    },
  ],
  rulesInScope: 4,
  rulesOutOfScope: 1,
  rulesLoaded: 5,
  evaluationPoint: 'before_route_selection',
  quarantined: [],
};

function stubApi(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/smscs'))
      return apiResponse({ items: [{ id: 's1', name: 'Primary', engine_id: 'primary-smpp' }] });
    if (target.includes('/content-rules/policy')) return apiResponse(policy);
    if (target.includes('/content-rules/preview'))
      return apiResponse(overrides.preview ?? previewWithShadow);
    if (target.includes('/content-rules') && init?.method) {
      if (overrides.mutationError)
        return apiResponse(overrides.mutationError, Number(overrides.mutationStatus ?? 400));
      return apiResponse({ ...healthyRule, id: 'rule-new' });
    }
    return apiResponse(
      overrides.list ?? {
        items: [healthyRule, quarantinedRule],
        total: 2,
        limit: 50,
        offset: 0,
        pagination: 'offset',
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const mountView = async (fetchMock = stubApi()) => {
  const wrapper = mount(ContentRulesView);
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="content-rule-rule-block"]').exists()).toBe(true),
  );
  return { wrapper, fetchMock };
};

describe('content filtering view', () => {
  beforeEach(() => {
    grant('messages.view', 'messages.send');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists rules in evaluation order by sending no sort parameter at all', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    const listCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes('/messaging/content-rules?') &&
        !String(call[0]).includes('preview'),
    );
    const url = String(listCall?.[0]);
    // An explicit `sort=priority` replaces the backend's whole ORDER BY and
    // loses the created_at/id tiebreakers, so it is NOT evaluation order.
    expect(url).not.toContain('sort=');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=0');
    // Position numbers are only shown when the listing really is in order.
    expect(wrapper.get('[data-testid="content-rule-rule-block"]').text()).toContain('1');
    expect(wrapper.find('[data-testid="content-order-warning"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('hides the position numbers and warns when sorted out of evaluation order', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    await wrapper.get('[data-testid="content-rule-sort"]').setValue('matchCount');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="content-order-warning"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="content-order-warning"]').text()).toContain(
      'sorted by matchCount, which is not evaluation order',
    );
    expect(wrapper.get('[data-testid="content-rule-rule-block"]').text()).not.toMatch(/^\s*1\b/);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('sort=matchCount'))).toBe(
      true,
    );
    wrapper.unmount();
  });

  it('sends only whitelisted filter keys as server-side grid parameters', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    await wrapper.get('[data-testid="content-filter-action"]').setValue('block');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('filter.action=block')),
      ).toBe(true),
    );
    await wrapper.get('[data-testid="content-filter-match-type"]').setValue('regex');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('filter.matchType=regex')),
      ).toBe(true),
    );
    // No control exists for anything the API does not whitelist.
    expect(wrapper.find('[data-testid="content-filter-pattern"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="content-filter-case"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders a quarantined rule distinctly and says a message may have slipped past it', async () => {
    const { wrapper } = await mountView();
    const banner = wrapper.get('[data-testid="content-quarantine-banner"]').text();
    expect(banner).toContain('QUARANTINED');
    expect(banner).toContain('at least one message was evaluated as though the rule did not match');
    expect(banner).toContain('not filtering anything now');

    const row = wrapper.get('[data-testid="content-rule-rule-regex"]');
    expect(row.find('[data-testid="content-rule-quarantined-rule-regex"]').exists()).toBe(true);
    expect(row.classes()).toContain('row-quarantined');
    expect(row.get('[data-testid="content-rule-quarantine-reason-rule-regex"]').text()).toContain(
      'exceeded the send-path budget',
    );
    // The healthy rule must NOT be dressed up as quarantined.
    const healthy = wrapper.get('[data-testid="content-rule-rule-block"]');
    expect(healthy.classes()).not.toContain('row-quarantined');
    expect(healthy.find('[data-testid="content-rule-quarantined-rule-block"]').exists()).toBe(
      false,
    );
    wrapper.unmount();
  });

  it('releases a quarantined rule with the PATCH the API actually supports', async () => {
    const fetchMock = stubApi();
    const { wrapper } = await mountView(fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await wrapper.get('[data-testid="content-rule-release-rule-regex"]').trigger('click');
    await vi.waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      // There is no un-quarantine endpoint: the columns are cleared by the same
      // UPDATE that re-enables the rule, so only `enabled` is sent.
      expect(bodyOf(patch)).toEqual({ enabled: true });
      expect(String(patch?.[0])).toContain('/messaging/content-rules/rule-regex');
    });
    // Only the quarantined row offers the control.
    expect(wrapper.find('[data-testid="content-rule-release-rule-block"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('flags shadowed matches in the preview as rules that can never decide', async () => {
    const { wrapper } = await mountView();
    await wrapper.get('[data-testid="content-preview-text"]').setValue('get a quick loan today');
    await wrapper.get('[data-testid="content-preview-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="content-preview-result"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="content-preview-outcome"]').text()).toBe('block');
    expect(wrapper.get('[data-testid="content-preview-decided-by"]').text()).toBe(
      'Block loan spam',
    );
    expect(wrapper.get('[data-testid="content-preview-shadowed-count"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="content-preview-shadow-warning"]').text()).toContain(
      'can never decide it',
    );
    // Row 0 decides; row 1 is inert and is labelled and dimmed as such.
    expect(wrapper.get('[data-testid="content-preview-shadowed-0"]').text()).toBe(
      'decides this message',
    );
    expect(wrapper.get('[data-testid="content-preview-shadowed-1"]').text()).toContain(
      'shadowed — never decides',
    );
    expect(wrapper.get('[data-testid="content-preview-match-1"]').classes()).toContain(
      'row-shadowed',
    );
    wrapper.unmount();
  });

  it('distinguishes "allowed by a rule" from "allowed because nothing matched"', async () => {
    // The API has no `no-match` outcome — a no-match is outcome `allow` with a
    // null decidedBy, and reading that as "a rule allowed it" is the misreading.
    const { wrapper } = await mountView(
      stubApi({
        preview: {
          allowed: true,
          outcome: 'allow',
          reason: 'no content rule matched (4 in scope)',
          decidedBy: null,
          matches: [],
          rulesInScope: 4,
          rulesOutOfScope: 0,
          rulesLoaded: 4,
          evaluationPoint: 'before_route_selection',
          quarantined: [],
        },
      }),
    );
    await wrapper.get('[data-testid="content-preview-text"]').setValue('hello');
    await wrapper.get('[data-testid="content-preview-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="content-preview-result"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="content-preview-decided-by"]').text()).toBe('no rule');
    expect(wrapper.get('[data-testid="content-preview-default-outcome"]').text()).toContain(
      'allowed by default — not by a rule',
    );
    expect(wrapper.get('[data-testid="content-preview-no-match"]').text()).toContain(
      'No rule matched',
    );
    wrapper.unmount();
  });

  it('admits that a preview can quarantine a rule for real', async () => {
    const { wrapper } = await mountView(
      stubApi({ preview: { ...previewWithShadow, quarantined: ['rule-regex'] } }),
    );
    await wrapper.get('[data-testid="content-preview-text"]').setValue('aaaaaaaaaaaaaaaa');
    await wrapper.get('[data-testid="content-preview-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="content-preview-quarantined"]').exists()).toBe(true),
    );
    const text = wrapper.get('[data-testid="content-preview-quarantined"]').text();
    expect(text).toContain('have now been disabled and quarantined for real');
    expect(text).toContain('not a simulation');
    expect(text).toContain('rule-regex');
    wrapper.unmount();
  });

  it('surfaces the API’s regex rejection verbatim instead of a generic failure', async () => {
    const rejection =
      'Unsafe regex (nested_quantifier): a quantifier applied to a group that itself contains a ' +
      'quantifier or an alternation (for example (a+)+ or (a|b)*) can backtrack exponentially and ' +
      'is not accepted';
    const fetchMock = stubApi({ mutationError: rejection, mutationStatus: 400 });
    const { wrapper } = await mountView(fetchMock);
    await wrapper.get('[data-testid="content-rule-create"]').trigger('click');
    await wrapper.get('[data-testid="content-form-name"]').setValue('Bad regex');
    await wrapper.get('[data-testid="content-form-match-type"]').setValue('regex');
    await wrapper.get('[data-testid="content-form-pattern"]').setValue('(a+)+b');
    await wrapper.get('[data-testid="content-form-save"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="content-form-error"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="content-form-error"]').text()).toContain('nested_quantifier');
    wrapper.unmount();
  });

  it('warns about the three regex safety layers only when the match type is regex', async () => {
    const { wrapper } = await mountView();
    await wrapper.get('[data-testid="content-rule-create"]').trigger('click');
    expect(wrapper.find('[data-testid="content-form-regex-note"]').exists()).toBe(false);
    await wrapper.get('[data-testid="content-form-match-type"]').setValue('regex');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="content-form-regex-note"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="content-form-regex-note"]').text()).toContain(
      'disabled and quarantined automatically',
    );
    wrapper.unmount();
  });

  it('names the missing trace route rather than offering a control that cannot work', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="content-trace-gap"]').text()).toContain(
      'no REST route returns it yet',
    );
    wrapper.unmount();
  });

  it('hides every mutation from an operator without messages.send', async () => {
    grant('messages.view');
    const { wrapper } = await mountView();
    expect(wrapper.find('[data-testid="content-rule-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="content-rule-edit-rule-block"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="content-rule-release-rule-regex"]').exists()).toBe(false);
    // The preview stays available on the read permission, as the API allows.
    expect(wrapper.find('[data-testid="content-preview-run"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="content-rules-readonly"]').text()).toContain('messages.send');
    wrapper.unmount();
  });
});
