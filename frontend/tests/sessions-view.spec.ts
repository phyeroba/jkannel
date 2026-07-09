import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import SessionsView from '../src/views/SessionsView.vue';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

const page = {
  items: [
    {
      id: 'sess-1',
      username: 'operator',
      ip_address: '10.0.0.5',
      user_agent: 'jest',
      created_at: '2026-07-09T00:00:00Z',
      last_seen_at: '2026-07-09T06:00:00Z',
      expires_at: '2026-07-16T00:00:00Z',
      revoked_at: null,
    },
  ],
  total: 1,
};

describe('Sessions administration view', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists active sessions and revokes one through the API with confirmation', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/sessions/sess-1/revoke') && init?.method === 'POST')
        return apiResponse({ id: 'sess-1', revoked_at: '2026-07-09T07:00:00Z' });
      if (url.includes('/sessions')) return apiResponse(page);
      return apiResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const wrapper = mount(SessionsView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="session-row-sess-1"]').exists()).toBe(true),
    );

    await wrapper.get('[data-testid="session-revoke-sess-1"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="sessions-notice"]').exists()).toBe(true),
    );
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          String(c[0]).includes('/sessions/sess-1/revoke') &&
          (c[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);
    expect(wrapper.get('[data-testid="sessions-notice"]').text()).toContain('revoked');
  });

  it('builds an active-only filter query', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse(page));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(SessionsView);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await wrapper.get('[data-testid="sessions-active-filter"]').setValue(true);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('active=true'))).toBe(true),
    );
  });
});
