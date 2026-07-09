import { Injectable } from '@nestjs/common';
import { createManifest } from './capability-manifest';
import {
  CapabilityEntry,
  CapabilityManifest,
  CoreDiagnostics,
  CoreHealth,
  EngineAdapterCore,
  EngineIdentity,
} from './engine-adapter.types';

@Injectable()
export class KannelAdapter implements EngineAdapterCore {
  private readonly identity: EngineIdentity = {
    instanceId: 'kannel-local',
    family: 'kannel',
    version: '1.4.5',
    build: 'unknown',
    adapterName: 'jkannel-kannel',
    adapterVersion: '0.1.0',
  };
  async identify(): Promise<EngineIdentity> {
    return this.identity;
  }
  async discoverCapabilities(): Promise<CapabilityManifest> {
    const capabilities: CapabilityEntry[] = [
      {
        id: 'observability.status.read',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { formats: ['text', 'xml'] },
        evidence: 'Kannel HTTP admin status probe required at runtime',
      },
      {
        id: 'observability.health.native',
        support: 'unsupported',
        owner: 'engine',
        source: 'native',
        constraints: {},
        evidence: 'No native baseline health endpoint',
      },
      {
        id: 'storage.sqlbox',
        support: 'unknown',
        owner: 'engine',
        source: 'extension',
        constraints: { optional: true },
      },
      {
        id: 'runtime.gateway.suspendResume',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { approvalRequired: true },
      },
      {
        id: 'observability.metrics.prometheus',
        support: 'unsupported',
        owner: 'engine',
        source: 'native',
        constraints: {},
      },
    ];
    return createManifest(this.identity, capabilities);
  }
  async health(): Promise<CoreHealth> {
    return {
      adapter: 'healthy',
      transport: 'unreachable',
      engine: 'unknown',
      observedAt: new Date().toISOString(),
    };
  }
  async coreDiagnostics(): Promise<CoreDiagnostics> {
    return {
      adapterName: this.identity.adapterName,
      messages: ['Runtime endpoint is not configured in foundation mode'],
    };
  }
}
