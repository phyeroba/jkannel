export interface Environment {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  authAccessTokenKey?: string;
  authRefreshTokenKey?: string;
}

export function validateEnvironment(source: NodeJS.ProcessEnv): Environment {
  const nodeEnv = source.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv))
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  const port = Number(source.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535');
  if (nodeEnv === 'production' && (!source.DATABASE_URL || !source.REDIS_URL))
    throw new Error('DATABASE_URL and REDIS_URL are required in production');
  for (const name of [
    'AUTH_ACCESS_TOKEN_KEY',
    'AUTH_REFRESH_TOKEN_KEY',
    'AUTH_SIGNING_KEY',
  ] as const) {
    const key = source[name];
    if (key && Buffer.byteLength(key, 'utf8') < 32)
      throw new Error(`${name} must contain at least 32 bytes`);
  }
  if (nodeEnv === 'production') {
    const hasDedicatedKeys = source.AUTH_ACCESS_TOKEN_KEY && source.AUTH_REFRESH_TOKEN_KEY;
    if (!hasDedicatedKeys && !source.AUTH_SIGNING_KEY)
      throw new Error(
        'AUTH_ACCESS_TOKEN_KEY and AUTH_REFRESH_TOKEN_KEY are required in production ' +
          '(AUTH_SIGNING_KEY is accepted as a deprecated fallback)',
      );
  }
  return {
    nodeEnv: nodeEnv as Environment['nodeEnv'],
    port,
    databaseUrl: source.DATABASE_URL,
    redisUrl: source.REDIS_URL,
    authAccessTokenKey: source.AUTH_ACCESS_TOKEN_KEY,
    authRefreshTokenKey: source.AUTH_REFRESH_TOKEN_KEY,
  };
}
