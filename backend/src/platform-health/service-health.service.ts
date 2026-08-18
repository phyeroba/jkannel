import { Injectable, Optional } from '@nestjs/common';
import { HealthService } from '../health/health.service';
import { EngineAdapterRegistry } from '../engine/engine-adapter.registry';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { DatabaseService } from '../database/database.service';
import { TelemetryFreshnessService } from '../platform/telemetry-freshness.service';
import {
  SERVICE_CATALOGUE,
  attributeRootCause,
  dependentsOf,
  summarise,
  type ServiceReading,
  type ServiceState,
} from './service-registry';

/**
 * Probes every component in the register and assembles the board (§14).
 *
 * Two probes here did not exist before and were the reason two of the five
 * §14 components could never be reported: smsbox and the metrics collector.
 * Both are reachable from this container on the Compose networks — `appnet`
 * and `obsnet` respectively — so the gap was code, not topology.
 */
/**
 * Spool ages that mean something.
 *
 * A healthy spool drains in well under a second, so these are generous rather
 * than tight: 60s allows for a genuinely busy bind or a brief carrier stall
 * without crying wolf, and 300s is far past any explanation other than "nobody
 * is draining this".
 */
const SLOW_SPOOL_SECONDS = 60;
const STALLED_SPOOL_SECONDS = 300;

@Injectable()
export class ServiceHealthService {
  constructor(
    private readonly health: HealthService,
    private readonly database: DatabaseService,
    @Optional() private readonly engines?: EngineAdapterRegistry,
    @Optional() private readonly sqlbox?: KamexSqlboxRepository,
    @Optional() private readonly telemetry?: TelemetryFreshnessService,
  ) {}

  async board() {
    const observedAt = new Date().toISOString();
    // Probed concurrently: a serial sweep would take as long as the sum of the
    // timeouts, and the whole board would be as slow as its slowest component
    // exactly when something is timing out and the operator needs it most.
    const [engine, dependencies, spool, poller, jobs, collector, smsbox] = await Promise.all([
      this.probeEngine(),
      this.probeDependencies(),
      this.probeSpool(),
      this.probePoller(),
      this.probeJobWorker(),
      this.probeCollector(),
      this.probeSmsbox(),
    ]);

    const raw: Record<string, { state: ServiceState; observation: ServiceReading['observation']; detail: string }> = {
      bearerbox: engine,
      smsbox,
      sqlbox: spool,
      database: dependencies.database,
      cache: dependencies.cache,
      'engine-poller': poller,
      'job-worker': jobs,
      'metrics-collector': collector,
    };

    const states = new Map<string, ServiceState>(
      Object.entries(raw).map(([name, value]) => [name, value.state]),
    );

    const services: ServiceReading[] = SERVICE_CATALOGUE.map((entry) => {
      const reading = raw[entry.name] ?? {
        state: 'unknown' as ServiceState,
        observation: 'unobserved' as const,
        detail: 'No probe is defined for this component.',
      };
      return {
        name: entry.name,
        role: entry.role,
        state: reading.state,
        observation: reading.observation,
        detail: reading.detail,
        dependsOn: entry.dependsOn,
        affects: dependentsOf(entry.name),
        rootCause: attributeRootCause(reading.state, entry.dependsOn, states),
        observedAt: reading.observation === 'unobserved' ? null : observedAt,
      };
    });

    return { services, summary: summarise(services), observedAt };
  }

  async service(name: string) {
    const board = await this.board();
    const found = board.services.find((entry) => entry.name === name);
    if (!found) return null;
    return {
      ...found,
      dependencies: board.services.filter((entry) => found.dependsOn.includes(entry.name)),
      dependents: board.services.filter((entry) => found.affects.includes(entry.name)),
      observedAt: board.observedAt,
    };
  }

  // --- probes ---------------------------------------------------------------

  /** bearerbox, via the unauthenticated `/health` the adapter already uses. */
  private async probeEngine() {
    if (!this.engines)
      return unobserved('No engine adapter is registered in this deployment.');
    try {
      const health = await this.engines
        .forImplementation(process.env.ENGINE_IMPLEMENTATION ?? 'kamex')
        .health();
      const engine = String((health as any)?.engine ?? 'unknown');
      const transport = String((health as any)?.transport ?? 'unknown');
      if (transport !== 'ok')
        return probed(
          'critical',
          `The engine admin port did not answer (transport: ${transport}). No message can be submitted while this is true.`,
        );
      if (engine === 'healthy') return probed('healthy', 'The engine answered its health probe.');
      if (engine === 'degraded')
        return probed(
          'degraded',
          'The engine is running but reported itself degraded — typically no carrier bind is up.',
        );
      return probed('critical', `The engine reported ${engine}.`);
    } catch (error) {
      return probed('critical', `The engine could not be reached: ${(error as Error).message}`);
    }
  }

  /**
   * smsbox — a NEW probe.
   *
   * A bare GET of the sendsms port. Kannel answers a request with no parameters
   * with an error page, and an error page is a perfectly good liveness signal:
   * the question is whether the HTTP listener is up, not whether the request was
   * valid. A connection refused is what a dead smsbox looks like.
   *
   * Deliberately not a submission. Probing by sending a message would put real
   * traffic through the gateway every poll and cost money.
   */
  private async probeSmsbox() {
    const base = process.env.KAMEX_SENDSMS_URL ?? process.env.SMSBOX_BASE_URL;
    if (!base)
      return unobserved(
        'Not probed: set KAMEX_SENDSMS_URL (for example http://kamex-smsbox:13013) to have this component watched.',
      );
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
      // Any HTTP status means the listener is alive. Only a transport failure
      // says otherwise, so a 4xx here is healthy and saying so avoids a false
      // alarm every time the probe hits an empty request.
      return probed(
        'healthy',
        `The sendsms HTTP listener answered (HTTP ${response.status}). This proves the listener is up; it does not prove a submission would route.`,
      );
    } catch (error) {
      return probed(
        'critical',
        `The sendsms HTTP listener did not answer: ${(error as Error).message}. HTTP submissions are failing.`,
      );
    }
  }

  /** PostgreSQL and Redis, from the existing dependency check. */
  private async probeDependencies() {
    try {
      const result = await this.health.check();
      const find = (name: string) =>
        (result.dependencies ?? []).find((entry: any) => entry.name === name);
      return { database: fromDependency(find('postgres'), 'database'), cache: fromDependency(find('redis'), 'cache') };
    } catch (error) {
      const detail = `The dependency check itself failed: ${(error as Error).message}`;
      return { database: probed('critical', detail), cache: probed('unknown', detail) };
    }
  }

  /**
   * sqlbox, by reading its tables.
   *
   * Stronger than the container's own healthcheck, which is `kill -0 1` and so
   * passes for a wedged daemon — but still not proof of draining, and the
   * detail says so rather than letting the row read as a guarantee.
   */
  private async probeSpool() {
    if (!this.sqlbox) return unobserved('The SQLBox repository is not wired in this deployment.');
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      return probed(
        'critical',
        `The message store is not readable: ${probe.evidence}. Message history and the spool are unavailable.`,
      );

    // THE WEDGE CHECK.
    //
    // Table readability alone is not enough, and the gap was real: sqlbox's own
    // container healthcheck is `kill -0 1` — does PID 1 exist — so a daemon
    // that has stopped draining `send_sms` reports healthy to Docker, and the
    // table probe above would have reported healthy here too. That is exactly
    // what happened on the VPS when bearerbox was recreated: sqlbox never
    // reconnected, sending stopped, and every metric in the system read green.
    //
    // The oldest un-drained row IS the signal. A working spool empties in under
    // a second; a row sitting there for minutes means nobody is picking it up.
    try {
      const summary = await this.sqlbox.queueSummary();
      if (!summary.queued)
        return probed(
          'healthy',
          'The spool is empty and the history tables are readable — nothing is waiting to be drained.',
        );
      const ageSeconds = summary.oldestEpoch
        ? Math.max(0, Math.round(Date.now() / 1000 - summary.oldestEpoch))
        : 0;
      if (ageSeconds > STALLED_SPOOL_SECONDS)
        return probed(
          'critical',
          `${summary.queued} message(s) are spooled and the oldest has waited ${Math.round(ageSeconds / 60)} minutes. ` +
            'A working spool drains in under a second, so this means sqlbox is not injecting into bearerbox — ' +
            'typically because it lost its connection and did not reconnect. Restarting sqlbox is the usual fix.',
        );
      if (ageSeconds > SLOW_SPOOL_SECONDS)
        return probed(
          'degraded',
          `${summary.queued} message(s) are spooled and the oldest has waited ${ageSeconds}s. ` +
            'The spool is draining more slowly than usual — check bind health before assuming sqlbox is at fault.',
        );
      return probed(
        'healthy',
        `${summary.queued} message(s) spooled, oldest ${ageSeconds}s — draining normally.`,
      );
    } catch (error) {
      // The tables read but the summary did not. Report what is actually known
      // rather than upgrading a partial answer to a clean bill of health.
      return probed(
        'degraded',
        `The spool tables are readable but the queue could not be measured: ${(error as Error).message}. ` +
          'A stalled spool would not be detected while this is true.',
      );
    }
  }

  /** JKANNEL's own engine-snapshot poller, from the freshness service. */
  private async probePoller() {
    if (!this.telemetry) return unobserved('Telemetry freshness is not wired in this deployment.');
    try {
      const state = this.telemetry.current();
      const detail = String((state as any).detail ?? '');
      switch ((state as any).state) {
        case 'live':
          return probed('healthy', detail);
        case 'delayed':
          return probed('degraded', detail);
        case 'disconnected':
          return probed('critical', detail);
        default:
          return { state: 'unknown' as ServiceState, observation: 'derived' as const, detail };
      }
    } catch (error) {
      return probed('unknown', `Telemetry freshness could not be read: ${(error as Error).message}`);
    }
  }

  /**
   * The job worker — a NEW surface.
   *
   * The worker computes a cycle summary every pass and throws it away, so
   * nothing could report "the queue is backing up" or "jobs are dying". This
   * asks the table instead, which survives a worker restart and is therefore
   * the better source anyway.
   *
   * Health is judged on OVERDUE work, not on depth. A thousand jobs scheduled
   * for tomorrow is not a problem; ten that were due an hour ago is.
   */
  private async probeJobWorker() {
    try {
      // Same claim timeout the worker's reaper uses, so "stuck" here means
      // exactly what it means there rather than a second, drifting definition.
      const claimTimeout = Math.round(Number(process.env.JOB_CLAIM_TIMEOUT_MS ?? 600_000) / 1000);
      const { rows } = await this.database.query<{
        overdue: string;
        dead: string;
        running: string;
        stuck: string;
        oldest_overdue_seconds: string | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= now())        AS overdue,
           count(*) FILTER (WHERE status = 'dead_letter')                                  AS dead,
           count(*) FILTER (WHERE status = 'running')                                      AS running,
           count(*) FILTER (WHERE status = 'running'
                              AND coalesce(heartbeat_at, claimed_at)
                                  < now() - ($1 || ' seconds')::interval)                  AS stuck,
           EXTRACT(EPOCH FROM (now() - min(next_attempt_at)
             FILTER (WHERE status = 'pending' AND next_attempt_at <= now())))::text        AS oldest_overdue_seconds
         FROM api_jobs`,
        [String(Number.isFinite(claimTimeout) && claimTimeout > 0 ? claimTimeout : 600)],
      );
      const overdue = Number(rows[0]?.overdue ?? 0);
      const dead = Number(rows[0]?.dead ?? 0);
      const running = Number(rows[0]?.running ?? 0);
      const stuck = Number(rows[0]?.stuck ?? 0);
      const age = Math.round(Number(rows[0]?.oldest_overdue_seconds ?? 0));

      // Reported BEFORE the overdue checks, because a stuck job is a worker
      // that died mid-execution and it is the more specific finding. Counted
      // inside `running` it looks like healthy work in progress, which is how a
      // wedged queue stays invisible.
      if (stuck > 0)
        return probed(
          'degraded',
          `${stuck} job(s) are claimed by a worker whose heartbeat has gone stale — a worker died mid-execution. ` +
            'They will be reclaimed by the reaper, but repeated occurrences mean workers are crashing.',
        );

      if (overdue > 0 && age > 900)
        return probed(
          'critical',
          `${overdue} job(s) overdue, the oldest by ${Math.round(age / 60)} minutes. The worker is not draining — scheduled sends and MO fan-out are not running.`,
        );
      if (overdue > 0 && age > 120)
        return probed(
          'degraded',
          `${overdue} job(s) overdue, the oldest by ${Math.round(age / 60)} minute(s). The worker is behind.`,
        );
      if (dead > 0)
        return probed(
          'degraded',
          `${dead} job(s) dead-lettered. They will not retry on their own and need a decision.`,
        );
      return probed(
        'healthy',
        `Nothing overdue${running ? `, ${running} running` : ''}. Dead-lettered: ${dead}.`,
      );
    } catch (error) {
      return probed('unknown', `The job table could not be read: ${(error as Error).message}`);
    }
  }

  /** Prometheus — a NEW probe, against its own readiness endpoint. */
  private async probeCollector() {
    const base = process.env.PROMETHEUS_BASE_URL;
    if (!base)
      return unobserved(
        'Not probed: set PROMETHEUS_BASE_URL (for example http://prometheus:9090) to have this component watched. Prometheus runs under the optional "monitoring" Compose profile and may not be deployed.',
      );
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/-/healthy`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok
        ? probed('healthy', 'Prometheus reported itself healthy.')
        : probed('degraded', `Prometheus answered HTTP ${response.status}.`);
    } catch (error) {
      return probed(
        'critical',
        `Prometheus did not answer: ${(error as Error).message}. Dashboards and any alert rule it evaluates are blind, though message traffic is unaffected.`,
      );
    }
  }
}

const probed = (state: ServiceState, detail: string) =>
  ({ state, observation: 'probed' as const, detail });

const unobserved = (detail: string) =>
  ({ state: 'unknown' as ServiceState, observation: 'unobserved' as const, detail });

function fromDependency(entry: any, label: string) {
  if (!entry) return unobserved(`The health check did not report on ${label}.`);
  if (entry.status === 'ok')
    return probed('healthy', entry.detail ? String(entry.detail) : `${label} answered in ${entry.durationMs}ms.`);
  if (entry.status === 'skipped')
    return unobserved(`Not checked: ${entry.detail ?? 'the dependency is not configured.'}`);
  // A non-required dependency failing is a degradation, not an outage — losing
  // the cache costs sessions and rate limiting, not message delivery.
  return probed(entry.required ? 'critical' : 'degraded', String(entry.detail ?? `${label} is not answering.`));
}
