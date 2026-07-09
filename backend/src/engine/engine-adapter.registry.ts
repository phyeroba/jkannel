import { Injectable } from '@nestjs/common';
import {
  EngineAdapterCore,
  SmscControlProvider,
  UnsupportedCapabilityError,
} from './engine-adapter.types';
import { KamexAdapter } from './kamex.adapter';
import { KannelAdapter } from './kannel.adapter';

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
  smscControl(implementation: string): SmscControlProvider {
    const adapter = this.forImplementation(implementation);
    if ('controlSmsc' in adapter && typeof adapter.controlSmsc === 'function')
      return adapter as EngineAdapterCore & SmscControlProvider;
    throw new UnsupportedCapabilityError(
      'runtime.smsc.enableDisable',
      (adapter as any).identity?.instanceId ?? implementation,
    );
  }
}
