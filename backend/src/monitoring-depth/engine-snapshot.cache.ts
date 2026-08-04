import { Injectable } from '@nestjs/common';
import { EngineQueueSnapshot } from '../engine/kamex.adapter';

export interface CachedEngineSnapshot {
  snapshot: EngineQueueSnapshot;
  /** Wall clock at which the poll completed, used to age the /metrics output. */
  cachedAt: Date;
}

/**
 * Single-slot cache holding the most recent engine queue snapshot.
 *
 * The Prometheus scrape must never call the engine synchronously: a wedged
 * bearerbox would then stall (and eventually fail) every scrape, which is
 * exactly when metrics matter most. {@link SmscStatusPoller} writes here on its
 * own schedule and {@link EngineMetricsService} only ever reads, exporting the
 * snapshot's age alongside it so a stale cache is visible in Prometheus rather
 * than being silently presented as current.
 */
@Injectable()
export class EngineSnapshotCache {
  private current: CachedEngineSnapshot | null = null;

  set(snapshot: EngineQueueSnapshot, cachedAt: Date = new Date()): void {
    this.current = { snapshot, cachedAt };
  }

  /** The last snapshot, or null when the poller has not yet produced one. */
  get(): CachedEngineSnapshot | null {
    return this.current;
  }

  /** Seconds since the cached snapshot was taken, or null when there is none. */
  ageSeconds(now: Date = new Date()): number | null {
    if (!this.current) return null;
    return Math.max(0, (now.getTime() - this.current.cachedAt.getTime()) / 1000);
  }
}
