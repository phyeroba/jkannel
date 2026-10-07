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

  it('debounces the search input into a ?search= query', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => apiResponse(page));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(SessionsView);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const initialCalls = fetchMock.mock.calls.length;

    await wrapper.get('[data-testid="sessions-search"]').setValue('operator');
    // Not fired yet before the 300ms debounce window elapses.
    expect(fetchMock.mock.calls.length).toBe(initialCalls);
    vi.advanceTimersByTime(300);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('search=operator'))).toBe(true),
    );
    vi.useRealTimers();
  });

  it('builds a sort query from the sort controls', async () => {
    const fetchMock = vi.fn().mockImplementation(() => apiResponse(page));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(SessionsView);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Default sort is -createdAt (descending).
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('sort=-createdAt'))).toBe(true);

    await wrapper.get('[data-testid="sessions-sort-field"]').setValue('username');
    await wrapper.get('[data-testid="sessions-sort-dir"]').setValue('asc');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('sort=username'))).toBe(true),
    );
  });

  it('exports sessions through the CSV export endpoint with the active query', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/sessions/export.csv'))
        return Promise.resolve(
          new Response('a,b', {
            status: 200,
            headers: { 'x-jkannel-export-row-count': '1' },
          }),
        );
      return apiResponse(page);
    });
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:jkannel-export'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const wrapper = mount(SessionsView);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await wrapper.get('[data-testid="sessions-export-csv"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/sessions/export.csv'))).toBe(
      true,
    );
    click.mockRestore();
  });
});

/**
 * The 2026-10-07 rebuild. This register opened on fifty three-line rows —
 * 5,187px — with no figure anywhere, so "how many sessions are live" could
 * only be answered by counting rows by eye, and revoked sessions were
 * interleaved with active ones.
 */
describe('Sessions — figures that count the table, not the page', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** The API returns `total` for whatever filter it was given. */
  const tallyingFetch = (activeTotal: number, allTotal: number, pageItems: unknown[]) =>
    vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/sessions?')) {
        const active = u.includes('active=true');
        const probe = u.includes('limit=1');
        if (probe) return apiResponse({ items: [], total: active ? activeTotal : allTotal });
        return apiResponse({ items: pageItems, total: active ? activeTotal : allTotal });
      }
      return apiResponse({});
    });

  it('counts active and revoked across the whole table, not the loaded page', async () => {
    // 25 rows on the page; 192 sessions in the table, 140 of them active.
    const rows = Array.from({ length: 25 }, (_, i) => ({ ...page.items[0], id: `sess-${i}` }));
    vi.stubGlobal('fetch', tallyingFetch(140, 192, rows));
    const wrapper = mount(SessionsView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="sessions-strip"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="sessions-stat-active"]').text()).toBe('140');
    // Derived, not guessed: everything that is not active is revoked or expired.
    expect(wrapper.get('[data-testid="sessions-stat-revoked"]').text()).toBe('52');
    expect(wrapper.get('[data-testid="sessions-stat-total"]').text()).toBe('192');
    // The page holds 25 rows and none of those figures is 25.
    wrapper.unmount();
  });

  it('renders no strip at all when the tally cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('limit=1')) return apiResponse('nope', 500);
        if (String(url).includes('/sessions')) return apiResponse(page);
        return apiResponse({});
      }),
    );
    const wrapper = mount(SessionsView);
    await vi.waitFor(() => expect(wrapper.text()).toContain('operator'));
    // Zeros on a security screen would report an estate with nobody signed in.
    expect(wrapper.find('[data-testid="sessions-strip"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('offers only the two tabs the API can honour', async () => {
    vi.stubGlobal('fetch', tallyingFetch(140, 192, page.items));
    const wrapper = mount(SessionsView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="sessions-tab-active"]').exists()).toBe(true),
    );
    // `active` is boolean on the API. A third "Revoked" tab could only filter
    // one page in the browser and would report the page's count as the
    // table's.
    expect(wrapper.find('[data-testid="sessions-tab-revoked"]').exists()).toBe(false);
    // The count arrives with the tally, a tick after the tab itself.
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="sessions-tab-all"]').text()).toContain('192'),
    );
    wrapper.unmount();
  });

  it('opens on Active, which is the tab that matters here', async () => {
    const fetchMock = tallyingFetch(140, 192, page.items);
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(SessionsView);
    await vi.waitFor(() => expect(wrapper.text()).toContain('operator'));
    const listCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/sessions?') && !url.includes('limit=1'));
    expect(listCalls[0]).toContain('active=true');
    wrapper.unmount();
  });
});
