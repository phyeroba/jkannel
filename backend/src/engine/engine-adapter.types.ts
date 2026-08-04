export type SupportLevel = 'unknown' | 'unsupported' | 'partial' | 'supported';
export type CapabilityOwner = 'engine' | 'adapter' | 'platform' | 'integration';

export interface CapabilityEntry {
  id: string;
  support: SupportLevel;
  owner: CapabilityOwner;
  source: 'native' | 'extension' | 'adapter-derived' | 'platform-derived' | 'operator-override';
  constraints: Readonly<Record<string, unknown>>;
  evidence?: string;
}

export interface CapabilityManifest {
  registryVersion: '2.0';
  engineInstanceId: string;
  engine: { family: string; version: string; build: string };
  adapter: { name: string; version: string; build: string };
  observedAt: string;
  expiresAt: string;
  capabilities: ReadonlyArray<CapabilityEntry>;
}

export interface EngineIdentity {
  instanceId: string;
  family: string;
  version: string;
  build: string;
  adapterName: string;
  adapterVersion: string;
}
export interface CoreHealth {
  adapter: 'healthy' | 'degraded' | 'unhealthy';
  transport: 'reachable' | 'unreachable';
  engine: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  observedAt: string;
}
export interface CoreDiagnostics {
  adapterName: string;
  transportLatencyMs?: number;
  messages: string[];
}

export interface EngineAdapterCore {
  identify(): Promise<EngineIdentity>;
  discoverCapabilities(): Promise<CapabilityManifest>;
  health(): Promise<CoreHealth>;
  coreDiagnostics(): Promise<CoreDiagnostics>;
}

export interface SmscControlResult {
  operation: 'enable' | 'disable' | 'reconnect';
  engineId: string;
  /** The engine accepted the command(s). NOT a claim that the bind changed. */
  accepted: boolean;
  detail: string;
  observedAt: string;
  /**
   * Bind states actually observed around a `reconnect` cycle. Present only when
   * the adapter cycles the bind (stop then start) rather than issuing a single
   * command, and `cycleVerified` is false whenever the drop could not be seen —
   * an unverified cycle must never be reported as a verified one.
   */
  states?: {
    before: string | null;
    afterStop: string | null;
    afterStart: string | null;
    cycleVerified: boolean;
  };
}
export interface SmscControlProvider {
  controlSmsc(
    operation: 'enable' | 'disable' | 'reconnect',
    engineId: string,
  ): Promise<SmscControlResult>;
}

export class UnsupportedCapabilityError extends Error {
  constructor(
    readonly capabilityId: string,
    readonly engineInstanceId: string,
  ) {
    super(`Capability ${capabilityId} is unavailable for engine ${engineInstanceId}`);
  }
}
