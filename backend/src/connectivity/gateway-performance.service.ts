import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

/** One bucket of the throughput series. */
export interface ThroughputPoint {
  /** Bucket start, ISO 8601. */
  at: string;
  /** Mean gateway-wide outbound messages per second across the bucket. */
  outbound: number;
  inbound: number;
  /** Highest single poll in the bucket — a mean hides the spike that mattered. */
  peakOutbound: number;
  /** Polls that landed in this bucket. A bucket of one is not an average. */
  samples: number;
}

/**
 * The estate's configured ceiling.
 *
 * `effectiveTps` is null, never zero, when no SMSC in the estate declares a
 * throughput. Zero would read as "this gateway can send nothing", which is the
 * opposite of the truth — an undeclared ceiling means Kannel imposes none.
 */
export interface GatewayCeiling {
  effectiveTps: number | null;
  /** Connections whose ceiling is known and therefore counted. */
  contributingSmscs: number;
  /**
   * Enabled connections with no `tps` configured. The headroom figure is a
   * lower bound while this is non-zero, and the console must say so.
   */
  smscsWithoutCeiling: number;
  /** Sum of `connection_count`, because Kannel enforces throughput per bind. */
  connections: number;
}

export interface ThroughputSeries {
  points: ThroughputPoint[];
  bucketSeconds: number;
  windowMinutes: number;
  ceiling: GatewayCeiling;
  /** Highest single observed poll in the whole window. Null if nothing polled. */
  peakOutbound: number | null;
  /** Most recent poll's gateway-wide outbound rate. Null if nothing polled. */
  latestOutbound: number | null;
  sampling: {
    /** MEASURED spacing between polls, not the configured interval. */
    intervalSeconds: number | null;
    lastObservedAt: string | null;
    ageSeconds: number | null;
    polls: number;
  };
  limits: { unavailable: string[]; reason: string };
}

/**
 * What this screen cannot show, stated in the payload rather than left as a
 * blank panel.
 *
 * Submit latency is the one operators ask for most and it is the one Kannel
 * will not give us: `/status.json` reports counters and rate averages, never a
 * per-message timing, and bearerbox's own submit path is not instrumented. The
 * carrier-side figure that IS measurable — submit to delivery receipt — is
 * already on DLR Performance, and presenting it here would let a slow carrier
 * read as a slow gateway.
 */
const LIMITS = {
  unavailable: [
    'submit latency (API accept to engine handoff)',
    'internal queue wait (engine ingress to submit attempt)',
  ],
  reason:
    "Kannel's status interface reports counters and rate averages, never per-message timings, so no gateway-side latency can be measured from it. Carrier response latency is measured, from the delivery-receipt correlation, and is on the DLR Performance screen.",
};

/** Bucket widths offered, coarsest-first fallback. All divide an hour evenly. */
const BUCKET_LADDER = [60, 120, 300, 600, 1800, 3600];

/** Target number of points on the chart; the bucket width is chosen to hit it. */
const TARGET_POINTS = 48;

const MIN_WINDOW_MINUTES = 5;
const MAX_WINDOW_MINUTES = 60 * 24 * 7;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Gateway-wide throughput against configured capacity (§14, §18).
 *
 * Every figure here comes from `smsc_bind_snapshots`, which the status poller
 * has been writing one row per bind per cycle since it was built. Nothing new
 * is collected; this reads what was already there.
 *
 * The per-poll sum is computed BEFORE bucketing. Averaging each bind's rate
 * separately and adding the averages would answer a different question — it
 * would smooth away the moment when two binds peaked together, which is exactly
 * the moment a capacity screen exists to show.
 */
@Injectable()
export class GatewayPerformanceService {
  constructor(private readonly database: DatabaseService) {}

  /** Clamps the requested window and picks a bucket width that fits the chart. */
  static resolveWindow(minutes: unknown): { windowMinutes: number; bucketSeconds: number } {
    const requested = Number(minutes);
    const windowMinutes = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), MIN_WINDOW_MINUTES), MAX_WINDOW_MINUTES)
      : 360;
    const ideal = (windowMinutes * 60) / TARGET_POINTS;
    const bucketSeconds = BUCKET_LADDER.find((width) => width >= ideal) ?? BUCKET_LADDER.at(-1)!;
    return { windowMinutes, bucketSeconds };
  }

  async throughput(actor: Actor, minutes: unknown): Promise<ThroughputSeries> {
    const { windowMinutes, bucketSeconds } = GatewayPerformanceService.resolveWindow(minutes);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const since = new Date(Date.now() - windowMinutes * 60_000);
      const [points, sampling, ceiling] = await Promise.all([
        this.series(client, since, bucketSeconds),
        this.sampling(client, since),
        this.ceiling(client),
      ]);
      const peakOutbound = points.length
        ? Math.max(...points.map((point) => point.peakOutbound))
        : null;
      return {
        points,
        bucketSeconds,
        windowMinutes,
        ceiling,
        peakOutbound,
        latestOutbound: sampling.latestOutbound,
        sampling: {
          intervalSeconds: sampling.intervalSeconds,
          lastObservedAt: sampling.lastObservedAt,
          ageSeconds: sampling.ageSeconds,
          polls: sampling.polls,
        },
        limits: LIMITS,
      };
    });
  }

  /**
   * The bucketed series.
   *
   * `per_poll` groups on `observed_at` because the poller stamps every bind in
   * a cycle with one timestamp — so a group IS a poll, and its sum is the whole
   * gateway at that instant. RLS restricts `smsc_bind_snapshots` to the calling
   * tenant, so no tenant predicate is spelled out here; adding one would imply
   * the policy could not be relied on, which would be the more dangerous claim.
   */
  private async series(
    client: PoolClient,
    since: Date,
    bucketSeconds: number,
  ): Promise<ThroughputPoint[]> {
    const result = await client.query(
      `WITH per_poll AS (
         SELECT observed_at,
                SUM(outbound_rate) AS outbound,
                SUM(inbound_rate)  AS inbound
           FROM smsc_bind_snapshots
          WHERE observed_at >= $1
          GROUP BY observed_at
       )
       SELECT to_timestamp(floor(extract(epoch FROM observed_at) / $2) * $2) AS bucket_at,
              AVG(outbound) AS outbound_avg,
              MAX(outbound) AS outbound_peak,
              AVG(inbound)  AS inbound_avg,
              count(*)::int AS samples
         FROM per_poll
        GROUP BY 1
        ORDER BY 1`,
      [since, bucketSeconds],
    );
    return result.rows.map((row) => ({
      at: new Date(String(row.bucket_at)).toISOString(),
      outbound: Number(toNumber(row.outbound_avg) ?? 0),
      inbound: Number(toNumber(row.inbound_avg) ?? 0),
      peakOutbound: Number(toNumber(row.outbound_peak) ?? 0),
      samples: Number(row.samples ?? 0),
    }));
  }

  /**
   * How often we are actually managing to poll, measured rather than configured.
   *
   * `SMSC_POLLER_INTERVAL_MS` says what was asked for. The median gap between
   * consecutive polls says what happened, and the two differ precisely when
   * something is wrong — a wedged engine, a cycle overrunning its interval. The
   * measured figure is the one worth showing on a screen about performance.
   */
  private async sampling(client: PoolClient, since: Date) {
    const result = await client.query(
      `WITH per_poll AS (
         SELECT observed_at, SUM(outbound_rate) AS outbound
           FROM smsc_bind_snapshots
          WHERE observed_at >= $1
          GROUP BY observed_at
       ), gaps AS (
         SELECT extract(epoch FROM observed_at - lag(observed_at) OVER (ORDER BY observed_at)) AS gap
           FROM per_poll
       )
       SELECT (SELECT count(*)::int FROM per_poll) AS polls,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)
                 FROM gaps WHERE gap IS NOT NULL) AS median_gap,
              (SELECT max(observed_at) FROM per_poll) AS last_at,
              (SELECT outbound FROM per_poll ORDER BY observed_at DESC LIMIT 1) AS latest_outbound`,
      [since],
    );
    const row = result.rows[0] ?? {};
    const lastAt = row.last_at ? new Date(String(row.last_at)) : null;
    const median = toNumber(row.median_gap);
    return {
      polls: Number(row.polls ?? 0),
      // Rounded to the second: sub-second precision on a poll interval is noise
      // from scheduler jitter, and printing "29.87s" invites the wrong question.
      intervalSeconds: median === null ? null : Math.round(median),
      lastObservedAt: lastAt ? lastAt.toISOString() : null,
      ageSeconds: lastAt ? Math.max(0, Math.round((Date.now() - lastAt.getTime()) / 1000)) : null,
      latestOutbound: toNumber(row.latest_outbound),
    };
  }

  /**
   * The declared ceiling, and how much of the estate declares one.
   *
   * Kannel enforces `throughput` PER BIND, so a connection running
   * `instances = 3` at 10/s can pass 30/s. Multiplying by `connection_count`
   * here is not padding the number — it is what the engine will actually allow,
   * and the un-multiplied figure would have an operator believing they were at
   * three times the utilisation they are.
   *
   * Disabled connections are excluded: their capacity is not available to
   * carry today's traffic, and counting it would understate utilisation.
   */
  private async ceiling(client: PoolClient): Promise<GatewayCeiling> {
    const result = await client.query(
      `SELECT COALESCE(SUM(tps * GREATEST(COALESCE(connection_count, 1), 1))
                FILTER (WHERE tps IS NOT NULL), 0)::float8 AS effective_tps,
              count(*) FILTER (WHERE tps IS NOT NULL)::int  AS with_ceiling,
              count(*) FILTER (WHERE tps IS NULL)::int      AS without_ceiling,
              COALESCE(SUM(GREATEST(COALESCE(connection_count, 1), 1)), 0)::int AS connections
         FROM smsc_definitions
        WHERE enabled = true`,
    );
    const row = result.rows[0] ?? {};
    const withCeiling = Number(row.with_ceiling ?? 0);
    return {
      // No connection declares a ceiling — that is unknown, not nil capacity.
      effectiveTps: withCeiling ? (toNumber(row.effective_tps) ?? null) : null,
      contributingSmscs: withCeiling,
      smscsWithoutCeiling: Number(row.without_ceiling ?? 0),
      connections: Number(row.connections ?? 0),
    };
  }
}
