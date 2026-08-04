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

/** A single bearerbox SMSC connection (bind) as reported by /status.json. */
export interface EngineBindSnapshot {
  engineId: string;
  name: string;
  /** `online` when the engine reports online/running, otherwise the engine's own lowercased token. */
  status: string;
  queued: number;
  failed: number;
  sent: number;
  received: number;
  outboundRate: number[];
  inboundRate: number[];
}

/**
 * Engine-wide counters. Every numeric field is nullable because an unreachable
 * or partially parseable engine must not be reported as "zero" — that would be
 * indistinguishable from a genuinely idle engine.
 */
export interface EngineQueueTotals {
  status: string;
  version: string | null;
  uptimeSeconds: number | null;
  smsQueuedOut: number | null;
  smsQueuedIn: number | null;
  dlrQueued: number | null;
  /** bearerbox reports -1 when the store is disabled/unknown; surfaced as null. */
  storeSize: number | null;
}

export interface EngineQueueSnapshot {
  observedAt: string;
  engine: EngineQueueTotals;
  binds: EngineBindSnapshot[];
  source: { status: 'ok' | 'degraded' | 'unavailable'; detail: string };
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const toCount = (value: unknown): number => toNumber(value) ?? 0;
const toRate = (value: unknown): number[] =>
  Array.isArray(value) ? [0, 1, 2].map((index) => toCount(value[index])) : [0, 0, 0];
/** bearerbox reports uptime as {days,hours,minutes,seconds}; older builds use a raw second count. */
const toUptimeSeconds = (value: unknown): number | null => {
  if (value && typeof value === 'object') {
    const uptime = value as Record<string, unknown>;
    return (
      toCount(uptime.days) * 86400 +
      toCount(uptime.hours) * 3600 +
      toCount(uptime.minutes) * 60 +
      toCount(uptime.seconds)
    );
  }
  return toNumber(value);
};
/**
 * Normalises a bind status. Kannel/Kamex emit values such as `online 0d 0h 3m`,
 * `connecting`, `dead` and `re-connecting`; only online/running is collapsed to
 * `online`, everything else is passed through lowercased so the console never
 * silently claims a bind is healthy.
 */
const toBindStatus = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const token = value.trim().toLowerCase().split(/\s+/)[0];
  return token === 'online' || token === 'running' ? 'online' : token;
};
const unknownTotals = (): EngineQueueTotals => ({
  status: 'unknown',
  version: null,
  uptimeSeconds: null,
  smsQueuedOut: null,
  smsQueuedIn: null,
  dlrQueued: null,
  storeSize: null,
});

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
  /**
   * Typed live view of the bearerbox queues, parsed from `/status.json`.
   *
   * Never throws: an unconfigured, unreachable or malformed engine is reported
   * through `source.status` so the queue console can still render the parts it
   * can source from the database. Deliberately separate from
   * {@link coreDiagnostics}, whose raw-string contract other callers depend on.
   *
   * NOTE: this only exposes bearerbox's *aggregate* per-SMSC queue depth. The
   * messages already handed to bearerbox are not individually addressable over
   * the admin interface — only the SQLBox spool (`send_sms`) is.
   */
  async queueSnapshot(): Promise<EngineQueueSnapshot> {
    const observedAt = new Date().toISOString();
    const unavailable = (detail: string): EngineQueueSnapshot => ({
      observedAt,
      engine: unknownTotals(),
      binds: [],
      source: { status: 'unavailable', detail },
    });
    const base = process.env.KAMEX_BASE_URL;
    const password = process.env.KAMEX_STATUS_PASSWORD;
    if (!base || !password)
      return unavailable(
        'Kamex runtime endpoint is not configured (KAMEX_BASE_URL / KAMEX_STATUS_PASSWORD)',
      );
    let body: Record<string, unknown>;
    try {
      const url = new URL('/status.json', base);
      url.searchParams.set('password', password);
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return unavailable(`Kamex status returned HTTP ${response.status}`);
      const parsed = await response.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return unavailable('Kamex status returned a payload that is not a JSON object');
      body = parsed as Record<string, unknown>;
    } catch (error) {
      return unavailable(`Kamex status unavailable: ${(error as Error).message}`);
    }
    const sms = (body.sms ?? {}) as Record<string, any>;
    const dlr = (body.dlr ?? {}) as Record<string, any>;
    const storeSize = toNumber(sms.store_size);
    const engine: EngineQueueTotals = {
      // Engine-level status is passed through verbatim (lowercased). Unlike a
      // bind, "running" is bearerbox's own word for healthy and collapsing it
      // to "online" would invent a state the engine never reported.
      status:
        typeof body.status === 'string' && body.status.trim()
          ? body.status.trim().toLowerCase()
          : 'unknown',
      version: typeof body.version === 'string' && body.version.trim() ? body.version : null,
      uptimeSeconds: toUptimeSeconds(body.uptime),
      smsQueuedOut: toCount(sms.sent?.queued),
      smsQueuedIn: toCount(sms.received?.queued),
      dlrQueued: toCount(dlr.queued),
      // -1 is bearerbox's "store disabled / size unknown" sentinel.
      storeSize: storeSize === null || storeSize < 0 ? null : storeSize,
    };
    if (!Array.isArray(body.smscs))
      return {
        observedAt,
        engine,
        binds: [],
        source: {
          status: 'degraded',
          detail: 'Kamex status did not include an smscs array; bind detail is unavailable',
        },
      };
    const binds = (body.smscs as unknown[])
      .filter((entry): entry is Record<string, any> => !!entry && typeof entry === 'object')
      .map((entry) => {
        const engineId = String(entry.id ?? entry.admin_id ?? '').trim();
        return {
          engineId,
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : engineId,
          status: toBindStatus(entry.status),
          queued: toCount(entry.queued),
          failed: toCount(entry.failed),
          sent: toCount(entry.sms?.sent),
          received: toCount(entry.sms?.received),
          outboundRate: toRate(entry.sms?.outbound_rate),
          inboundRate: toRate(entry.sms?.inbound_rate),
        };
      })
      .filter((bind) => bind.engineId);
    return {
      observedAt,
      engine,
      binds,
      source: { status: 'ok', detail: 'Parsed from Kamex bearerbox /status.json' },
    };
  }
  /** Issues one bearerbox admin command and returns its body. Throws on refusal. */
  private async adminCommand(
    command: 'start-smsc' | 'stop-smsc',
    engineId: string,
    operation: string,
  ): Promise<string> {
    const base = process.env.KAMEX_BASE_URL;
    const password = process.env.KAMEX_ADMIN_PASSWORD;
    if (!base || !password) throw new Error('Kamex administrative endpoint is not configured');
    const url = new URL(`/${command}`, base);
    url.searchParams.set('password', password);
    url.searchParams.set('smsc', engineId);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const detail = await response.text();
    if (!response.ok || /could not|not given|denied/i.test(detail))
      throw new Error(
        `Kamex SMSC ${operation} failed: ${detail.trim() || `HTTP ${response.status}`}`,
      );
    return detail;
  }

  /**
   * Current bind status for one engine id.
   *
   * `observable: false` means bearerbox's /status.json could not be read at all,
   * which is NOT the same as a bind that is down — a bind absent from an
   * otherwise readable status listing is observably not running.
   */
  private async observeBind(
    engineId: string,
  ): Promise<{ observable: boolean; status: string | null }> {
    const snapshot = await this.queueSnapshot();
    if (snapshot.source.status === 'unavailable') return { observable: false, status: null };
    return {
      observable: true,
      status: snapshot.binds.find((bind) => bind.engineId === engineId)?.status ?? null,
    };
  }

  /** Bounded-wait budgets for a reconnect cycle, tunable per deployment. */
  private static timing() {
    const read = (name: string, fallback: number) => {
      const parsed = Number(process.env[name]);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      stopMs: read('KAMEX_RECONNECT_STOP_TIMEOUT_MS', 5000),
      startMs: read('KAMEX_RECONNECT_START_TIMEOUT_MS', 10000),
      pollMs: read('KAMEX_RECONNECT_POLL_MS', 250),
    };
  }

  /**
   * Waits, within a bounded budget, for a bind to reach (or leave) the online
   * state. Gives up immediately when the engine's status cannot be read: polling
   * an unreachable endpoint for ten seconds would only make an already-honest
   * "unverified" answer slower.
   */
  private async awaitBindState(
    engineId: string,
    want: 'online' | 'offline',
    deadlineMs: number,
    pollMs: number,
  ): Promise<{ observable: boolean; status: string | null }> {
    const until = Date.now() + deadlineMs;
    let observed = await this.observeBind(engineId);
    for (;;) {
      if (!observed.observable) return observed;
      const satisfied =
        want === 'online' ? observed.status === 'online' : observed.status !== 'online';
      if (satisfied || Date.now() >= until) return observed;
      await new Promise((resolve) => {
        setTimeout(resolve, pollMs);
      });
      observed = await this.observeBind(engineId);
    }
  }

  /**
   * Enable / disable / reconnect a single bind through bearerbox's admin HTTP
   * interface.
   *
   * RECONNECT ACTUALLY CYCLES THE BIND. It previously issued `start-smsc` — the
   * identical call as `enable` — so "reconnecting" an already-bound SMSC did
   * nothing whatsoever and recorded a success. It now stops the bind, waits for
   * bearerbox to report it is no longer online, then starts it again and waits
   * for it to come back, and it reports the states it actually observed. When
   * `/status.json` is not available the cycle still runs, but the result says
   * the transition could not be verified instead of claiming it happened.
   */
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

    if (operation !== 'reconnect') {
      const detail = await this.adminCommand(
        operation === 'disable' ? 'stop-smsc' : 'start-smsc',
        engineId,
        operation,
      );
      return { operation, engineId, accepted: true, detail, observedAt: new Date().toISOString() };
    }

    const timing = KamexAdapter.timing();
    const before = await this.observeBind(engineId);
    const stopped = await this.adminCommand('stop-smsc', engineId, 'reconnect (stop)');
    const afterStop = await this.awaitBindState(engineId, 'offline', timing.stopMs, timing.pollMs);
    const started = await this.adminCommand('start-smsc', engineId, 'reconnect (start)');
    const afterStart = await this.awaitBindState(engineId, 'online', timing.startMs, timing.pollMs);

    const observable = before.observable && afterStop.observable && afterStart.observable;
    // The drop is the part that distinguishes a reconnect from an enable, so it
    // is the part that has to be seen for the cycle to count as verified.
    const cycled = afterStop.observable && afterStop.status !== 'online';
    const state = (value: { observable: boolean; status: string | null }) =>
      !value.observable ? 'unobservable' : (value.status ?? 'absent');
    const detail = !observable
      ? `Reconnect issued stop-smsc then start-smsc for ${engineId}. ` +
        'bearerbox /status.json is unavailable, so the bind cycle could NOT be verified. ' +
        `stop: ${stopped.trim()}; start: ${started.trim()}`
      : `Reconnect cycled ${engineId}: ${state(before)} -> ${state(afterStop)} -> ${state(afterStart)}. ` +
        (cycled
          ? 'The bind was observed to drop and be re-established.'
          : 'WARNING: the bind was never observed off-line, so the drop could not be confirmed.') +
        ` stop: ${stopped.trim()}; start: ${started.trim()}`;

    return {
      operation,
      engineId,
      // Accepted means the engine took both commands. Whether the cycle was
      // observed is in `detail` and in the states below — never implied.
      accepted: true,
      detail,
      observedAt: new Date().toISOString(),
      states: {
        before: before.status,
        afterStop: afterStop.status,
        afterStart: afterStart.status,
        cycleVerified: observable && cycled,
      },
    };
  }
}
