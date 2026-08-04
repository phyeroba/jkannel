import { Injectable } from '@nestjs/common';
import { requireCapability } from './capability-manifest';
import {
  CapabilityEntry,
  EngineAdapterCore,
  SmscControlProvider,
  UnsupportedCapabilityError,
} from './engine-adapter.types';
import { KamexAdapter } from './kamex.adapter';
import { KannelAdapter } from './kannel.adapter';

/**
 * Which declared capability each runtime operation actually needs.
 *
 * Splitting reconnect from enable/disable matters: Kamex declares them as two
 * separate capabilities, and an engine build (or an operator override) can
 * support one without the other.
 */
const SMSC_CONTROL_CAPABILITY: Record<'enable' | 'disable' | 'reconnect', string> = {
  enable: 'runtime.smsc.enableDisable',
  disable: 'runtime.smsc.enableDisable',
  reconnect: 'runtime.smsc.reconnect',
};

@Injectable()
export class EngineAdapterRegistry {
  constructor(
    private readonly kannel: KannelAdapter,
    private readonly kamex: KamexAdapter,
  ) {}
  forImplementation(implementation: string): EngineAdapterCore {
    if (implementation === 'kannel') return this.kannel;
    if (implementation === 'kamex') return this.kamex;
    throw new Error(`No adapter registered for ${implementation}`);
  }

  /**
   * Asserts the adapter's freshly discovered capability manifest declares `id`
   * as supported, translating any manifest problem (absent, unsupported,
   * out-of-scope, stale) into {@link UnsupportedCapabilityError}.
   *
   * This is the guard `capability-manifest.requireCapability` was written for.
   * Before this it had no call sites, so every declared capability was
   * advisory: the only real check was a duck-typed `'controlSmsc' in adapter`,
   * which asks whether the ADAPTER has a method — not whether the ENGINE in
   * front of it supports the operation.
   */
  async assertCapability(
    implementation: string,
    id: string,
    scope?: string,
  ): Promise<CapabilityEntry> {
    const adapter = this.forImplementation(implementation);
    const manifest = await adapter.discoverCapabilities();
    try {
      return requireCapability(manifest, id, scope);
    } catch (reason) {
      const failure = new UnsupportedCapabilityError(id, manifest.engineInstanceId);
      failure.message = `${failure.message}: ${(reason as Error).message}`;
      failure.cause = reason;
      throw failure;
    }
  }

  /**
   * Returns an SMSC-control provider that is capability-guarded.
   *
   * Deliberately still synchronous (callers chain `.controlSmsc(...)`), with
   * the assertion performed inside the already-async `controlSmsc`. The
   * returned provider refuses an operation the engine does not declare instead
   * of sending it and interpreting whatever the engine says back.
   */
  smscControl(implementation: string): SmscControlProvider {
    const adapter = this.forImplementation(implementation);
    if (!('controlSmsc' in adapter) || typeof adapter.controlSmsc !== 'function')
      throw new UnsupportedCapabilityError(
        'runtime.smsc.enableDisable',
        (adapter as { identity?: { instanceId?: string } }).identity?.instanceId ?? implementation,
      );
    const provider = adapter as EngineAdapterCore & SmscControlProvider;
    return {
      controlSmsc: async (operation, engineId) => {
        await this.assertCapability(implementation, SMSC_CONTROL_CAPABILITY[operation]);
        return provider.controlSmsc(operation, engineId);
      },
    };
  }
}
