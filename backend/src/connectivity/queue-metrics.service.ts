import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { deriveQueueRates, type QueueRates, type QueueSample } from './queue-metrics';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface QueueDestination extends QueueRates {
  engineId: string;
  smscName: string | null;
  carrierId: string | null;
  carrierName: string | null;
  bindState: string | null;
  /** Age of the oldest message still in the SQLBox spool for this bind. */
  oldestSpoolAgeSeconds: number | null;
}

export interface QueueOverview {
  observedAt: string;
  windowMinutes: number;
  destinations: QueueDestination[];
  /**
   * The spool JKANNEL can actually see and act on, as opposed to the engine's
   * internal per-SMSC queue.
   */
  spool: { queued: number; oldestAgeSeconds: number | null; available: boolean; detail: string };
  notes: string[];
}

/** How far back to look when deriving rates. Six polls at the 30s default. */
const DEFAULT_WINDOW_MINUTES = 15;

@Injectable()
export class QueueMetricsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  async overview(actor: Actor, windowMinutes = DEFAULT_WINDOW_MINUTES): Promise<QueueOverview> {
    const window = Math.min(Math.max(windowMinutes, 1), 1440);
    const destinations = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT sn.engine_id, sn.queued, sn.sent, sn.observed_at,
                s.name AS smsc_name, s.carrier_id::text, c.name AS carrier_name, b.state
           FROM smsc_bind_snapshots sn
           LEFT JOIN smsc_definitions s ON s.engine_id = sn.engine_id AND s.deleted_at IS NULL
           LEFT JOIN carriers c ON c.id = s.carrier_id AND c.deleted_at IS NULL
           LEFT JOIN smsc_bind_state b ON b.engine_id = sn.engine_id
          WHERE sn.observed_at >= now() - ($1 || ' minutes')::interval
          ORDER BY sn.engine_id, sn.observed_at`,
        [String(window)],
      );

      const byBind = new Map<string, { meta: Record<string, unknown>; samples: QueueSample[] }>();
      for (const row of rows) {
        const engineId = String(row.engine_id);
        if (!byBind.has(engineId)) byBind.set(engineId, { meta: row, samples: [] });
        byBind.get(engineId)!.samples.push({
          queued: Number(row.queued ?? 0),
          sent: Number(row.sent ?? 0),
          observedAt: String(row.observed_at),
        });
      }

      return [...byBind.entries()].map(([engineId, entry]) => ({
        engineId,
        smscName: (entry.meta.smsc_name as string) ?? null,
        carrierId: (entry.meta.carrier_id as string) ?? null,
        carrierName: (entry.meta.carrier_name as string) ?? null,
        bindState: (entry.meta.state as string) ?? null,
        oldestSpoolAgeSeconds: null,
        ...deriveQueueRates(entry.samples),
      }));
    });

    // The spool is tier one: rows JKANNEL wrote into send_sms that sqlbox has
    // not yet consumed. It is the only queue whose individual messages we can
    // list, reroute or cancel — see the note below.
    const probe = await this.sqlbox.probe();
    let spool = {
      queued: 0,
      oldestAgeSeconds: null as number | null,
      available: false,
      detail: probe.evidence,
    };
    if (probe.available) {
      try {
        const summary = await this.sqlbox.queueSummary();
        const oldestEpoch = Number(summary?.oldestEpoch ?? 0);
        spool = {
          queued: Number(summary?.queued ?? 0),
          oldestAgeSeconds: oldestEpoch > 0 ? Math.floor(Date.now() / 1000 - oldestEpoch) : null,
          available: true,
          detail: 'Read from the SQLBox spool.',
        };
      } catch (error) {
        spool.detail = `SQLBox spool unreadable: ${(error as Error).message}`;
      }
    }

    return {
      observedAt: new Date().toISOString(),
      windowMinutes: window,
      destinations: destinations.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0)),
      spool,
      notes: [
        // Stated on the response rather than left to the UI, so any consumer
        // inherits it. This is the constraint the whole queue screen sits on.
        "Per-destination depth is bearerbox's internal queue for that bind. The engine reports it " +
          'only as a counter — individual messages inside it cannot be listed, reordered or ' +
          'cancelled. The SQLBox spool above is the tier JKANNEL can act on.',
        'Ingress is inferred from the change in depth against measured egress, not observed ' +
          'directly: nothing in the engine counts arrivals.',
      ],
    };
  }
}
