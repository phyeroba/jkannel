import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: { value: null },
  login: vi.fn(),
  canAccess: () => true,
}));

import LoginView from '../src/views/LoginView.vue';

const mountLogin = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: LoginView },
      { path: '/reset-password', component: { template: '<p/>' } },
      { path: '/dashboard/operations', component: { template: '<p/>' } },
    ],
  });
  await router.push('/login');
  await router.isReady();
  return mount(LoginView, { global: { plugins: [router] } });
};

/**
 * The sign-in page is the first screen anybody sees, and it was the one place
 * in the console presenting invented figures as measurements.
 *
 * It carried "Throughput 16k +8.2%", "Delivery rate 98.7% — last hour" and
 * "Connected SMSCs 12", with two bar charts drawn from hardcoded arrays. This
 * deployment has three SMSCs and a carrier that has been refusing the
 * connection since 8 September. §3.3 and §17 of the spec exist precisely to
 * stop an unmeasured value being shown as a measured one, and the rest of the
 * console obeys them down to refusing to render a zero from a failed read.
 *
 * There is also nowhere honest to source real figures here: the page is
 * pre-authentication, and live throughput is not something to publish to an
 * unauthenticated visitor. So the rule is simply that the page states no
 * measurement at all.
 */
describe('Sign in — states nothing it has not measured', () => {
  it('shows none of the figures it used to invent', async () => {
    const wrapper = await mountLogin();
    const text = wrapper.text();
    for (const invented of ['16k', '98.7%', '+8.2%', '+1.4%', 'Connected SMSCs', 'Throughput'])
      expect(text).not.toContain(invented);
    wrapper.unmount();
  });

  it('shows no percentage, count or trend anywhere on the page', async () => {
    const wrapper = await mountLogin();
    const text = wrapper.text();
    // A protocol version (SMPP 3.4) is a fact about the software, not a
    // measurement, and is the only numeral the page is allowed.
    expect(text.replace(/SMPP 3\.4/g, '')).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(text).not.toMatch(/[+-]\d+(\.\d+)?%/);
    wrapper.unmount();
  });

  it('still says what the platform does', async () => {
    const wrapper = await mountLogin();
    const text = wrapper.text();
    expect(text).toContain('Carrier binds');
    expect(text).toContain('Receipts, traced');
    expect(text).toContain('Tenant isolated');
    wrapper.unmount();
  });

  it('keeps the sign-in form intact', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.find('[data-testid="username"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="password"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="login-submit"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
