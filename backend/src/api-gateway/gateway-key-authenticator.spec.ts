import { UnauthorizedException } from '@nestjs/common';
import { GatewayKeyAuthenticator } from './gateway-key-authenticator';
import { sha256Hex } from '../security/identity-crypto';

const SECRET = 'super-secret-value';
const PREFIX = 'abcd1234';
const RAW_KEY = `jk_${PREFIX}.${SECRET}`;

function makeDatabase(row: Record<string, unknown> | undefined) {
  return {
    authQuery: jest.fn(async () => ({ rows: row ? [row] : [] })),
  };
}

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-uuid',
    tenant_id: 7,
    user_id: 'user-uuid',
    key_hash: sha256Hex(SECRET),
    scopes: ['sms.send'],
    allowed_ips: [],
    rate_limit: 100,
    expires_at: null,
    is_enabled: true,
    ...overrides,
  };
}

describe('GatewayKeyAuthenticator', () => {
  it('parses a well-formed key and rejects malformed ones', () => {
    expect(GatewayKeyAuthenticator.parseKey(RAW_KEY)).toEqual({ prefix: PREFIX, secret: SECRET });
    expect(GatewayKeyAuthenticator.parseKey('ApiKey ' + RAW_KEY)).toEqual({
      prefix: PREFIX,
      secret: SECRET,
    });
    expect(GatewayKeyAuthenticator.parseKey('nope')).toBeNull();
    expect(GatewayKeyAuthenticator.parseKey('jk_onlyprefix')).toBeNull();
    expect(GatewayKeyAuthenticator.parseKey('jk_.secret')).toBeNull();
  });

  it('authenticates a valid, enabled, unexpired key', async () => {
    const db = makeDatabase(keyRow());
    const auth = new GatewayKeyAuthenticator(db as never);
    const client = await auth.authenticate(RAW_KEY);
    expect(client).toMatchObject({
      apiKeyId: 'key-uuid',
      tenantId: '7',
      userId: 'user-uuid',
      scopes: ['sms.send'],
      rateLimit: 100,
    });
  });

  it('rejects an unknown prefix', async () => {
    const db = makeDatabase(undefined);
    const auth = new GatewayKeyAuthenticator(db as never);
    await expect(auth.authenticate(RAW_KEY)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong secret (hash mismatch)', async () => {
    const db = makeDatabase(keyRow({ key_hash: sha256Hex('different-secret') }));
    const auth = new GatewayKeyAuthenticator(db as never);
    await expect(auth.authenticate(RAW_KEY)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a disabled key', async () => {
    const db = makeDatabase(keyRow({ is_enabled: false }));
    const auth = new GatewayKeyAuthenticator(db as never);
    await expect(auth.authenticate(RAW_KEY)).rejects.toThrow('disabled');
  });

  it('rejects an expired key', async () => {
    const db = makeDatabase(keyRow({ expires_at: new Date(Date.now() - 1000) }));
    const auth = new GatewayKeyAuthenticator(db as never);
    await expect(auth.authenticate(RAW_KEY)).rejects.toThrow('expired');
  });

  it('accepts a key whose expiry is in the future', async () => {
    const db = makeDatabase(keyRow({ expires_at: new Date(Date.now() + 60_000) }));
    const auth = new GatewayKeyAuthenticator(db as never);
    await expect(auth.authenticate(RAW_KEY)).resolves.toMatchObject({ apiKeyId: 'key-uuid' });
  });
});
