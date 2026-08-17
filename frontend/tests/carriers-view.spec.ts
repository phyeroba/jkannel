import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    permissions: new Set(['smsc.view', 'smsc.manage']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import CarriersView from '../src/views/CarriersView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const carrier = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'MTN Uganda',
  country_code: 'UG',
  network_code: '64110',
  status: 'active',
  notes: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  smscCount: 2,
  bindsHealthy: 1,
  bindsTotal: 2,
  bindsUnobserved: 0,
  health: 'degraded',
  queuedMessages: 41,
  failedMessages: 3,
  capacityTps: 100,
  observedTps: null,
  utilisation: null,
  openAlerts: 1,
  ...overrides,
});

const unassignedSmsc = (overrides: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  engine_id: 'mtn-p1',
  name: 'MTN Primary',
  type: 'smpp',
  enabled: true,
  lifecycle_state: 'active',
  ...overrides,
});

const router = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/carriers', component: { template: '<p/>' } },
      { path: '/carriers/:id', component: { template: '<p/>' } },
      { path: '/smsc/:engineId', component: { template: '<p/>' } },
    ],
  });

const mountView = async (fetchMock: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal('fetch', fetchMock);
  const instance = router();
  await instance.push('/carriers');
  await instance.isReady();
  const wrapper = mount(CarriersView, { global: { plugins: [instance] } });
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="unassigned-summary"]').text()).not.toContain('Checking'),
  );
  return wrapper;
};

const standardFetch = (carriers: unknown[], unassigned: unknown[]) =>
  // `init` is unused on purpose: the assertion that nothing was POSTed reads it
  // off the recorded calls, which requires the mock to declare the parameter.
  vi.fn((input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/carriers/unassigned-smscs')) return envelope(unassigned);
    if (/\/carriers(\?|$)/.test(url)) return envelope(carriers);
    return envelope({});
  });

describe('carriers register — the unassigned-SMSC panel', () => {
  it('reads a full unassigned list as work to do, not as a fault', async () => {
    const wrapper = await mountView(standardFetch([carrier()], [unassignedSmsc()]));

    const panel = wrapper.get('[data-testid="carriers-unassigned-panel"]');
    // The panel is permanent and is not an error surface.
    expect(panel.attributes('role')).toBeUndefined();
    const explainer = wrapper.get('[data-testid="unassigned-explainer"]').text();
    expect(explainer).toContain('nothing was back-filled');
    expect(explainer).toContain('list of work to do, not a fault');
    // It must say why the gap exists rather than implying data loss.
    expect(explainer).toContain('guess into the database as a fact');
    expect(
      wrapper.get('[data-testid="unassigned-22222222-2222-4222-8222-222222222222"]').text(),
    ).toContain('MTN Primary');
  });

  it('attaches an unassigned SMSC to the carrier the operator picks', async () => {
    const smsc = unassignedSmsc();
    const posts: Array<{ url: string; body: unknown }> = [];
    let remaining: unknown[] = [smsc];
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/smscs') && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        remaining = [];
        return envelope({ smscId: smsc.id, carrierId: carrier().id });
      }
      if (url.includes('/carriers/unassigned-smscs')) return envelope(remaining);
      if (/\/carriers(\?|$)/.test(url)) return envelope([carrier()]);
      return envelope({});
    });
    const wrapper = await mountView(fetchMock);

    await wrapper.get(`[data-testid="unassigned-select-${smsc.id}"]`).setValue(carrier().id);
    await wrapper.get(`[data-testid="unassigned-attach-${smsc.id}"]`).trigger('click');

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain(`/carriers/${carrier().id}/smscs`);
    expect(posts[0].body).toEqual({ smscId: smsc.id });
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="carriers-notice"]').text()).toContain('MTN Uganda'),
    );
  });

  it('refuses to attach without a carrier chosen, rather than guessing one', async () => {
    const smsc = unassignedSmsc();
    const fetchMock = standardFetch([carrier()], [smsc]);
    const wrapper = await mountView(fetchMock);

    await wrapper.get(`[data-testid="unassigned-attach-${smsc.id}"]`).trigger('click');
    expect(wrapper.get('[data-testid="unassigned-error"]').text()).toContain('Choose the carrier');
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('says the attach control is inert until a carrier exists', async () => {
    const wrapper = await mountView(standardFetch([], [unassignedSmsc()]));
    expect(wrapper.get('[data-testid="unassigned-no-carriers"]').text()).toContain(
      'no carrier to file these under yet',
    );
    expect(
      wrapper
        .get('[data-testid="unassigned-attach-22222222-2222-4222-8222-222222222222"]')
        .attributes('disabled'),
    ).toBeDefined();
  });

  it('explains an empty panel instead of leaving it blank', async () => {
    const wrapper = await mountView(standardFetch([carrier()], []));
    const state = wrapper.get('[data-testid="unassigned-state"]');
    expect(state.attributes('data-state')).toBe('empty');
    expect(state.text()).toContain('appears here until somebody files it');
  });
});

describe('carriers register — the table', () => {
  it('states health as a word, not only a colour, and explains unknown', async () => {
    const wrapper = await mountView(
      standardFetch(
        [carrier({ health: 'unknown', smscCount: 0, bindsTotal: 0, bindsHealthy: 0 })],
        [],
      ),
    );
    const badge = wrapper.get(
      '[data-testid="carrier-health-11111111-1111-4111-8111-111111111111"]',
    );
    expect(badge.text()).toBe('unknown');
    expect(badge.attributes('title')).toContain('nothing to be healthy');
  });

  it('shows utilisation as unknown rather than 0% when the roll-up has no rate', async () => {
    const wrapper = await mountView(standardFetch([carrier({ utilisation: null })], []));
    expect(
      wrapper
        .get('[data-testid="carrier-utilisation-11111111-1111-4111-8111-111111111111"]')
        .text(),
    ).toBe('unknown');
    expect(wrapper.get('[data-testid="carriers-grid-note"]').text()).toContain(
      'does not compute an observed rate',
    );
  });

  it('never renders a zero that was not measured while loading', async () => {
    // The request never settles, so the register is still in `loading`.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const instance = router();
    await instance.push('/carriers');
    await instance.isReady();
    const wrapper = mount(CarriersView, { global: { plugins: [instance] } });
    await wrapper.vm.$nextTick();
    const state = wrapper.get('[data-testid="carriers-state"]');
    expect(state.attributes('data-state')).toBe('loading');
    // A skeleton, not a table of confident zeroes.
    expect(wrapper.find('[data-testid="carriers-table"]').exists()).toBe(false);
    expect(state.findAll('.skeleton-row').length).toBeGreaterThan(0);
  });

  it('states the impact of a delete before the verb', async () => {
    const wrapper = await mountView(standardFetch([carrier({ smscCount: 3 })], []));
    await wrapper
      .get('[data-testid="carrier-delete-11111111-1111-4111-8111-111111111111"]')
      .trigger('click');
    const dialog = wrapper.get('[data-testid="carrier-delete-confirm"]');
    expect(dialog.attributes('role')).toBe('alertdialog');
    expect(wrapper.get('[data-testid="carrier-delete-impact"]').text()).toContain('3');
    expect(dialog.text()).toContain('keep carrying traffic');
  });

  it('reports a permission failure as permission-denied, not as an error', async () => {
    const forbidden = () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403 }),
      );
    vi.stubGlobal('fetch', vi.fn(forbidden));
    const instance = router();
    await instance.push('/carriers');
    await instance.isReady();
    const wrapper = mount(CarriersView, { global: { plugins: [instance] } });
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="carriers-state"]').attributes('data-state')).toBe(
        'permission-denied',
      ),
    );
    expect(wrapper.get('[data-testid="carriers-state"]').text()).toContain('smsc.view');
  });
});
