import { beforeEach, describe, expect, it, vi } from 'vitest';

const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('API client', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('unwraps the versioned API success envelope and sends the bearer token', async () => {
    localStorage.setItem('jkannel-access-token', 'access-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(200, { success: true, data: { id: 'msg-1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiRequest } = await import('../src/api');

    await expect(apiRequest('/messages/msg-1')).resolves.toEqual({ id: 'msg-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/v1/messages/msg-1');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-1');
  });

  it('rotates tokens once after a 401 and retries with the new access token', async () => {
    localStorage.setItem('jkannel-access-token', 'expired');
    localStorage.setItem('jkannel-refresh-token', 'refresh-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401, { success: false, message: 'Expired' }))
      .mockResolvedValueOnce(
        response(200, {
          success: true,
          data: { accessToken: 'access-2', refreshToken: 'refresh-2' },
        }),
      )
      .mockResolvedValueOnce(response(200, { success: true, data: ['ok'] }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiRequest } = await import('../src/api');

    await expect(apiRequest('/messages')).resolves.toEqual(['ok']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:3000/api/v1/auth/refresh');
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('authorization')).toBe(
      'Bearer access-2',
    );
    expect(localStorage.getItem('jkannel-refresh-token')).toBe('refresh-2');
  });

  it('surfaces safe API envelope errors without retrying non-authentication failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(422, { success: false, message: 'Invalid route definition' }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiRequest } = await import('../src/api');

    await expect(apiRequest('/routing', { method: 'POST' })).rejects.toThrow(
      'Invalid route definition',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('downloads authenticated text exports without JSON envelope parsing', async () => {
    localStorage.setItem('jkannel-access-token', 'access-1');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('id,status\r\n1,sent', {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="messages.csv"',
          'x-jkannel-export-row-count': '1',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { apiDownloadText } = await import('../src/api');

    await expect(apiDownloadText('/messages/export.csv')).resolves.toEqual(
      expect.objectContaining({ text: 'id,status\r\n1,sent', filename: 'messages.csv' }),
    );
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('authorization')).toBe(
      'Bearer access-1',
    );
  });

  it('downloads binary PDF exports with the attachment filename and content type', async () => {
    localStorage.setItem('jkannel-access-token', 'access-1');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="alerts.pdf"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { apiDownloadFile } = await import('../src/api');

    const download = await apiDownloadFile('/alerts/export.pdf?limit=500');
    expect(download.filename).toBe('alerts.pdf');
    expect(download.blob.type).toContain('application/pdf');
    expect(download.blob.size).toBe(4);
  });

  it('falls back to a format-derived filename when content-disposition is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('%PDF', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiDownloadFile } = await import('../src/api');

    const download = await apiDownloadFile('/routes/export.pdf?sort=name');
    expect(download.filename).toBe('jkannel-export.pdf');
  });
});
