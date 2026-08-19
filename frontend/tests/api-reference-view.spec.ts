import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    // Deliberately empty: the API reference is documentation and must render
    // for a role holding no permission at all.
    permissions: new Set<string>(),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import ApiReferenceView from '../src/views/ApiReferenceView.vue';
import { navigation } from '../src/navigation';

/**
 * A faithful slice of what `GET /api/v1/openapi.json` returns: the generator's
 * own `x-generation` block, a grid endpoint whose parameters arrive as $refs, a
 * POST with the generic-object body placeholder, a POST with no reflected body
 * at all, and a permissioned route that declares no security scheme (the
 * API-key-guarded gateway shape).
 */
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'JKANNEL API', version: '0.1.0', description: 'Operational API for the console.' },
  'x-generation': {
    strategy: 'reflected-from-controllers',
    routeCount: 5,
    derived: ['path', 'method', 'path-params', 'auth', 'permissions'],
    limitations: [
      'Request/response body schemas are generic objects because bodies are validated imperatively (no DTO classes to reflect).',
      'Grid list endpoints expose shared grid/cursor/field parameters by reference rather than a reflected per-field list.',
    ],
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    parameters: {
      GridSearch: {
        name: 'search',
        in: 'query',
        description: 'Free-text search over the whitelisted columns.',
        schema: { type: 'string' },
      },
      GridSort: {
        name: 'sort',
        in: 'query',
        description: 'Comma-separated whitelisted sort fields.',
        schema: { type: 'string' },
      },
    },
    schemas: {
      GridPage: {
        type: 'object',
        description: 'Standard offset grid page.',
        properties: { items: { type: 'array', items: { type: 'object' } } },
      },
    },
  },
  paths: {
    '/messages': {
      get: {
        operationId: 'MessagesController_list',
        summary: 'List messages',
        tags: ['messages'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/GridSearch' },
          { $ref: '#/components/parameters/GridSort' },
        ],
        responses: { '200': { description: 'Successful response' } },
        'x-required-permissions': ['messages.view'],
      },
      post: {
        operationId: 'MessagesController_send',
        summary: 'Send message',
        tags: ['messages'],
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Successful response' } },
        'x-required-permissions': ['messages.send'],
      },
    },
    '/alerts/{id}/acknowledge': {
      post: {
        operationId: 'AlertLifecycleController_acknowledge',
        summary: 'Acknowledge',
        tags: ['alerts'],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Successful response' } },
        'x-required-permissions': ['alerts.manage'],
      },
    },
    '/gateway/messages': {
      post: {
        operationId: 'GatewayMessagingController_submit',
        summary: 'Submit',
        tags: ['gateway'],
        // No security: ApiKeyAuthGuard is not detected by the generator.
        security: [],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Successful response' } },
        'x-required-permissions': ['sms.send'],
      },
    },
    '/health': {
      get: {
        operationId: 'HealthController_health',
        summary: 'Backend health check',
        tags: ['health'],
        security: [],
        responses: { '200': { description: 'Successful response' } },
      },
    },
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function stubFetch(handler: (url: string) => Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function mountReference(initial = '/api-reference') {
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/api-reference', component: ApiReferenceView },
      { path: '/:pathMatch(.*)*', component: { template: '<p>body</p>' } },
    ],
  });
  await router.push(initial);
  await router.isReady();
  const wrapper = mount(ApiReferenceView, { global: { plugins: [router] } });
  await vi.waitFor(() =>
    expect(wrapper.find('[data-testid="api-reference-count"]').exists()).toBe(true),
  );
  return { wrapper, router };
}

/**
 * The operation detail is a DetailDrawer, which teleports to <body>. It is
 * therefore outside the mounted wrapper by design — the same reason it now
 * opens where the reader is looking instead of at the foot of a 345-row page.
 */
const inDrawer = (selector: string) => document.body.querySelector(selector);
const drawerAll = (selector: string) => [...document.body.querySelectorAll(selector)];
const drawerText = (selector: string) => inDrawer(selector)?.textContent ?? '';
describe('API reference workspace', () => {
  it('renders every operation from the live OpenAPI document with its permission and auth', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference();

    // It reads the generated document, not a checked-in copy.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/openapi.json');

    expect(wrapper.get('[data-testid="api-reference-count"]').text()).toBe('5');
    expect(wrapper.get('[data-testid="api-reference-server"]').text()).toBe('/api/v1');

    const list = wrapper.get('[data-testid="api-reference-row-MessagesController_list"]');
    expect(list.text()).toContain('GET');
    expect(list.text()).toContain('/messages');
    expect(list.text()).toContain('List messages');
    expect(list.text()).toContain('messages.view');
    expect(list.text()).toContain('bearer');

    // Grouped by tag.
    for (const tag of ['messages', 'alerts', 'gateway', 'health'])
      expect(wrapper.find(`[data-testid="api-reference-group-${tag}"]`).exists()).toBe(true);

    // A route with no declared permission says so rather than showing blank.
    expect(
      wrapper.get('[data-testid="api-reference-row-HealthController_health"]').text(),
    ).toContain('none declared');
  });

  it('surfaces the generator’s own documented limitations verbatim', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference();

    const limitations = wrapper.get('[data-testid="api-reference-limitations"]');
    for (const declared of DOCUMENT['x-generation'].limitations)
      expect(limitations.text()).toContain(declared);

    // And what IS reflected, so a reader knows which half to trust.
    const derived = wrapper.get('[data-testid="api-reference-derived"]');
    for (const item of DOCUMENT['x-generation'].derived) expect(derived.text()).toContain(item);

    // The dangerous misreading is called out explicitly.
    expect(wrapper.get('[data-testid="api-reference-body-warning"]').text()).toContain(
      'not reflected',
    );
  });

  it('repeats the caveat that applies to the operation being read', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference();

    // A generic-object body must not read as "no fields".
    await wrapper
      .get('[data-testid="api-reference-open-MessagesController_send"]')
      .trigger('click');
    let caveats = drawerAll('[data-testid="api-reference-detail-caveat"]')
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(caveats).toContain('generic object');
    expect(caveats).toContain('validates bodies imperatively');

    // A POST with no reflected body must not read as "takes no payload".
    await wrapper
      .get('[data-testid="api-reference-open-AlertLifecycleController_acknowledge"]')
      .trigger('click');
    caveats = drawerAll('[data-testid="api-reference-detail-caveat"]')
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(caveats).toContain('records a body only when the handler binds one');

    // A grid endpoint must not read as "sort accepts anything".
    await wrapper
      .get('[data-testid="api-reference-open-MessagesController_list"]')
      .trigger('click');
    caveats = drawerAll('[data-testid="api-reference-detail-caveat"]')
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(caveats).toContain('per-resource whitelist');

    // A permissioned route with no security scheme must not read as "public".
    await wrapper
      .get('[data-testid="api-reference-open-GatewayMessagingController_submit"]')
      .trigger('click');
    caveats = drawerAll('[data-testid="api-reference-detail-caveat"]')
      .map((node) => node.textContent ?? '')
      .join(' ');
    expect(caveats).toContain('appear unauthenticated here');
  });

  it('resolves shared $ref parameters into the operation detail', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference();

    await wrapper
      .get('[data-testid="api-reference-open-MessagesController_list"]')
      .trigger('click');
    const search = { text: () => drawerText('[data-testid="api-reference-param-search"]') };
    expect(search.text()).toContain('query');
    expect(search.text()).toContain('Free-text search over the whitelisted columns.');
    expect({ text: () => drawerText('[data-testid="api-reference-param-sort"]') }.text()).toContain(
      'whitelisted sort fields',
    );
  });

  it('searches and filters by method, permission and auth', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference();

    await wrapper.get('[data-testid="api-reference-search"]').setValue('acknowledge');
    expect(wrapper.get('[data-testid="api-reference-result-count"]').text()).toContain('1 of 5');
    expect(
      wrapper
        .find('[data-testid="api-reference-row-AlertLifecycleController_acknowledge"]')
        .exists(),
    ).toBe(true);

    await wrapper.get('[data-testid="api-reference-reset"]').trigger('click');
    await wrapper.get('[data-testid="api-reference-method-post"]').trigger('click');
    expect(wrapper.get('[data-testid="api-reference-result-count"]').text()).toContain('3 of 5');
    expect(wrapper.find('[data-testid="api-reference-row-MessagesController_list"]').exists()).toBe(
      false,
    );

    await wrapper.get('[data-testid="api-reference-reset"]').trigger('click');
    await wrapper.get('[data-testid="api-reference-permission"]').setValue('messages.view');
    expect(wrapper.get('[data-testid="api-reference-result-count"]').text()).toContain('1 of 5');

    await wrapper.get('[data-testid="api-reference-permission"]').setValue('__none__');
    expect(wrapper.get('[data-testid="api-reference-result-count"]').text()).toContain('1 of 5');
    expect(wrapper.find('[data-testid="api-reference-row-HealthController_health"]').exists()).toBe(
      true,
    );

    await wrapper.get('[data-testid="api-reference-reset"]').trigger('click');
    await wrapper.get('[data-testid="api-reference-auth-filter"]').setValue('bearer');
    expect(wrapper.get('[data-testid="api-reference-result-count"]').text()).toContain('3 of 5');

    await wrapper.get('[data-testid="api-reference-search"]').setValue('nothing-matches-this');
    expect(wrapper.find('[data-testid="api-reference-empty"]').exists()).toBe(true);
  });

  it('is deep-linkable: the URL carries the filters and the open operation', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper, router } = await mountReference();

    await wrapper
      .get('[data-testid="api-reference-open-MessagesController_send"]')
      .trigger('click');
    await wrapper.get('[data-testid="api-reference-search"]').setValue('messages');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.query.op).toBe('MessagesController_send');
      expect(router.currentRoute.value.query.q).toBe('messages');
    });
  });

  it('restores state from an incoming deep link', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference(
      '/api-reference?op=AlertLifecycleController_acknowledge&method=post&q=ack',
    );

    await vi.waitFor(() =>
      expect(Boolean(inDrawer('[data-testid="api-reference-detail"]'))).toBe(true),
    );
    // The path is in the drawer's own header, which the sheet renders outside
    // the detail body — so read the whole sheet for it.
    expect(drawerText('.drawer-sheet')).toContain('/alerts/{id}/acknowledge');
    expect(drawerText('[data-testid="api-reference-detail-permissions"]')).toContain(
      'alerts.manage',
    );
    expect(
      (wrapper.get('[data-testid="api-reference-search"]').element as HTMLInputElement).value,
    ).toBe('ack');
    expect(
      wrapper.get('[data-testid="api-reference-method-post"]').attributes('aria-pressed'),
    ).toBe('true');
  });

  it('downloads the very document it rendered, without a second request', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(DOCUMENT));
    const click = vi.fn();
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = Object.getPrototypeOf(document).createElement.call(document, tag);
      if (tag === 'a') element.click = click;
      return element;
    }) as typeof document.createElement);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:doc'),
      revokeObjectURL: vi.fn(),
    });

    const { wrapper } = await mountReference();
    const before = fetchSpy.mock.calls.length;
    await wrapper.get('[data-testid="api-reference-download"]').trigger('click');

    expect(click).toHaveBeenCalled();
    expect(fetchSpy.mock.calls).toHaveLength(before);
    expect(wrapper.get('[data-testid="api-reference-downloaded"]').text()).toContain('Downloaded');
  });

  it('explains both credentials, including that the gateway key is not a bearer token', async () => {
    stubFetch(() => jsonResponse(DOCUMENT));
    const { wrapper } = await mountReference();

    expect(wrapper.get('[data-testid="api-reference-bearer-sample"]').text()).toContain(
      'Authorization: Bearer',
    );
    const apiKey = wrapper.get('[data-testid="api-reference-apikey-sample"]');
    expect(apiKey.text()).toContain('X-API-Key');
    expect(apiKey.text()).toContain('/api/v1/gateway/messages');
    expect(wrapper.get('[data-testid="api-reference-apikey-caveat"]').text()).toContain(
      'Authorization: ApiKey',
    );
  });

  it('reports a failure to load rather than rendering an empty reference', async () => {
    stubFetch(() => jsonResponse({ success: false, message: 'openapi unavailable' }, 503));
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: ApiReferenceView }],
    });
    await router.push('/api-reference');
    await router.isReady();
    const wrapper = mount(ApiReferenceView, { global: { plugins: [router] } });

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="api-reference-error"]').text()).toContain(
        'openapi unavailable',
      ),
    );
    expect(wrapper.find('[data-testid="api-reference-endpoints"]').exists()).toBe(false);
    expect(
      wrapper.get('[data-testid="api-reference-download"]').attributes('disabled'),
    ).toBeDefined();
  });

  it('is offered in the Platform group to every authenticated operator', () => {
    const entry = navigation.find((item) => item.to === '/api-reference');
    expect(entry).toBeDefined();
    expect(entry?.group).toBe('Platform');
    expect(entry?.permission).toBeUndefined();
  });
});
