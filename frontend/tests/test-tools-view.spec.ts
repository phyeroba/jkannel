import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const granted = vi.hoisted(() => new Set<string>(['routes.view', 'messages.view', 'smsc.manage']));
vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: granted }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import TestToolsView from '../src/views/TestToolsView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

/** Mirrors `lookupNumber` in backend/src/diagnostics/test-tools.service.ts. */
const lookup = (overrides: Record<string, unknown> = {}) => ({
  input: '0772000118',
  normalized: '+256772000118',
  digits: '256772000118',
  valid: true,
  problem: null,
  matchingPrefixes: [
    {
      id: 'r1',
      name: 'MTN national',
      match_prefix: '25677',
      priority: 10,
      enabled: true,
      deployment_state: 'deployed',
      target_engine_id: 'mtn-p1',
    },
  ],
  limits: [
    'JKANNEL has no prefix-to-operator database, so the mobile network behind this number is not identified. Only prefixes you have configured on routes are matched.',
  ],
  ...overrides,
});

const testSends = [
  {
    id: 't1',
    foreign_id: 'kmx_01HXQ4K2R9',
    destination: '+256772000118',
    reason: 'runbook 4.2 verification',
    sent_by: 'amina',
    created_at: '2026-08-17T09:00:00Z',
    engine_id: 'mtn-p1',
  },
];

const verification = {
  verified: 'tcp_socket',
  passed: true,
  reachable: true,
  bound: null,
  latencyMs: 42,
  detail:
    'TCP socket to smpp.mtn.co.ug:2775 opened. This is NOT an SMPP bind — the credentials are not resolvable from this container.',
  bindSkippedReason: 'the credentials are not resolvable from this container',
};

interface Options {
  lookupPayload?: unknown;
  sends?: unknown[];
  testPayload?: unknown;
}

async function mountView(options: Options = {}) {
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
        return envelope(options.testPayload ?? { status: 'succeeded', verification });
      }
      if (url.includes('/diagnostics/number-lookup'))
        return envelope(options.lookupPayload ?? lookup());
      if (url.includes('/diagnostics/test-sends'))
        return envelope({ items: options.sends ?? testSends });
      if (url.includes('/smscs'))
        return envelope({ items: [{ id: 's1', engine_id: 'mtn-p1', name: 'MTN Primary' }] });
      return envelope({});
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/test-tools', component: { template: '<p/>' } },
      { path: '/bulk-send', component: { template: '<p/>' } },
    ],
  });
  await router.push('/test-tools');
  await router.isReady();
  const wrapper = mount(TestToolsView, { global: { plugins: [router] } });
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="sends-state"][data-state="loading"]').exists()).toBe(false),
  );
  return { wrapper, posts };
}

type Wrapper = Awaited<ReturnType<typeof mountView>>['wrapper'];

async function runLookup(wrapper: Wrapper, value = '0772000118') {
  await wrapper.get('[data-testid="lookup-input"]').setValue(value);
  await wrapper.get('[data-testid="lookup-run"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.find('[data-testid="lookup-limits"]').exists()).toBe(true));
}

beforeEach(() => {
  granted.clear();
  for (const permission of ['routes.view', 'messages.view', 'smsc.manage']) granted.add(permission);
});

describe('number and prefix lookup renders its limits verbatim', () => {
  it('prints every limit the API returned, word for word', async () => {
    const { wrapper } = await mountView();
    await runLookup(wrapper);
    const rendered = wrapper
      .get('[data-testid="lookup-limits-list"]')
      .findAll('li')
      .map((item) => item.text());
    expect(rendered).toEqual(lookup().limits);
    // The sentence the whole block exists for.
    expect(rendered[0]).toContain('no prefix-to-operator database');
    expect(rendered[0]).toContain('is not identified');
  });

  it('adds the second limit when the number could not be normalised', async () => {
    const second =
      'This number could not be normalised to international form. A national number needs DEFAULT_COUNTRY_CODE configured; without it JKANNEL will not guess a country.';
    const { wrapper } = await mountView({
      lookupPayload: lookup({
        valid: false,
        normalized: null,
        problem: 'no country code',
        limits: [...lookup().limits, second],
      }),
    });
    await runLookup(wrapper);
    const rendered = wrapper
      .get('[data-testid="lookup-limits-list"]')
      .findAll('li')
      .map((item) => item.text());
    expect(rendered).toHaveLength(2);
    expect(rendered[1]).toBe(second);
    expect(wrapper.get('[data-testid="lookup-normalized"]').text()).toBe('could not be normalised');
  });

  it('has no Network column, because the network is never determined', async () => {
    const { wrapper } = await mountView();
    await runLookup(wrapper);
    const headings = wrapper
      .get('[data-testid="lookup-prefixes"]')
      .findAll('th')
      .map((cell) => cell.text().toLowerCase());
    expect(headings).toEqual([
      'prefix',
      'route',
      'priority',
      'enabled',
      'deployment',
      'target connection',
    ]);
    expect(headings).not.toContain('network');
    expect(headings).not.toContain('operator');
    expect(headings).not.toContain('carrier');
    expect(wrapper.get('[data-testid="lookup-limits"]').text()).toContain(
      'a filled one would be a guess',
    );
  });

  it('explains an unmatched number instead of implying it is invalid', async () => {
    const { wrapper } = await mountView({ lookupPayload: lookup({ matchingPrefixes: [] }) });
    await runLookup(wrapper);
    expect(wrapper.get('[data-testid="lookup-no-prefixes"]').text()).toContain(
      'it does not mean the number is invalid',
    );
    // The limits are still rendered when there is nothing to route to.
    expect(wrapper.get('[data-testid="lookup-limits-list"]').findAll('li')).toHaveLength(1);
  });
});

describe('the encoding analyzer', () => {
  it('counts segments and names the alphabet as the operator types', async () => {
    const { wrapper } = await mountView();
    await wrapper.get('[data-testid="encoding-input"]').setValue('a'.repeat(161));
    expect(wrapper.get('[data-testid="encoding-alphabet"]').text()).toBe('GSM-7');
    expect(wrapper.get('[data-testid="encoding-segments"]').text()).toBe('2');
    // One non-GSM character collapses the limit, and the counter says which.
    await wrapper.get('[data-testid="encoding-input"]').setValue('café');
    expect(wrapper.get('[data-testid="encoding-alphabet"]').text()).toBe('GSM-7');
    await wrapper.get('[data-testid="encoding-input"]').setValue('hello 😀');
    expect(wrapper.get('[data-testid="encoding-alphabet"]').text()).toBe('UCS-2');
    expect(wrapper.get('[data-testid="encoding-ucs2-warning"]').text()).toContain(
      'UCS-2 encoding forced',
    );
  });
});

describe('the connectivity test reports how far it got', () => {
  it('never presents a passed socket check as proof of the credentials', async () => {
    const { wrapper, posts } = await mountView();
    await wrapper.get('[data-testid="connectivity-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="connectivity-level"]').exists()).toBe(true),
    );
    expect(posts.some((url) => url.includes('/smscs/s1/actions/test'))).toBe(true);
    const badge = wrapper.get('[data-testid="connectivity-level"]');
    expect(badge.text()).toBe('passed: tcp_socket');
    // Amber, not green: it passed at a level that proves nothing about the bind.
    expect(badge.classes()).toContain('warn');
    expect(wrapper.get('[data-testid="connectivity-word"]').text()).toContain('never exercised');
    // The backend's own sentence, verbatim.
    expect(wrapper.get('[data-testid="connectivity-detail"]').text()).toBe(verification.detail);
    expect(wrapper.get('[data-testid="connectivity-skipped"]').text()).toContain(
      'proves a listener exists and nothing about the credentials',
    );
  });

  it('says so when the API replayed an earlier attempt instead of verifying', async () => {
    const { wrapper } = await mountView({
      testPayload: { status: 'succeeded', detail: 'replayed', replayed: true },
    });
    await wrapper.get('[data-testid="connectivity-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="connectivity-replayed"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="connectivity-replayed"]').text()).toContain(
      'no verification level is shown',
    );
  });

  it('withholds the control from an operator without smsc.manage and says why', async () => {
    granted.delete('smsc.manage');
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="connectivity-run"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="connectivity-readonly"]').text()).toContain('smsc.manage');
  });
});

describe('tagged test sends', () => {
  it('lists what other callers tagged', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="send-t1"]').text()).toContain('kmx_01HXQ4K2R9');
    expect(wrapper.get('[data-testid="send-t1"]').text()).toContain('runbook 4.2 verification');
  });

  it('does not let an empty register read as "no test has ever been run"', async () => {
    const { wrapper } = await mountView({ sends: [] });
    expect(wrapper.get('[data-testid="sends-state"]').text()).toContain(
      'no caller has used it, not that no test has ever been run',
    );
  });

  it('states the permission rather than showing an empty table', async () => {
    granted.delete('messages.view');
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="sends-state"]').attributes('data-state')).toBe(
      'permission-denied',
    );
    expect(wrapper.get('[data-testid="sends-state"]').text()).toContain('messages.view');
  });
});
