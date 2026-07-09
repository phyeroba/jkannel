export const PLUGIN_SDK_VERSION = '1.0.0' as const;
export const PLUGIN_MANIFEST_SCHEMA = '1.0' as const;
export type PluginCategory =
  | 'communication'
  | 'engine'
  | 'authentication'
  | 'notification'
  | 'dashboard'
  | 'analytics'
  | 'reporting'
  | 'import'
  | 'export'
  | 'monitoring'
  | 'security'
  | 'billing'
  | 'workflow'
  | 'automation'
  | 'integration'
  | 'ai'
  | 'developer'
  | 'theme'
  | 'ui-component';
export type PluginLifecycleState =
  'registered' | 'enabled' | 'running' | 'disabled' | 'failed' | 'isolated';
export interface PluginManifest {
  schemaVersion: string;
  id: string;
  uuid: string;
  name: string;
  vendor: string;
  version: string;
  description: string;
  category: PluginCategory;
  sdkVersion: string;
  jkannelVersion: { min: string; max: string };
  entrypoint: string;
  apiVersion: 'v1';
  dependencies: { plugins: Record<string, string>; services: string[] };
  permissions: string[];
  events: { subscribes: string[]; publishes: string[] };
  capabilities: string[];
  migrations: string[];
  configurationSchema: string;
  license: string;
  checksum: string;
  signature: string;
  supportUrl?: string;
  documentationUrl?: string;
}
export interface PluginEvent {
  id: string;
  type: string;
  schemaVersion: string;
  tenantId: string;
  correlationId: string;
  causationId?: string;
  producer: string;
  occurredAt: string;
  payload: unknown;
}
export interface PluginHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: Record<string, unknown>;
}
export interface PluginExecutionContext {
  tenantId: string;
  actorId: string;
  correlationId: string;
  signal: AbortSignal;
}
export interface PluginHostApi {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    attributes?: Record<string, unknown>,
  ): void;
  publish(event: PluginEvent): Promise<void>;
  metric(name: string, value: number, labels?: Record<string, string>): void;
}
export interface JkannelPlugin {
  initialize(host: PluginHostApi): Promise<void>;
  shutdown(): Promise<void>;
  health(context: PluginExecutionContext): Promise<PluginHealth>;
  capabilities(): readonly string[];
}
export interface ManifestValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: 'warning' | 'blocking-error';
}
export interface ManifestValidationResult {
  valid: boolean;
  issues: ManifestValidationIssue[];
  manifest?: PluginManifest;
}
