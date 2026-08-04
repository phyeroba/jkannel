import { createManifest } from './capability-manifest';
import { EngineAdapterRegistry } from './engine-adapter.registry';
import {
  CapabilityEntry,
  EngineIdentity,
  SupportLevel,
  UnsupportedCapabilityError,
} from './engine-adapter.types';
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

/**
 * The capability guard. `requireCapability` previously had zero call sites, so
 * a manifest entry saying `support: 'unsupported'` changed nothing: the only
 * check was that the ADAPTER class happened to define `controlSmsc`. These
 * specs pin the guard to the operation actually requested.
 */
describe('EngineAdapterRegistry capability enforcement', () => {
  const identity: EngineIdentity = {
    instanceId: 'kamex-test',
    family: 'kamex',
    version: '1.8.3',
    build: 'test',
    adapterName: 'jkannel-kamex',
    adapterVersion: '0.1.0',
  };

  const entry = (id: string, support: SupportLevel): CapabilityEntry => ({
    id,
    support,
    owner: 'engine',
    source: 'native',
    constraints: {},
  });

  /** A stand-in engine adapter whose manifest and control result are scripted. */
  function fakeEngine(capabilities: CapabilityEntry[], ttlSeconds = 60) {
    const controlSmsc = jest.fn(async (operation: string, engineId: string) => ({
      operation,
      engineId,
      accepted: true,
      detail: 'ok',
      observedAt: new Date().toISOString(),
    }));
    const adapter = {
      identity,
      identify: async () => identity,
      discoverCapabilities: async () => createManifest(identity, capabilities, ttlSeconds),
      health: async () => ({
        adapter: 'healthy' as const,
        transport: 'reachable' as const,
        engine: 'healthy' as const,
        observedAt: new Date().toISOString(),
      }),
      coreDiagnostics: async () => ({ adapterName: 'jkannel-kamex', messages: [] }),
      controlSmsc,
    };
    const registry = new EngineAdapterRegistry(
      new KannelAdapter(),
      adapter as unknown as KamexAdapter,
    );
    return { registry, controlSmsc };
  }

  it('refuses an operation the engine declares unsupported, without calling the engine', async () => {
    const { registry, controlSmsc } = fakeEngine([
      entry('runtime.smsc.enableDisable', 'unsupported'),
      entry('runtime.smsc.reconnect', 'supported'),
    ]);

    await expect(registry.smscControl('kamex').controlSmsc('disable', 'smsc-1')).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    await expect(registry.smscControl('kamex').controlSmsc('disable', 'smsc-1')).rejects.toThrow(
      /runtime\.smsc\.enableDisable is not supported/,
    );
    expect(controlSmsc).not.toHaveBeenCalled();
  });

  it('refuses an operation the manifest does not mention at all', async () => {
    const { registry, controlSmsc } = fakeEngine([entry('observability.status.read', 'supported')]);
    await expect(registry.smscControl('kamex').controlSmsc('reconnect', 'smsc-1')).rejects.toThrow(
      /runtime\.smsc\.reconnect is not supported/,
    );
    expect(controlSmsc).not.toHaveBeenCalled();
  });

  /**
   * Reconnect and enable/disable are separate capabilities; the guard must map
   * each operation to the right one rather than gating everything on a single
   * "can control SMSCs" flag.
   */
  it('allows reconnect when only reconnect is supported', async () => {
    const { registry, controlSmsc } = fakeEngine([
      entry('runtime.smsc.enableDisable', 'unsupported'),
      entry('runtime.smsc.reconnect', 'supported'),
    ]);
    const result = await registry.smscControl('kamex').controlSmsc('reconnect', 'smsc-1');
    expect(result.accepted).toBe(true);
    expect(controlSmsc).toHaveBeenCalledWith('reconnect', 'smsc-1');
  });

  it('allows enable and disable when the engine declares them', async () => {
    const { registry, controlSmsc } = fakeEngine([
      entry('runtime.smsc.enableDisable', 'supported'),
    ]);
    await registry.smscControl('kamex').controlSmsc('enable', 'smsc-1');
    await registry.smscControl('kamex').controlSmsc('disable', 'smsc-1');
    expect(controlSmsc).toHaveBeenCalledTimes(2);
  });

  /** A 'partial' declaration is not a licence to issue the operation. */
  it("treats 'partial' support as not supported", async () => {
    const { registry } = fakeEngine([entry('runtime.smsc.enableDisable', 'partial')]);
    await expect(registry.smscControl('kamex').controlSmsc('enable', 'smsc-1')).rejects.toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('refuses to act on a stale capability manifest', async () => {
    const { registry, controlSmsc } = fakeEngine(
      [entry('runtime.smsc.enableDisable', 'supported')],
      -60,
    );
    await expect(registry.smscControl('kamex').controlSmsc('enable', 'smsc-1')).rejects.toThrow(
      /manifest is stale/,
    );
    expect(controlSmsc).not.toHaveBeenCalled();
  });

  it('still rejects an adapter that has no SMSC control at all', () => {
    const registry = new EngineAdapterRegistry(new KannelAdapter(), new KamexAdapter());
    expect(() => registry.smscControl('kannel')).toThrow(UnsupportedCapabilityError);
  });

  it('exposes the guard directly for other engine operations', async () => {
    const { registry } = fakeEngine([entry('runtime.config.reload', 'supported')]);
    await expect(
      registry.assertCapability('kamex', 'runtime.config.reload'),
    ).resolves.toMatchObject({ id: 'runtime.config.reload', support: 'supported' });
    await expect(registry.assertCapability('kamex', 'runtime.config.rollback')).rejects.toThrow(
      UnsupportedCapabilityError,
    );
  });
});
