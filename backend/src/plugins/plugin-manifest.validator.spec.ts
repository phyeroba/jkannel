import { generateKeyPairSync, sign } from 'node:crypto';
import { PluginManifestValidator } from './plugin-manifest.validator';
const manifest: any = {
  schemaVersion: '1.0',
  id: 'com.example.monitor',
  uuid: '00000000-0000-4000-8000-000000000001',
  name: 'Monitor',
  vendor: 'Example',
  version: '1.0.0',
  description: 'Safe monitor',
  category: 'monitoring',
  sdkVersion: '^1.0.0',
  jkannelVersion: { min: '1.0.0', max: '<2.0.0' },
  entrypoint: 'dist/index.js',
  apiVersion: 'v1',
  dependencies: { plugins: {}, services: [] },
  permissions: ['monitoring.read'],
  events: { subscribes: [], publishes: ['plugin.sample'] },
  capabilities: ['sample.health'],
  migrations: [],
  configurationSchema: 'config/schema.json',
  license: 'Apache-2.0',
  checksum: `sha256:${'0'.repeat(64)}`,
  signature: 'placeholder',
  supportUrl: 'https://example.com/support',
  documentationUrl: 'https://example.com/docs',
};
describe('PluginManifestValidator', () => {
  const validator = new PluginManifestValidator();
  it('accepts the strict versioned development manifest', () => {
    const result = validator.validate(manifest);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
  it('rejects unknown fields, wildcard permissions and path traversal', () => {
    const result = validator.validate({
      ...manifest,
      unexpected: true,
      permissions: ['messages.*'],
      entrypoint: '../evil.js',
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((x) => x.code)).toEqual(
      expect.arrayContaining([
        'manifest.unknown-field',
        'manifest.permission-wildcard',
        'manifest.entrypoint',
      ]),
    );
  });
  it('requires the generic adapter capability for engine plugins', () =>
    expect(
      validator.validate({ ...manifest, category: 'engine' }).issues.map((x) => x.code),
    ).toContain('manifest.engine-contract'));
  it('fails closed when a production signature is invalid', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const result = validator.validate(manifest, {
      production: true,
      publisherPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(result.issues.map((x) => x.code)).toContain('manifest.signature');
  });
});
