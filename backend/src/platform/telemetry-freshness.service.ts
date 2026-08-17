import { Injectable } from '@nestjs/common';
import { KamexAdapter } from '../engine/kamex.adapter';
import { EngineSnapshotCache } from '../monitoring-depth/engine-snapshot.cache';

/**
 * Is what the console is showing current?
 *
 * Spec §2.1 asks for a "connection/live-data indicator showing whether telemetry
 * is current, delayed or disconnected", and §17 makes staleness a first-class UI
 * state rather than an error. Every ingredient already existed — the engine
 * snapshot's `source.status`, its `observedAt`, and the request gate's record of
 * whether we have stopped asking — but nothing combined them, so each screen was
 * left to infer freshness from a timestamp on its own and none of them did.
 *
 * The distinction that matters, and the reason this is not just "age of the last
 * snapshot": **stale data and suppressed polling look identical from a
 * timestamp.** If the request gate has tripped because our credential is being
 * rejected, the newest snapshot simply stops advancing, exactly as it would if
 * the engine had died. Those have different causes and different fixes, so this
 * reports which one it is.
 */
export type FreshnessState = 'live' | 'delayed' | 'disconnected' | 'unknown';

export interface TelemetryFreshness {
  state: FreshnessState;
  /** Seconds since the last SUCCESSFUL observation, or null if there has never been one. */
  ageSeconds: number | null;
  observedAt: string | null;
  /** A sentence an operator can act on. Never just a state word. */
  detail: string;
  /** True when JKANNEL has deliberately stopped polling; see KamexRequestGate. */
  pollingSuppressed: boolean;
  /** Set when the failure is attributable — currently 'credentials' or 'unreachable'. */
  cause: string | null;
  /** The age at which `live` becomes `delayed`, so the console can show the budget. */
  delayedAfterSeconds: number;
}

/**
 * Two poll intervals plus a margin. The poller runs at 30s by default, so a
 * single missed cycle is normal jitter and must not paint the console yellow;
 * two consecutive misses is a real signal.
 */
const DELAYED_AFTER_SECONDS = Number(process.env.TELEMETRY_DELAYED_AFTER_SECONDS ?? 75);
const DISCONNECTED_AFTER_SECONDS = Number(process.env.TELEMETRY_DISCONNECTED_AFTER_SECONDS ?? 300);

@Injectable()
export class TelemetryFreshnessService {
  constructor(
    private readonly adapter: KamexAdapter,
    private readonly cache: EngineSnapshotCache,
  ) {}

  current(now = Date.now()): TelemetryFreshness {
    const gate = this.adapter.gateState?.() ?? {
      suppressed: false,
      kind: 'unknown' as const,
      consecutiveFailures: 0,
      detail: null,
    };
    const snapshot = this.cache.get()?.snapshot ?? null;
    const observedAt = snapshot?.observedAt ?? null;
    const ageSeconds = observedAt
      ? Math.max(0, Math.round((now - Date.parse(observedAt)) / 1000))
      : null;

    // Suppression is reported ahead of age, because it is the more actionable
    // fact: the number stopped moving because we stopped asking, and no amount
    // of waiting will change it.
    if (gate.suppressed) {
      const credential = gate.kind === 'credentials';
      return {
        state: 'disconnected',
        ageSeconds,
        observedAt,
        pollingSuppressed: true,
        cause: gate.kind === 'unknown' ? null : gate.kind,
        delayedAfterSeconds: DELAYED_AFTER_SECONDS,
        detail: credential
          ? 'Telemetry is not being collected: the engine is reachable but rejecting our ' +
            'credential, and polling has been throttled because repeated failed ' +
            'authentications degrade its admin port. Check KAMEX_STATUS_PASSWORD.'
          : 'Telemetry is not being collected: repeated failures polling the engine, so ' +
            'requests have been backed off. Figures below are the last successful reading.',
      };
    }

    if (ageSeconds === null)
      return {
        state: 'unknown',
        ageSeconds: null,
        observedAt: null,
        pollingSuppressed: false,
        cause: null,
        delayedAfterSeconds: DELAYED_AFTER_SECONDS,
        detail: 'No engine observation has been recorded yet in this process.',
      };

    if (snapshot?.source?.status === 'unavailable')
      return {
        state: 'disconnected',
        ageSeconds,
        observedAt,
        pollingSuppressed: false,
        cause: 'unreachable',
        delayedAfterSeconds: DELAYED_AFTER_SECONDS,
        detail: `The last poll could not read the engine (${
          snapshot.source.detail ?? 'no detail'
        }). Figures are from ${ageSeconds}s ago.`,
      };

    if (ageSeconds >= DISCONNECTED_AFTER_SECONDS)
      return {
        state: 'disconnected',
        ageSeconds,
        observedAt,
        pollingSuppressed: false,
        cause: null,
        delayedAfterSeconds: DELAYED_AFTER_SECONDS,
        detail: `No successful engine observation for ${ageSeconds}s. Treat every figure on this screen as historical.`,
      };

    if (ageSeconds >= DELAYED_AFTER_SECONDS)
      return {
        state: 'delayed',
        ageSeconds,
        observedAt,
        pollingSuppressed: false,
        cause: null,
        delayedAfterSeconds: DELAYED_AFTER_SECONDS,
        detail: `Last engine observation was ${ageSeconds}s ago; more than one poll interval has been missed.`,
      };

    return {
      state: 'live',
      ageSeconds,
      observedAt,
      pollingSuppressed: false,
      cause: null,
      delayedAfterSeconds: DELAYED_AFTER_SECONDS,
      detail: `Engine observed ${ageSeconds}s ago.`,
    };
  }
}
