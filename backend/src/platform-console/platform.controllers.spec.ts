import { PluginsController, SAMPLE_PLUGIN_MANIFEST } from './platform.controllers';

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
