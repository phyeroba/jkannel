import { CapabilityEntry, CapabilityManifest, EngineIdentity } from './engine-adapter.types';

export function createManifest(
  identity: EngineIdentity,
  capabilities: CapabilityEntry[],
  ttlSeconds = 60,
): CapabilityManifest {
  const observed = new Date();
  return {
    registryVersion: '2.0',
    engineInstanceId: identity.instanceId,
    engine: { family: identity.family, version: identity.version, build: identity.build },
    adapter: { name: identity.adapterName, version: identity.adapterVersion, build: 'foundation' },
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + ttlSeconds * 1000).toISOString(),
    capabilities,
  };
}

export function requireCapability(
  manifest: CapabilityManifest,
  id: string,
  scope?: string,
): CapabilityEntry {
  if (Date.parse(manifest.expiresAt) <= Date.now())
    throw new Error(`Capability manifest is stale for ${manifest.engineInstanceId}`);
  const entry = manifest.capabilities.find((item) => item.id === id);
  if (!entry || entry.support !== 'supported') throw new Error(`Capability ${id} is not supported`);
  const scopes = entry.constraints.scopes;
  if (scope && Array.isArray(scopes) && !scopes.includes(scope))
    throw new Error(`Capability ${id} does not allow scope ${scope}`);
  return entry;
}
