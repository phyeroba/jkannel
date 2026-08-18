import { Test } from '@nestjs/testing';
import { PlatformHealthModule } from './platform-health.module';
import { ServiceHealthService } from './service-health.service';
import { ResourceService } from './resource.service';
import { PlatformHealthController } from './platform-health.controller';

/**
 * Compiles the REAL module graph.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS
 * ---------------------------------------------------------------------------
 * Phase 7 shipped with a dependency-injection bug that every unit test missed
 * and that crash-looped the backend on boot:
 *
 *   ExceptionHandler: {"type":"TelemetryFreshnessService",
 *                      "context":{"index":1,"dependencies":[null,null]}}
 *
 * The cause was listing `TelemetryFreshnessService` in this module's
 * `providers`. A provider is instantiated in the injector of the module that
 * declares it, and this module has neither `KamexAdapter` nor
 * `EngineSnapshotCache` — so both constructor arguments resolved to null and
 * Nest refused to start. The fix is to IMPORT MonitoringDepthModule, which
 * already provides and exports the service with its dependencies intact.
 *
 * Every existing platform-health test constructs its subject with `new`, which
 * is right for testing behaviour but means the injector is never exercised —
 * the wiring was literally untested. The failure only appeared when the process
 * actually started.
 *
 * This test closes that gap: it asks Nest to build the container, which is the
 * same work `main.ts` does at boot. It needs no database and no engine, because
 * resolution failures happen before any provider does I/O.
 */
describe('PlatformHealthModule wiring', () => {
  it('compiles, so the process can actually boot', async () => {
    // The assertion IS the compile. A missing or unresolvable provider throws
    // here with the same error the container printed on every restart.
    const moduleRef = await Test.createTestingModule({
      imports: [PlatformHealthModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('can resolve everything the /services and /nodes routes need', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PlatformHealthModule],
    }).compile();

    // Resolving each one proves its whole dependency chain resolved too —
    // ServiceHealthService pulls in HealthService, the engine registry, the
    // SQLBox repository and TelemetryFreshnessService.
    expect(moduleRef.get(ServiceHealthService)).toBeInstanceOf(ServiceHealthService);
    expect(moduleRef.get(ResourceService)).toBeInstanceOf(ResourceService);
    expect(moduleRef.get(PlatformHealthController)).toBeInstanceOf(PlatformHealthController);

    await moduleRef.close();
  });

  it('does not re-declare TelemetryFreshnessService as its own provider', async () => {
    // The specific regression. Re-adding it to `providers` would compile in
    // isolation only if this module also gained KamexAdapter and
    // EngineSnapshotCache — and duplicating those would give the poller and the
    // services board two different caches, so the board would read telemetry
    // nobody was writing.
    const source = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, 'platform-health.module.ts'),
      'utf8',
    ) as string;
    const providers = /providers:\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? '';
    expect(providers).not.toContain('TelemetryFreshnessService');
    expect(source).toContain('MonitoringDepthModule');
  });
});
