import { BadRequestException } from '@nestjs/common';
import { PluginsController, SAMPLE_PLUGIN_MANIFEST } from './platform.controllers';

const request = { principal: { tenantId: '1', userId: 'operator' } } as any;

describe('PluginsController.sampleManifest', () => {
  it('returns a complete, downloadable sample plugin manifest', () => {
    const manifest = new PluginsController({} as any).sampleManifest();
    expect(manifest).toBe(SAMPLE_PLUGIN_MANIFEST);
    expect(manifest.schemaVersion).toBe('1.0');
    expect(manifest.id).toMatch(/\./); // reverse-domain id
    expect(manifest.category).toBe('monitoring');
    expect(manifest.permissions).toEqual(['monitoring.read']);
    expect(manifest.events.subscribes).toContain('engine.health.changed.v1');
    expect(manifest.events.publishes).toContain('plugin.health.observed.v1');
    expect(manifest.jkannelVersion).toEqual({ min: '1.0.0', max: '<2.0.0' });
    expect(manifest.license).toBe('Apache-2.0');
  });
});

/**
 * PluginManifestValidator was thorough, tested and had zero callers: install
 * inserted posted JSON verbatim after checking only `if (!b.id)`. These prove
 * it is now on the install path.
 */
describe('PluginsController.install manifest validation', () => {
  const installPlugin = jest.fn().mockResolvedValue({ id: 'reg-1', plugin_id: 'x' });
  const controller = new PluginsController({ installPlugin } as any);
  beforeEach(() => installPlugin.mockClear());

  it('installs a valid manifest', async () => {
    await controller.install(request, { ...SAMPLE_PLUGIN_MANIFEST });
    expect(installPlugin).toHaveBeenCalledTimes(1);
  });

  it('rejects a manifest with wildcard permissions and writes nothing', () => {
    expect(() =>
      controller.install(request, { ...SAMPLE_PLUGIN_MANIFEST, permissions: ['*'] }),
    ).toThrow(BadRequestException);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('rejects a traversing entrypoint', () => {
    expect(() =>
      controller.install(request, { ...SAMPLE_PLUGIN_MANIFEST, entrypoint: '../../etc/passwd.js' }),
    ).toThrow(BadRequestException);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('rejects an unsigned manifest', () => {
    const { signature, ...unsigned } = SAMPLE_PLUGIN_MANIFEST as any;
    void signature;
    expect(() => controller.install(request, unsigned)).toThrow(BadRequestException);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('rejects a malformed checksum', () => {
    expect(() =>
      controller.install(request, { ...SAMPLE_PLUGIN_MANIFEST, checksum: 'not-a-digest' }),
    ).toThrow(BadRequestException);
  });

  it('returns the path-annotated issue list so the author can fix the manifest', () => {
    try {
      controller.install(request, { ...SAMPLE_PLUGIN_MANIFEST, category: 'nonsense' });
      throw new Error('expected a BadRequestException');
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as any;
      expect(response.message).toMatch(/Plugin manifest is invalid/);
      expect(response.issues.some((issue: any) => issue.path === 'category')).toBe(true);
    }
  });

  it('still rejects a body with no id before validating', () => {
    expect(() => controller.install(request, {})).toThrow(BadRequestException);
  });
});
