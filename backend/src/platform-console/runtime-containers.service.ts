import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EngineAdapterRegistry } from '../engine/engine-adapter.registry';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface RuntimeContainer {
  id: string;
  name: string;
  service: string;
  image: string;
  // edge added with the reverse proxies, which terminate HTTP in front of
  // everything else and belong on no other network.
  network: 'database' | 'application' | 'engine' | 'monitoring' | 'edge';
  status: 'running' | 'degraded' | 'stopped' | 'unknown';
  health: 'healthy' | 'degraded' | 'unknown' | 'unreachable';
  detail: string;
  observed: boolean;
  observedAt: string;
}

/**
 * Runtime container view. The backend has no Docker socket, so it reports the
 * declared Compose service catalog and fills in LIVE health for the services it
 * can actually reach (PostgreSQL, the engine adapter, Kamex SQLBox). Services it
 * cannot probe from the API are marked observed:false with health 'unknown' —
 * honest rather than a fabricated "healthy".
 */
@Injectable()
export class RuntimeContainersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly engines: EngineAdapterRegistry,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  async list(): Promise<{
    items: RuntimeContainer[];
    total: number;
    observedAt: string;
    source: 'declared-catalogue';
    limit: string;
  }> {
    const now = new Date().toISOString();
    const base = (
      overrides: Partial<RuntimeContainer> &
        Pick<RuntimeContainer, 'name' | 'service' | 'image' | 'network'>,
    ): RuntimeContainer => ({
      id: overrides.service,
      status: 'unknown',
      health: 'unknown',
      detail: 'Declared Compose service; health not probed from the API.',
      observed: false,
      observedAt: now,
      ...overrides,
    });

    const [postgres, engine, sqlboxHealth] = await Promise.all([
      this.probePostgres(),
      this.probeEngine(),
      this.probeSqlbox(),
    ]);

    const containers: RuntimeContainer[] = [
      base({
        name: 'jkannel-postgres',
        service: 'postgres',
        image: 'postgres:17-alpine',
        network: 'database',
        ...postgres,
      }),
      base({
        name: 'jkannel-backend',
        service: 'backend',
        image: 'jkannel-backend',
        network: 'application',
        status: 'running',
        health: 'healthy',
        detail: 'This API process is responding.',
        observed: true,
      }),
      base({
        name: 'jkannel-kamex-bearerbox',
        service: 'kamex-bearerbox',
        image: 'ghcr.io/vaska94/kamex:1.8.3',
        network: 'engine',
        ...engine,
      }),
      base({
        name: 'jkannel-kamex-sqlbox',
        service: 'kamex-sqlbox',
        image: 'jkannel-kamex-sqlbox',
        network: 'engine',
        ...sqlboxHealth,
      }),
      base({
        name: 'jkannel-redis',
        service: 'redis',
        image: 'redis:7-alpine',
        network: 'application',
      }),
      base({
        name: 'jkannel-frontend',
        service: 'frontend',
        image: 'jkannel-frontend',
        network: 'application',
      }),
      base({
        name: 'jkannel-kamex-smsbox',
        service: 'kamex-smsbox',
        image: 'ghcr.io/vaska94/kamex:1.8.3',
        network: 'engine',
      }),
      base({
        name: 'jkannel-kamex-validator',
        service: 'kamex-validator',
        image: 'jkannel-kamex-validator',
        network: 'engine',
      }),
      base({
        name: 'jkannel-prometheus',
        service: 'prometheus',
        image: 'prom/prometheus:v2.55.1',
        network: 'monitoring',
        detail: 'Declared under the "monitoring" Compose profile.',
      }),
      base({
        name: 'jkannel-grafana',
        service: 'grafana',
        image: 'grafana/grafana:11.4.0',
        network: 'monitoring',
        detail: 'Declared under the "monitoring" Compose profile.',
      }),
      // ---------------------------------------------------------------------
      // The seven services this catalogue used to omit.
      //
      // A hardcoded list that is a SUBSET of docker-compose.yml is worse than
      // no list: an operator reads ten rows, concludes that is the estate, and
      // never asks why the backup service is not there. If this file drifts
      // from Compose again, that is the failure to look for.
      // ---------------------------------------------------------------------
      base({
        name: 'jkannel-reverse-proxy',
        service: 'reverse-proxy',
        image: 'nginx',
        network: 'edge',
        detail: 'Declared Compose service; terminates HTTP for the console and API.',
      }),
      base({
        name: 'jkannel-reverse-proxy-tls',
        service: 'reverse-proxy-tls',
        image: 'nginx',
        network: 'edge',
        detail: 'Declared under the TLS Compose profile; not running on a plain-HTTP deployment.',
      }),
      base({
        name: 'jkannel-scheduler',
        service: 'scheduler',
        image: 'jkannel-backend',
        network: 'application',
        detail: 'Declared Compose service; runs the job worker outside the API process.',
      }),
      base({
        name: 'jkannel-backup-service',
        service: 'backup-service',
        image: 'jkannel-backend',
        network: 'database',
        detail: 'Declared Compose service; performs scheduled backups.',
      }),
      base({
        name: 'jkannel-watchdog',
        service: 'watchdog',
        image: 'docker',
        network: 'application',
        detail:
          'Declared Compose service. Holds the Docker socket read-only — this backend does not, which is why nothing here is live-probed.',
      }),
      base({
        name: 'jkannel-loki',
        service: 'loki',
        image: 'grafana/loki',
        network: 'monitoring',
        detail: 'Declared under the "monitoring" Compose profile.',
      }),
      base({
        name: 'jkannel-promtail',
        service: 'promtail',
        image: 'grafana/promtail',
        network: 'monitoring',
        detail: 'Declared under the "monitoring" Compose profile; ships container logs to Loki.',
      }),
    ];

    return {
      items: containers,
      total: containers.length,
      observedAt: now,
      // Stated in the payload, not just in a comment: this is a catalogue with
      // three probes bolted on, and a caller must be able to tell that apart
      // from an enumeration of what is actually running.
      source: 'declared-catalogue',
      limit:
        'This list is the Compose service catalogue as declared in code, not an enumeration of running containers. ' +
        'The backend has no Docker socket, so only postgres, the engine and sqlbox are live-probed; everything else ' +
        'is reported as declared. A service missing here means this list is stale, not that the service is absent.',
    };
  }

  private async probePostgres(): Promise<Partial<RuntimeContainer>> {
    try {
      const started = Date.now();
      const result = await this.database.query<{ v: string }>('SELECT version() v');
      return {
        status: 'running',
        health: 'healthy',
        observed: true,
        detail: `${result.rows[0].v.split(' ').slice(0, 2).join(' ')} · ${Date.now() - started}ms`,
      };
    } catch (error) {
      return {
        status: 'degraded',
        health: 'unreachable',
        observed: true,
        detail: `PostgreSQL probe failed: ${(error as Error).message}`,
      };
    }
  }

  private async probeEngine(): Promise<Partial<RuntimeContainer>> {
    try {
      const adapter = this.engines.forImplementation(process.env.ENGINE_IMPLEMENTATION ?? 'kamex');
      const [identity, health] = await Promise.all([adapter.identify(), adapter.health()]);
      const reachable = health.transport === 'reachable';
      return {
        status: reachable ? 'running' : 'degraded',
        health: health.engine === 'healthy' ? 'healthy' : reachable ? 'degraded' : 'unreachable',
        observed: true,
        detail: `${identity.family} ${identity.version} · transport ${health.transport} · engine ${health.engine}`,
      };
    } catch (error) {
      return {
        status: 'unknown',
        health: 'unreachable',
        observed: true,
        detail: `Engine probe failed: ${(error as Error).message}`,
      };
    }
  }

  private async probeSqlbox(): Promise<Partial<RuntimeContainer>> {
    const probe = await this.sqlbox.probe();
    return probe.available
      ? { status: 'running', health: 'healthy', observed: true, detail: probe.evidence }
      : { status: 'degraded', health: 'unreachable', observed: true, detail: probe.evidence };
  }
}
