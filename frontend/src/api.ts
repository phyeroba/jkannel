// Default to 127.0.0.1 (IPv4) not localhost: browsers resolve localhost to IPv6
// ::1 first, but Docker publishes ports on IPv4, so localhost:3000 fails.
const base = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api') + '/v1';
let accessToken = localStorage.getItem('jkannel-access-token') ?? '';
let refreshToken = localStorage.getItem('jkannel-refresh-token') ?? '';
export function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('jkannel-access-token', access);
  localStorage.setItem('jkannel-refresh-token', refresh);
}
export function clearTokens() {
  accessToken = '';
  refreshToken = '';
  localStorage.removeItem('jkannel-access-token');
  localStorage.removeItem('jkannel-refresh-token');
}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
/**
 * The message an operator should actually read.
 *
 * A 429 from the auth throttle answers "Too many authentication attempts. Try
 * again later." — accurate, and reported from the Reports and API Gateway
 * screens as if THOSE were broken. They are not: the limiter counts failed
 * SIGN-INS and failed token refreshes, and once it trips it blocks the refresh
 * that every screen depends on. So whichever screen an operator is looking at
 * is the one that appears to fail, and the real cause is somewhere they are not
 * looking.
 *
 * The server already knows how long it will last — `retryAfterSeconds` in the
 * body, `Retry-After` on the response — and nothing was reading either. "Try
 * again later" with no idea whether later means a minute or a quarter of an
 * hour is the difference between waiting and filing a bug.
 */
function describeFailure(response: Response, body: any): string {
  const fallback = body.message ?? `Request failed (${response.status})`;
  if (response.status !== 429) return fallback;
  const seconds = Number(body.retryAfterSeconds ?? response.headers.get('Retry-After'));
  const wait = Number.isFinite(seconds) && seconds > 0 ? describeWait(seconds) : null;
  return (
    'Sign-in is temporarily locked after repeated failed attempts, so this screen could not ' +
    'refresh its session. Nothing here is broken' +
    (wait ? `, and it clears in about ${wait}.` : '. It clears on its own shortly.')
  );
}

function describeWait(seconds: number): string {
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function unwrap<T>(response: Response): Promise<T> {
  let body: any = {};
  try {
    body = await response.json();
  } catch {
    /* Keep non-JSON failures representable. */
  }
  if (!response.ok || body.success === false)
    throw new ApiError(response.status, describeFailure(response, body), body.code);
  return (body.data ?? body) as T;
}
async function renew() {
  if (!refreshToken) throw new Error('Session expired');
  const response = await fetch(`${base}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const tokens = await unwrap<{ accessToken: string; refreshToken: string }>(response);
  setTokens(tokens.accessToken, tokens.refreshToken);
}
export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${base}${path}`, { ...options, headers });
  if (response.status === 401 && retry && refreshToken) {
    await renew();
    return apiRequest<T>(path, options, false);
  }
  return unwrap<T>(response);
}
export async function apiPublicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...options, headers });
  return unwrap<T>(response);
}
async function apiDownloadRaw(
  path: string,
  retry: boolean,
): Promise<{ buffer: ArrayBuffer; type: string; filename: string; headers: Headers }> {
  const headers = new Headers();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${base}${path}`, { headers });
  if (response.status === 401 && retry && refreshToken) {
    await renew();
    return apiDownloadRaw(path, false);
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      (await response.text()) || `Request failed (${response.status})`,
    );
  const disposition = response.headers.get('content-disposition') ?? '';
  const extension = /\.pdf(\?|$)/.test(path) ? 'pdf' : 'csv';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `jkannel-export.${extension}`;
  const type =
    response.headers.get('content-type') ??
    (extension === 'pdf' ? 'application/pdf' : 'text/csv;charset=utf-8');
  return { buffer: await response.arrayBuffer(), type, filename, headers: response.headers };
}
export async function apiDownloadFile(
  path: string,
  retry = true,
): Promise<{ blob: Blob; filename: string; headers: Headers }> {
  const { buffer, type, filename, headers } = await apiDownloadRaw(path, retry);
  return { blob: new Blob([buffer], { type }), filename, headers };
}
export async function apiDownloadText(
  path: string,
  retry = true,
): Promise<{ text: string; filename: string; headers: Headers }> {
  const { buffer, filename, headers } = await apiDownloadRaw(path, retry);
  return { text: new TextDecoder().decode(buffer), filename, headers };
}
export function saveDownloadedFile(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}
export function currentRefreshToken() {
  return refreshToken;
}
