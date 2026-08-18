import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['routes.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import RouteSimulatorView from '../src/views/RouteSimulatorView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const smscs = [
  { id: 's1', engine_id: 'mtn-p1', name: 'MTN Primary' },
  { id: 's2', engine_id: 'mtn-p2', name: 'MTN Secondary' },
];

const decision = (overrides: Record<string, unknown> = {}) => ({
  msisdn: '+256772000118',
  smscId: 's1',
  routeId: 'r1',
  routeName: 'MTN national',
  strategy: 'priority',
  fallbackUsed: false,
  reason: 'prefix 25677 matched MTN national; primary target available',
  trace: [
    'destination +256772000118 (digits 256772000118)',
    '1 route matched; MTN national is most specific',
    'primary target mtn-p1 is available',
  ],
  candidatesConsidered: 4,
  ...overrides,
});

async function mountView() {
  const posts: { url: string; body: unknown }[] = [];
  const resolved = ref<unknown>(decision());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
        return envelope(resolved.value);
      }
      if (url.includes('/smscs')) return envelope({ items: smscs });
      return envelope({});
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/route-simulator', component: { template: '<p/>' } },
      { path: '/test-tools', component: { template: '<p/>' } },
      { path: '/bulk-send', component: { template: '<p/>' } },
    ],
  });
  await router.push('/route-simulator');
  await router.isReady();
  const wrapper = mount(RouteSimulatorView, { global: { plugins: [router] } });
  await vi.waitFor(() => expect(wrapper.find('[data-testid="simulator-run"]').exists()).toBe(true));
  return { wrapper, posts, resolved };
}

describe('the simulator says, prominently, that it transmits nothing', () => {
  it('makes the statement above the form, not under the result', async () => {
    const { wrapper } = await mountView();
    const banner = wrapper.get('[data-testid="simulator-non-transmitting"]');
    expect(banner.text()).toContain('This simulator does not send anything');
    expect(banner.text()).toContain('Nothing on this screen transmits');
    expect(banner.text()).toContain('no bind is used');

    // Above the form, in document order — an operator must not have to scroll
    // past the button to learn the button is safe.
    const html = wrapper.html();
    expect(html.indexOf('data-testid="simulator-non-transmitting"')).toBeLessThan(
      html.indexOf('data-testid="simulator-form"'),
    );
    expect(html.indexOf('data-testid="simulator-non-transmitting"')).toBeLessThan(
      html.indexOf('data-testid="simulator-run"'),
    );
  });

  it('repeats it on the control itself and after the answer', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="simulator-run"]').text()).toContain('sends nothing');
    await wrapper.get('[data-testid="simulator-msisdn"]').setValue('+256772000118');
    await wrapper.get('[data-testid="simulator-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="simulator-smsc"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="simulator-still-nothing-sent"]').text()).toContain(
      'Still nothing has been transmitted',
    );
  });
});

describe('the decision', () => {
  it('names the connection, the route and every step of the trace', async () => {
    const { wrapper, posts } = await mountView();
    await wrapper.get('[data-testid="simulator-msisdn"]').setValue('+256772000118');
    await wrapper.get('[data-testid="simulator-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="simulator-smsc"]').exists()).toBe(true),
    );

    expect(posts[0].url).toContain('/routing/resolve');
    expect(posts[0].body).toEqual({ msisdn: '+256772000118', rotation: 0 });
    // The uuid the selector returns is shown as the connection an operator knows.
    expect(wrapper.get('[data-testid="simulator-smsc"]').text()).toBe('MTN Primary (mtn-p1)');
    expect(wrapper.get('[data-testid="simulator-route"]').text()).toBe('MTN national');
    expect(wrapper.get('[data-testid="simulator-outcome"]').text()).toBe('routable');
    expect(
      wrapper
        .get('[data-testid="simulator-trace"]')
        .findAll('li')
        .map((item) => item.text()),
    ).toEqual(decision().trace);
    expect(wrapper.get('[data-testid="simulator-reason"]').text()).toBe(decision().reason);
  });

  it('says a destination is unroutable rather than leaving the field blank', async () => {
    const { wrapper, resolved } = await mountView();
    resolved.value = decision({
      smscId: null,
      routeId: null,
      routeName: null,
      strategy: null,
      reason: 'no route matched this destination',
      trace: ['destination 999 (digits 999)', 'no route matched this destination'],
    });
    await wrapper.get('[data-testid="simulator-msisdn"]').setValue('999');
    await wrapper.get('[data-testid="simulator-run"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="simulator-unroutable"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="simulator-smsc"]').text()).toContain('unroutable');
    expect(wrapper.get('[data-testid="simulator-outcome"]').text()).toBe('no route');
    expect(wrapper.get('[data-testid="simulator-unroutable"]').text()).toContain(
      'would be refused rather than sent somewhere arbitrary',
    );
  });

  it('does not present an unevaluated screen as "no route"', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="simulator-state"]').text()).toContain(
      'not the same as “no route matches”',
    );
  });

  it('only constrains availability when asked, and sends the ticked ids', async () => {
    const { wrapper, posts } = await mountView();
    await wrapper.get('[data-testid="simulator-msisdn"]').setValue('+256772000118');
    await wrapper.get('[data-testid="simulator-constrain"]').setValue(true);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="simulator-available-mtn-p2"]').exists()).toBe(true),
    );
    await wrapper.get('[data-testid="simulator-available-mtn-p2"]').setValue(true);
    await wrapper.get('[data-testid="simulator-run"]').trigger('click');
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].body).toEqual({
      msisdn: '+256772000118',
      rotation: 0,
      availableSmscIds: ['s2'],
    });
  });
});
