const MINIMUM_KEY_BYTES = 32;

let warnedAboutFallback = false;

function resolveKey(preferred: string | undefined, purpose: 'access' | 'refresh'): string {
  const fallback = process.env.AUTH_SIGNING_KEY;
  const key = preferred ?? fallback;
  if (!key || Buffer.byteLength(key, 'utf8') < MINIMUM_KEY_BYTES) {
    throw new Error(
      `No valid ${purpose} token key configured. Set AUTH_${purpose.toUpperCase()}_TOKEN_KEY ` +
        `(or the deprecated AUTH_SIGNING_KEY) to at least ${MINIMUM_KEY_BYTES} bytes.`,
    );
  }
  if (!preferred && fallback && !warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      JSON.stringify({
        level: 'warn',
        message:
          'AUTH_SIGNING_KEY is deprecated; set AUTH_ACCESS_TOKEN_KEY and AUTH_REFRESH_TOKEN_KEY ' +
          'so access and refresh tokens use independent keys.',
      }),
    );
  }
  return key;
}

export function accessTokenKey(): string {
  return resolveKey(process.env.AUTH_ACCESS_TOKEN_KEY, 'access');
}

export function refreshTokenKey(): string {
  return resolveKey(process.env.AUTH_REFRESH_TOKEN_KEY, 'refresh');
}
