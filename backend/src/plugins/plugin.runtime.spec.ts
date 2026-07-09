import { PluginManifest } from './plugin.contracts';
import { PluginExecutor, PluginPolicyError, PluginRuntime, RuntimePolicy } from './plugin.runtime';
const manifest: any = {
  id: 'com.example.monitor',
  permissions: ['monitoring.read'],
  events: { publishes: ['plugin.sample'] },
} as PluginManifest;
const policy: RuntimePolicy = {
  approvedPermissions: new Set(['monitoring.read']),
  allowedEventPublications: new Set(['plugin.sample']),
  timeoutMs: 20,
  failureThreshold: 2,
  trustedPublisher: true,
  isolation: 'worker-process',
};
const services = {
  log: jest.fn(),
  metric: jest.fn(),
  publish: jest.fn().mockResolvedValue(undefined),
};
const executor = (
  invoke: PluginExecutor['invoke'] = jest.fn().mockResolvedValue({ status: 'healthy' }),
): PluginExecutor => ({ isolation: 'worker-process', invoke });
describe('PluginRuntime', () => {
  beforeEach(() => jest.clearAllMocks());
  it('denies unapproved permissions and untrusted execution', () => {
    const runtime = new PluginRuntime();
    expect(() =>
      runtime.register(
        { ...manifest, permissions: ['users.manage'] },
        executor(),
        policy,
        services,
      ),
    ).toThrow(PluginPolicyError);
    expect(() =>
      runtime.register(manifest, executor(), { ...policy, trustedPublisher: false }, services),
    ).toThrow(PluginPolicyError);
  });
  it('uses an executor boundary and exposes a redacting, declaration-scoped host API', async () => {
    const invoke = jest.fn().mockResolvedValue(undefined);
    const runtime = new PluginRuntime();
    runtime.register(manifest, executor(invoke), policy, services);
    await runtime.enable(manifest.id, policy);
    expect(invoke).toHaveBeenCalledWith(
      manifest.id,
      'initialize',
      {},
      expect.objectContaining({ timeoutMs: 20 }),
    );
    const host = runtime.hostApi(manifest.id);
    await host.publish({
      id: 'e',
      type: 'plugin.sample',
      schemaVersion: '1',
      tenantId: '1',
      correlationId: 'c',
      producer: manifest.id,
      occurredAt: new Date().toISOString(),
      payload: { password: 'secret', safe: 'yes' },
    });
    expect(services.publish).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { password: '[redacted]', safe: 'yes' } }),
    );
    await expect(
      host.publish({
        id: 'e',
        type: 'undeclared',
        schemaVersion: '1',
        tenantId: '1',
        correlationId: 'c',
        producer: manifest.id,
        occurredAt: 'now',
        payload: {},
      }),
    ).rejects.toThrow(PluginPolicyError);
  });
  it('isolates a repeatedly failing worker transport', async () => {
    const runtime = new PluginRuntime();
    runtime.register(
      manifest,
      executor(jest.fn().mockRejectedValue(new PluginPolicyError('worker timed out'))),
      policy,
      services,
    );
    for (let i = 0; i < 2; i++)
      await expect(
        runtime.health(manifest.id, { tenantId: '1', actorId: 'u', correlationId: 'c' }, policy),
      ).rejects.toThrow('timed out');
    expect(runtime.state(manifest.id)).toBe('isolated');
  });
});
