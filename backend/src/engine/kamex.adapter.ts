import { Injectable } from '@nestjs/common';
import { createManifest } from './capability-manifest';
import {
  CapabilityEntry,
  CapabilityManifest,
  CoreDiagnostics,
  CoreHealth,
  EngineAdapterCore,
  EngineIdentity,
  SmscControlProvider,
  SmscControlResult,
  UnsupportedCapabilityError,
} from './engine-adapter.types';
import { KamexSqlboxRepository } from './kamex-sqlbox.repository';

@Injectable()
export class KamexAdapter implements EngineAdapterCore, SmscControlProvider {
  constructor(private readonly sqlbox?: KamexSqlboxRepository) {}
  private readonly identity: EngineIdentity = {
    instanceId: 'kamex-local',
    family: 'kamex',
    version: '1.8.3',
    build: 'unknown',
    adapterName: 'jkannel-kamex',
    adapterVersion: '0.1.0',
  };
  async identify(): Promise<EngineIdentity> {
    return this.identity;
  }
  async discoverCapabilities(): Promise<CapabilityManifest> {
    const sqlbox = await this.sqlbox?.probe();
    const capabilities: CapabilityEntry[] = [
      {
        id: 'observability.status.read',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { formats: ['json'] },
      },
      {
        id: 'observability.health.native',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { path: '/health' },
      },
      {
        id: 'observability.metrics.prometheus',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { path: '/metrics' },
      },
      {
        id: 'observability.logs.structured',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { format: 'json' },
      },
      {
        id: 'runtime.config.reload',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { mechanism: 'SIGHUP', approvalRequired: true },
      },
      {
        id: 'runtime.smsc.reconnect',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { scope: 'single-smsc', approvalRequired: true, idempotent: true },
      },
      {
        id: 'runtime.smsc.enableDisable',
        support: 'supported',
        owner: 'engine',
        source: 'native',
        constraints: { scope: 'single-smsc', approvalRequired: true, idempotent: true },
      },
      {
        id: 'storage.sqlbox',
        support: sqlbox?.available ? 'supported' : 'unknown',
        owner: 'engine',
        source: 'extension',
        constraints: { optionalPackage: 'kamex-sqlbox', tables: ['send_sms', 'sent_sms'] },
        evidence: sqlbox?.evidence,
      },
    ];
    return createManifest(this.identity, capabilities);
  }
  async health(): Promise<CoreHealth> {
    const observedAt = new Date().toISOString();
    const base = process.env.KAMEX_BASE_URL;
    if (!base)
      return { adapter: 'healthy', transport: 'unreachable', engine: 'unknown', observedAt };
    try {
      const started = Date.now();
      const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(3000) });
      return {
        adapter: 'healthy',
        transport: 'reachable',
        engine: response.ok ? 'healthy' : response.status === 503 ? 'degraded' : 'unhealthy',
        observedAt,
      };
    } catch {
      return { adapter: 'degraded', transport: 'unreachable', engine: 'unknown', observedAt };
    }
  }
  async coreDiagnostics(): Promise<CoreDiagnostics> {
    const base = process.env.KAMEX_BASE_URL;
    const password = process.env.KAMEX_STATUS_PASSWORD;
    if (!base || !password)
      return {
        adapterName: this.identity.adapterName,
        messages: ['Kamex runtime endpoint is not configured'],
      };
    const started = Date.now();
    try {
      const url = new URL('/status.json', base);
      url.searchParams.set('password', password);
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok)
        return {
          adapterName: this.identity.adapterName,
          transportLatencyMs: Date.now() - started,
          messages: [`Kamex status returned HTTP ${response.status}`],
        };
      const status = (await response.json()) as Record<string, unknown>;
      return {
        adapterName: this.identity.adapterName,
        transportLatencyMs: Date.now() - started,
        messages: [JSON.stringify(status)],
      };
    } catch (error) {
      return {
        adapterName: this.identity.adapterName,
        transportLatencyMs: Date.now() - started,
        messages: [`Kamex status unavailable: ${(error as Error).message}`],
      };
    }
  }
  async controlSmsc(
    operation: 'enable' | 'disable' | 'reconnect',
    engineId: string,
  ): Promise<SmscControlResult> {
    const capability =
      operation === 'reconnect' ? 'runtime.smsc.reconnect' : 'runtime.smsc.enableDisable';
    const manifest = await this.discoverCapabilities();
    if (
      !manifest.capabilities.some((item) => item.id === capability && item.support === 'supported')
    )
      throw new UnsupportedCapabilityError(capability, this.identity.instanceId);
    const base = process.env.KAMEX_BASE_URL;
    const password = process.env.KAMEX_ADMIN_PASSWORD;
    if (!base || !password) throw new Error('Kamex administrative endpoint is not configured');
    const command = operation === 'disable' ? 'stop-smsc' : 'start-smsc';
    const url = new URL(`/${command}`, base);
    url.searchParams.set('password', password);
    url.searchParams.set('smsc', engineId);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const detail = await response.text();
    if (!response.ok || /could not|not given|denied/i.test(detail))
      throw new Error(`Kamex SMSC ${operation} failed`);
    return { operation, engineId, accepted: true, detail, observedAt: new Date().toISOString() };
  }
}
