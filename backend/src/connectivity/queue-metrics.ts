/**
 * Queue rates derived from the bind snapshots the poller already stores
 * (spec §7).
 *
 * `/queues` previously answered two questions — depth and oldest age — because
 * that is all `queueSummary` computed: `count(*)` and `min(time)`. §7 asks for
 * ingress, egress, growth rate and a drain estimate, none of which the engine
 * reports directly. They are all recoverable from `smsc_bind_snapshots`, which
 * records `queued` (a depth) and `sent` (a cumulative counter) every poll.
 *
 * THE COUNTER RESET IS THE WHOLE DIFFICULTY
 * ---------------------------------------------------------------------------
 * `sent` is bearerbox's own lifetime counter and it goes back to zero whenever
 * bearerbox restarts. A naive `latest.sent - earliest.sent` therefore produces
 * a large NEGATIVE egress across any restart, which then yields a negative
 * drain estimate — a screen confidently reporting that a queue will empty in
 * the past. Intervals where the counter went backwards are dropped rather than
 * clamped: a restart means we genuinely do not know how many messages left
 * during that window, and inventing zero would understate throughput.
 */

export interface QueueSample {
  /** Messages waiting at this observation. */
  queued: number;
  /** bearerbox's cumulative sent counter. Resets on engine restart. */
  sent: number;
  observedAt: string | Date;
}

export interface QueueRates {
  depth: number | null;
  /** Messages per second entering the queue. */
  ingressPerSecond: number | null;
  /** Messages per second leaving it. */
  egressPerSecond: number | null;
  /** ingress − egress. Positive means the queue is growing. */
  growthPerSecond: number | null;
  /**
   * Seconds until empty at the current egress, or null.
   *
   * §7: "Calculated from recent stable egress; mark unreliable if rate is
   * volatile/zero", and UC-QUE-01: "If egress is zero, drain time is displayed
   * as unavailable rather than infinity."
   */
  drainSeconds: number | null;
  /** Why there is no drain estimate. Null when there is one. */
  drainUnavailableReason: string | null;
  /** Observation window the rates were measured over. */
  windowSeconds: number | null;
  samples: number;
  /** Intervals discarded because the engine's counter had reset. */
  resetsDetected: number;
}

/**
 * Relative standard deviation above which egress is called volatile.
 *
 * 0.6 is deliberately permissive. Real gateway throughput is bursty and a
 * stricter threshold would suppress the estimate almost always, which helps
 * nobody; this is meant to catch "the rate is meaningless", not "the rate
 * moved".
 */
const VOLATILITY_LIMIT = 0.6;

const EMPTY: QueueRates = {
  depth: null,
  ingressPerSecond: null,
  egressPerSecond: null,
  growthPerSecond: null,
  drainSeconds: null,
  drainUnavailableReason: 'No observations in the window.',
  windowSeconds: null,
  samples: 0,
  resetsDetected: 0,
};

export function deriveQueueRates(samples: QueueSample[]): QueueRates {
  const ordered = [...samples]
    .map((sample) => ({ ...sample, at: new Date(sample.observedAt).getTime() }))
    .filter((sample) => Number.isFinite(sample.at))
    .sort((a, b) => a.at - b.at);

  if (!ordered.length) return EMPTY;
  const depth = ordered[ordered.length - 1].queued;
  if (ordered.length < 2)
    return {
      ...EMPTY,
      depth,
      samples: ordered.length,
      drainUnavailableReason:
        'Only one observation so far; a rate needs at least two to measure against.',
    };

  // Per-interval egress, skipping any interval where the counter went
  // backwards (an engine restart) or no time passed.
  const perInterval: number[] = [];
  let resetsDetected = 0;
  let totalSent = 0;
  let totalSeconds = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const seconds = (current.at - previous.at) / 1000;
    if (seconds <= 0) continue;
    const delta = current.sent - previous.sent;
    if (delta < 0) {
      resetsDetected += 1;
      continue;
    }
    perInterval.push(delta / seconds);
    totalSent += delta;
    totalSeconds += seconds;
  }

  const windowSeconds = (ordered[ordered.length - 1].at - ordered[0].at) / 1000;
  if (!perInterval.length)
    return {
      ...EMPTY,
      depth,
      samples: ordered.length,
      windowSeconds,
      resetsDetected,
      drainUnavailableReason: resetsDetected
        ? 'The engine restarted during this window, so throughput could not be measured.'
        : 'No usable interval between observations.',
    };

  const egressPerSecond = totalSent / totalSeconds;
  // Depth change over the SAME window the egress was measured on. Ingress is
  // inferred rather than observed: nothing counts arrivals directly, but
  // depth(t2) − depth(t1) = ingress − egress, so ingress falls out.
  const depthChange = ordered[ordered.length - 1].queued - ordered[0].queued;
  const growthPerSecond = windowSeconds > 0 ? depthChange / windowSeconds : 0;
  const ingressPerSecond = Math.max(0, growthPerSecond + egressPerSecond);

  return {
    depth,
    ingressPerSecond,
    egressPerSecond,
    growthPerSecond,
    ...drainEstimate(depth, egressPerSecond, perInterval, resetsDetected),
    windowSeconds,
    samples: ordered.length,
    resetsDetected,
  };
}

function drainEstimate(
  depth: number,
  egressPerSecond: number,
  perInterval: number[],
  resetsDetected: number,
): { drainSeconds: number | null; drainUnavailableReason: string | null } {
  if (depth <= 0) return { drainSeconds: 0, drainUnavailableReason: null };
  if (egressPerSecond <= 0)
    return {
      drainSeconds: null,
      // Infinity is the mathematically correct answer and a useless one to put
      // on a screen; §7 asks for this case by name.
      drainUnavailableReason:
        'Nothing is leaving this queue, so it will not drain at the current rate.',
    };
  if (resetsDetected)
    return {
      drainSeconds: null,
      drainUnavailableReason:
        'The engine restarted during this window, so the measured rate is not a reliable basis for an estimate.',
    };
  if (isVolatile(perInterval))
    return {
      drainSeconds: null,
      drainUnavailableReason:
        'Throughput is varying too much across this window for a drain estimate to mean anything.',
    };
  return { drainSeconds: depth / egressPerSecond, drainUnavailableReason: null };
}

/** Relative standard deviation of the per-interval rates. */
function isVolatile(rates: number[]): boolean {
  if (rates.length < 3) return false;
  const mean = rates.reduce((total, rate) => total + rate, 0) / rates.length;
  if (mean <= 0) return true;
  const variance = rates.reduce((total, rate) => total + (rate - mean) ** 2, 0) / rates.length;
  return Math.sqrt(variance) / mean > VOLATILITY_LIMIT;
}
