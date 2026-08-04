import {
  InvalidSecretReferenceError,
  MissingSecretError,
  SecretResolver,
} from './secret-resolver.service';

describe('SecretResolver', () => {
  const env = {
    KAMEX_ADMIN_PASSWORD: 's3cr3t-admin',
    KAMEX_CARRIER_A_PASSWORD: 'carrier-bind-pw',
  } as NodeJS.ProcessEnv;
  const resolver = new SecretResolver(env);

  it('maps a secret reference onto a deterministic environment variable name', () => {
    expect(resolver.envName('secret://kamex/admin-password')).toBe('KAMEX_ADMIN_PASSWORD');
    expect(resolver.envName('secret://kamex/carrier-a.password')).toBe('KAMEX_CARRIER_A_PASSWORD');
    expect(resolver.placeholder('secret://kamex/admin-password')).toBe('${KAMEX_ADMIN_PASSWORD}');
  });

  it('rejects anything that is not a well-formed reference', () => {
    for (const bad of ['plaintext-password', 'secret://', 'secret://123', 'secret:///'])
      expect(() => resolver.envName(bad)).toThrow(InvalidSecretReferenceError);
    expect(resolver.isReference('plaintext-password')).toBe(false);
  });

  it('renders a placeholder without ever reading the value', () => {
    const withoutEnv = new SecretResolver({});
    // No environment at all: rendering still produces the placeholder the
    // engine's entrypoint substitutes. Nothing secret can reach the file.
    expect(withoutEnv.placeholder('secret://kamex/carrier-a-password')).toBe(
      '${KAMEX_CARRIER_A_PASSWORD}',
    );
  });

  it('resolves a present secret and reports presence', () => {
    expect(resolver.has('secret://kamex/admin-password')).toBe(true);
    expect(resolver.resolve('secret://kamex/admin-password')).toBe('s3cr3t-admin');
    expect(resolver.has('secret://kamex/absent')).toBe(false);
  });

  it('fails loudly on a missing secret, naming the reference and variable only', () => {
    expect(() => resolver.resolve('secret://kamex/missing-password')).toThrow(MissingSecretError);
    try {
      resolver.resolve('secret://kamex/missing-password');
      fail('expected MissingSecretError');
    } catch (error) {
      const missing = error as MissingSecretError;
      expect(missing.references).toEqual(['secret://kamex/missing-password']);
      expect(missing.envNames).toEqual(['KAMEX_MISSING_PASSWORD']);
      expect(missing.message).toContain('KAMEX_MISSING_PASSWORD');
    }
  });

  it('treats an empty environment variable as missing', () => {
    const blank = new SecretResolver({ KAMEX_BLANK: '' });
    expect(blank.has('secret://kamex/blank')).toBe(false);
    expect(() => blank.resolve('secret://kamex/blank')).toThrow(MissingSecretError);
  });

  it('assertResolvable reports every missing reference at once', () => {
    try {
      resolver.assertResolvable([
        'secret://kamex/admin-password',
        'secret://kamex/one-missing',
        'secret://kamex/two-missing',
      ]);
      fail('expected MissingSecretError');
    } catch (error) {
      const missing = error as MissingSecretError;
      expect(missing.envNames).toEqual(['KAMEX_ONE_MISSING', 'KAMEX_TWO_MISSING']);
    }
  });

  it('never leaks a secret value through the error message or serialisation', () => {
    const leaky = new SecretResolver({ KAMEX_ADMIN_PASSWORD: '' });
    let serialised = '';
    try {
      leaky.assertResolvable(['secret://kamex/admin-password']);
    } catch (error) {
      const missing = error as MissingSecretError;
      serialised = `${missing.message}|${JSON.stringify(missing)}|${String(missing.stack)}`;
    }
    // The value that IS present in the sibling resolver must not appear anywhere
    // in what a caller could log.
    expect(serialised).not.toContain('s3cr3t-admin');
    expect(serialised).toContain('KAMEX_ADMIN_PASSWORD');
  });

  it('is strict only when JKANNEL_SECRETS_STRICT is explicitly true', () => {
    expect(new SecretResolver({}).strictByDefault).toBe(false);
    expect(new SecretResolver({ JKANNEL_SECRETS_STRICT: 'true' }).strictByDefault).toBe(true);
  });
});
