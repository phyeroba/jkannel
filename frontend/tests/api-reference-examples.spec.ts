import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import CodeConsole from '../src/components/CodeConsole.vue';
import ApiReferenceView from '../src/views/ApiReferenceView.vue';

/** Two operations that exercise the two credential paths and both body cases. */
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'JKANNEL API', version: '1.0.0' },
  servers: [{ url: '/api/v1' }],
  'x-generation': { strategy: 'route-reflection', derived: ['paths'], limitations: [] },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: { GridPage: { type: 'object' } },
  },
  paths: {
    '/messages/{id}': {
      get: {
        operationId: 'MessagesController_get',
        summary: 'Read one message',
        tags: ['messages'],
        security: [{ bearerAuth: [] }],
        'x-required-permissions': ['messages.view'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/gateway/messages': {
      post: {
        operationId: 'GatewayMessagingController_submit',
        summary: 'Submit one message',
        tags: ['gateway'],
        // No `security`: the generator detects only the bearer guard by name, so
        // a key-authenticated route arrives looking unauthenticated.
        'x-required-permissions': ['sms.send'],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'created' } },
      },
    },
  },
};

/**
 * The view writes every filter and the open operation into the query string, so
 * it must be mounted on a route the router actually knows. Mounting at "/" makes
 * `router.replace({ query })` reject with "No match", which surfaces as an
 * unhandled rejection rather than as a useful failure.
 */
async function mountView() {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: DOCUMENT }), { status: 200 }),
      ),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/api-reference', name: 'api-reference', component: ApiReferenceView }],
  });
  await router.push('/api-reference');
  await router.isReady();
  return { router, wrapper: mount(ApiReferenceView, { global: { plugins: [router] } }) };
}

/** Waits for the mounted fetch and the render it triggers. */
async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

/**
 * The operation detail is a DetailDrawer, which teleports to <body> — so it is
 * deliberately outside the component wrapper and `wrapper.find` cannot see it.
 * That is the same reason it now works for a reader: the sheet is anchored to
 * the viewport rather than appended to the bottom of a 345-row page.
 */
const inDrawer = (selector: string) => document.body.querySelector(selector);
const drawerText = (selector: string) => inDrawer(selector)?.textContent ?? '';

// Teleported nodes outlive their wrapper, so without this each test inherits
// the previous test's open drawer and asserts against stale markup.
beforeEach(() => {
  document.body.innerHTML = '';
});

describe('CodeConsole', () => {
  it('renders every line of the sample, including blank ones', () => {
    // A dropped blank line silently joins two shell commands into one.
    const wrapper = mount(CodeConsole, { props: { title: 'x', code: 'one\n\nthree' } });
    expect(wrapper.findAll('.console-line')).toHaveLength(3);
    expect(wrapper.text()).toContain('three');
  });

  it('reports a blocked clipboard instead of silently doing nothing', async () => {
    // On an insecure origin navigator.clipboard is undefined. A button that
    // appears to work but does not is worse than one that admits it failed:
    // the reader pastes whatever was already in the clipboard.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    const wrapper = mount(CodeConsole, { props: { title: 'x', code: 'sample' } });
    await wrapper.get('[data-testid="code-console-copy"]').trigger('click');
    await settle();
    expect(wrapper.get('[data-testid="code-console-copy"]').text()).toBe('Copy blocked');
  });

  it('copies the exact text it displays', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const wrapper = mount(CodeConsole, { props: { title: 'x', code: 'curl -X GET "/api/v1"' } });
    await wrapper.get('[data-testid="code-console-copy"]').trigger('click');
    expect(writeText).toHaveBeenCalledWith('curl -X GET "/api/v1"');
  });
});

describe('API reference worked examples', () => {
  it('shows a runnable example once an operation is opened', async () => {
    const { wrapper } = await mountView();
    await settle(6);
    await wrapper.get('[data-testid="api-reference-open-MessagesController_get"]').trigger('click');
    await settle();

    const request = drawerText('[data-testid="api-reference-example-request"]');
    expect(request).toContain('curl -X GET');
    expect(request).toContain('/api/v1/messages/');
    expect(request).toContain('Authorization: Bearer');
  });

  it('switches language without losing the operation', async () => {
    const { wrapper } = await mountView();
    await settle(6);
    await wrapper.get('[data-testid="api-reference-open-MessagesController_get"]').trigger('click');
    await settle();
    await (inDrawer('[data-testid="api-reference-lang-python"]') as HTMLElement).click();
    await settle();

    const request = drawerText('[data-testid="api-reference-example-request"]');
    expect(request).toContain('import requests');
    expect(request).toContain('/api/v1/messages/');
  });

  it('uses the API key, not a bearer token, on a gateway route', async () => {
    // The document says nothing about this route's auth. Getting it wrong here
    // would hand a reader a call that always 401s.
    const { wrapper } = await mountView();
    await settle(6);
    await wrapper
      .get('[data-testid="api-reference-open-GatewayMessagingController_submit"]')
      .trigger('click');
    await settle();

    const request = drawerText('[data-testid="api-reference-example-request"]');
    expect(request).toContain('X-API-Key');
    expect(request).not.toContain('Bearer');
    expect(drawerText('[data-testid="api-reference-example-credential"]')).toContain(
      'not by a bearer token',
    );
  });

  it('lists only the failures the opened operation can produce', async () => {
    const { wrapper } = await mountView();
    await settle(6);
    await wrapper.get('[data-testid="api-reference-open-MessagesController_get"]').trigger('click');
    await settle();

    // Has a path identifier, a permission and a bearer requirement, so all
    // three apply — and so does 400, because a malformed UUID in a required
    // path segment is rejected before the handler runs.
    expect(Boolean(inDrawer('[data-testid="api-reference-example-error-400"]'))).toBe(true);
    expect(Boolean(inDrawer('[data-testid="api-reference-example-error-401"]'))).toBe(true);
    expect(Boolean(inDrawer('[data-testid="api-reference-example-error-403"]'))).toBe(true);
    expect(Boolean(inDrawer('[data-testid="api-reference-example-error-404"]'))).toBe(true);
    // A read cannot exhaust a write rate limit; 429 is listed on gateway and
    // mutating routes only. The unit tests cover the omissions in detail.
    expect(Boolean(inDrawer('[data-testid="api-reference-example-error-429"]'))).toBe(false);
  });

  it('flags a placeholder body rather than passing invented fields off as the contract', async () => {
    const { wrapper } = await mountView();
    await settle(6);
    await wrapper
      .get('[data-testid="api-reference-open-GatewayMessagingController_submit"]')
      .trigger('click');
    await settle();

    // POST /gateway/messages is curated from the controller, so it must NOT be
    // flagged — the flag has to mean something.
    expect(Boolean(inDrawer('[data-testid="api-reference-example-placeholder"]'))).toBe(false);
    expect(drawerText('[data-testid="api-reference-example-request"]')).toContain('"receiver"');
  });
});
