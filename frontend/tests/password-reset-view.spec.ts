import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const routeQuery: { token?: string } = {};
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  RouterLink: { template: '<a><slot /></a>' },
}));

import PasswordResetView from '../src/views/PasswordResetView.vue';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

describe('Password reset view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete routeQuery.token;
  });

  it('requests a reset and shows the non-enumerating acknowledgement (with dev token)', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => apiResponse({ requested: true, devToken: 'dev-abc' }));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(PasswordResetView);
    await wrapper.get('[data-testid="request-tenant"]').setValue('default');
    await wrapper.get('[data-testid="request-username"]').setValue('operator');
    await wrapper.get('form').trigger('submit');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="reset-request-ack"]').exists()).toBe(true),
    );
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/auth/password-reset/request');
    expect(wrapper.get('[data-testid="reset-dev-token"]').text()).toContain('dev-abc');
  });

  it('confirms a new password when a token is present', async () => {
    routeQuery.token = 'reset-token-xyz';
    const fetchMock = vi.fn().mockImplementation(() => apiResponse({ reset: true }));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(PasswordResetView);
    await wrapper.get('[data-testid="reset-tenant"]').setValue('default');
    await wrapper.get('[data-testid="reset-new-password"]').setValue('brand-new-pass-123');
    await wrapper.get('form').trigger('submit');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="reset-login-link"]').exists()).toBe(true),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ token: 'reset-token-xyz', tenant: 'default' });
  });

  it('rejects a short new password before calling the API', async () => {
    routeQuery.token = 'reset-token-xyz';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(PasswordResetView);
    await wrapper.get('[data-testid="reset-tenant"]').setValue('default');
    await wrapper.get('[data-testid="reset-new-password"]').setValue('short');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.get('[data-testid="reset-error"]').text()).toContain('12 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
