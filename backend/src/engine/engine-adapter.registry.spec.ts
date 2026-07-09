import { EngineAdapterRegistry } from './engine-adapter.registry';
import { KamexAdapter } from './kamex.adapter';
import { KannelAdapter } from './kannel.adapter';

describe('EngineAdapterRegistry', () => {
  const registry = new EngineAdapterRegistry(new KannelAdapter(), new KamexAdapter());
  it('keeps Kannel and Kamex as sibling implementations with distinct evidence', async () => {
    const kannel = await registry.forImplementation('kannel').discoverCapabilities();
    const kamex = await registry.forImplementation('kamex').discoverCapabilities();
    expect(kannel.engine.family).toBe('kannel');
    expect(kamex.engine.family).toBe('kamex');
    expect(kannel.capabilities.find((c) => c.id === 'observability.health.native')?.support).toBe(
      'unsupported',
    );
    expect(kamex.capabilities.find((c) => c.id === 'observability.health.native')?.support).toBe(
      'supported',
    );
  });
  it('rejects unregistered engines', () =>
    expect(() => registry.forImplementation('unknown')).toThrow('No adapter'));
});
