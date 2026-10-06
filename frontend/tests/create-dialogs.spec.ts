import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

const permissions = ref(new Set(['messages.send', 'system.manage', 'configuration.manage']));
vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    get permissions() {
      return permissions.value;
    },
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import DataIntegrityView from '../src/views/DataIntegrityView.vue';
import RecipientPolicyView from '../src/views/RecipientPolicyView.vue';

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const mountView = async (component: unknown, path: string) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => apiResponse({ items: [], total: 0 })),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path, component: component as never }],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(component as never, { global: { plugins: [router] } });
  await vi.waitFor(() => expect(wrapper.html().length).toBeGreaterThan(100));
  return wrapper;
};

/**
 * Every create form in this console is meant to have the same shape: a
 * subtitle saying what the record is for, named groups, a hint under each
 * field, and a submit that names what it creates. These two were the last
 * flat ones — labels beside their inputs, no hints, and buttons reading
 * "Add" and "Create".
 */
describe('Create dialogs — the house shape', () => {
  it('the recipient-policy entry says what it will do before it is added', async () => {
    const wrapper = await mountView(RecipientPolicyView, '/recipient-policy');
    await wrapper.get('[data-testid="policy-new"]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="policy-form"]')).toBeTruthy());

    const form = document.querySelector('[data-testid="policy-form"]') as HTMLElement;
    // Before a destination is typed, it asks for one rather than asserting.
    expect(form.querySelector('[data-testid="policy-sentence"]')?.textContent).toContain(
      'Enter a destination',
    );

    const msisdn = form.querySelector('[data-testid="entry-msisdn"]') as HTMLInputElement;
    msisdn.value = '+256772000118';
    msisdn.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect(form.querySelector('[data-testid="policy-sentence"]')?.textContent).toContain(
        '+256772000118',
      ),
    );
    const sentence = form.querySelector('[data-testid="policy-sentence"]')?.textContent ?? '';
    // The list is the consequential choice, so the sentence names it, and the
    // default scope is stated rather than left to be inferred from a blank.
    expect(sentence).toContain('blacklist');
    expect(sentence).toContain('for every customer');
    wrapper.unmount();
  });

  it('the reference record refuses invalid JSON here rather than at the API', async () => {
    const wrapper = await mountView(DataIntegrityView, '/data-integrity');
    await wrapper.get('[data-testid="record-new"]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="record-form"]')).toBeTruthy());

    const form = document.querySelector('[data-testid="record-form"]') as HTMLElement;
    const key = form.querySelector('[data-testid="record-key"]') as HTMLInputElement;
    const value = form.querySelector('[data-testid="record-value"]') as HTMLInputElement;
    const submit = form.querySelector('[data-testid="record-create"]') as HTMLButtonElement;

    key.value = 'carrier.kamdixy.contact';
    key.dispatchEvent(new Event('input'));
    value.value = '{ "email": ';
    value.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(submit.disabled).toBe(true));
    expect(form.textContent).toContain('Not valid JSON');

    value.value = '{ "email": "noc@example.net" }';
    value.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    wrapper.unmount();
  });
});
