import { Injectable } from '@nestjs/common';
import {
  PluginExecutionContext,
  PluginHealth,
  PluginHostApi,
  PluginLifecycleState,
  PluginManifest,
} from './plugin.contracts';

export class PluginPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPolicyError';
  }
}
export interface PluginExecutor {
  readonly isolation: 'worker-process';
  invoke<T>(
    pluginId: string,
    operation: 'initialize' | 'shutdown' | 'health',
    payload: unknown,
    options: { timeoutMs: number },
  ): Promise<T>;
}
interface Registered {
  manifest: PluginManifest;
  executor: PluginExecutor;
  host: PluginHostApi;
  state: PluginLifecycleState;
  failures: number;
}
export interface RuntimePolicy {
  approvedPermissions: ReadonlySet<string>;
  allowedEventPublications: ReadonlySet<string>;
  timeoutMs: number;
  failureThreshold: number;
  trustedPublisher: boolean;
  isolation: 'worker-process';
}

@Injectable()
export class PluginRuntime {
  private readonly plugins = new Map<string, Registered>();
  register(
    manifest: PluginManifest,
    executor: PluginExecutor,
    policy: RuntimePolicy,
    services: {
      log: PluginHostApi['log'];
      publish: PluginHostApi['publish'];
      metric: PluginHostApi['metric'];
    },
  ): void {
    if (
      !policy.trustedPublisher ||
      policy.isolation !== 'worker-process' ||
      executor.isolation !== 'worker-process'
    )
      throw new PluginPolicyError(
        'Plugins require an approved publisher and worker-process executor',
      );
    if (this.plugins.has(manifest.id)) throw new PluginPolicyError('Plugin is already registered');
    for (const permission of manifest.permissions)
      if (!policy.approvedPermissions.has(permission))
        throw new PluginPolicyError(`Permission not approved: ${permission}`);
    const api: PluginHostApi = {
      log: (level, message, attributes) => services.log(level, message, this.redact(attributes)),
      metric: (name, value, labels) => services.metric(`${manifest.id}.${name}`, value, labels),
      publish: async (event) => {
        if (
          event.producer !== manifest.id ||
          !manifest.events.publishes.includes(event.type) ||
          !policy.allowedEventPublications.has(event.type)
        )
          throw new PluginPolicyError('Event publication is not declared and approved');
        await services.publish({ ...event, payload: this.redact(event.payload) });
      },
    };
    this.plugins.set(manifest.id, {
      manifest,
      executor,
      host: api,
      state: 'registered',
      failures: 0,
    });
  }
  async enable(id: string, policy: RuntimePolicy): Promise<void> {
    const p = this.get(id);
    await this.invoke(p, policy, () =>
      p.executor.invoke(id, 'initialize', {}, { timeoutMs: policy.timeoutMs }),
    );
    p.state = 'enabled';
  }
  async health(
    id: string,
    context: Omit<PluginExecutionContext, 'signal'>,
    policy: RuntimePolicy,
  ): Promise<PluginHealth> {
    const p = this.get(id);
    if (p.state === 'isolated')
      return { status: 'unhealthy', message: 'Plugin isolated by circuit breaker' };
    return this.invoke(p, policy, () =>
      p.executor.invoke<PluginHealth>(id, 'health', context, { timeoutMs: policy.timeoutMs }),
    );
  }
  async disable(id: string, policy: RuntimePolicy): Promise<void> {
    const p = this.get(id);
    await this.invoke(p, policy, () =>
      p.executor.invoke(id, 'shutdown', {}, { timeoutMs: policy.timeoutMs }),
    );
    p.state = 'disabled';
  }
  hostApi(id: string): PluginHostApi {
    return this.get(id).host;
  }
  state(id: string): PluginLifecycleState {
    return this.get(id).state;
  }
  private get(id: string) {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new PluginPolicyError('Plugin is not registered');
    return plugin;
  }
  private async invoke<T>(
    plugin: Registered,
    policy: RuntimePolicy,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work();
      plugin.failures = 0;
      return result;
    } catch (error) {
      plugin.failures++;
      plugin.state = plugin.failures >= policy.failureThreshold ? 'isolated' : 'failed';
      throw error;
    }
  }
  private redact<T>(value: T): T {
    const visit = (x: any): any => {
      if (Array.isArray(x)) return x.map(visit);
      if (x && typeof x === 'object')
        return Object.fromEntries(
          Object.entries(x).map(([k, v]) => [
            k,
            /secret|password|token|credential|authorization/i.test(k) ? '[redacted]' : visit(v),
          ]),
        );
      return x;
    };
    return visit(value);
  }
}
