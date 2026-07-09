import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const routeQuery: { token?: string } = { token: 'invite-token-1' };
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  RouterLink: { template: '<a><slot /></a>' },
}));

import AcceptInvitationView from '../src/views/AcceptInvitationView.vue';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

describe('Accept invitation view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    routeQuery.token = 'invite-token-1';
  });

  it('activates the account and offers a sign-in link', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse({ id: 'user-9' }));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(AcceptInvitationView);
    await wrapper.get('[data-testid="accept-username"]').setValue('newop');
    await wrapper.get('[data-testid="accept-password"]').setValue('newoperator-pass-123');
    await wrapper.get('form').trigger('submit');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="accept-login-link"]').exists()).toBe(true),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ token: 'invite-token-1', username: 'newop' });
  });

  it('shows a friendly conflict message when the username is taken', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse('username taken', 409));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(AcceptInvitationView);
    await wrapper.get('[data-testid="accept-username"]').setValue('operator');
    await wrapper.get('[data-testid="accept-password"]').setValue('newoperator-pass-123');
    await wrapper.get('form').trigger('submit');

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="accept-error"]').text()).toContain('already taken'),
    );
  });

  it('rejects a short password before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(AcceptInvitationView);
    await wrapper.get('[data-testid="accept-username"]').setValue('newop');
    await wrapper.get('[data-testid="accept-password"]').setValue('short');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.get('[data-testid="accept-error"]').text()).toContain('12 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
