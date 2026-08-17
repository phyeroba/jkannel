import { deriveQueueRates, type QueueSample } from './queue-metrics';

const at = (seconds: number) => new Date(Date.parse('2026-08-06T12:00:00Z') + seconds * 1000);
const sample = (seconds: number, queued: number, sent: number): QueueSample => ({
  queued,
  sent,
  observedAt: at(seconds),
});

describe('deriveQueueRates', () => {
  it('measures egress from the cumulative counter', () => {
    // 300 sent over 60s = 5/s.
    const rates = deriveQueueRates([sample(0, 100, 1000), sample(60, 100, 1300)]);
    expect(rates.egressPerSecond).toBeCloseTo(5);
    expect(rates.depth).toBe(100);
  });

  it('infers ingress from the depth change, since nothing counts arrivals', () => {
    // Depth held steady while 300 left, so 300 must have arrived: 5/s each way.
    const rates = deriveQueueRates([sample(0, 100, 1000), sample(60, 100, 1300)]);
    expect(rates.ingressPerSecond).toBeCloseTo(5);
    expect(rates.growthPerSecond).toBeCloseTo(0);
  });

  it('reports a growing queue as positive growth', () => {
    // 60 left, but depth rose by 120, so 180 arrived.
    const rates = deriveQueueRates([sample(0, 100, 1000), sample(60, 220, 1060)]);
    expect(rates.growthPerSecond).toBeCloseTo(2);
    expect(rates.ingressPerSecond).toBeCloseTo(3);
  });

  /**
   * The trap this module exists for. `sent` is bearerbox's lifetime counter and
   * returns to zero on restart, so a naive last-minus-first produces a large
   * NEGATIVE egress — and then a negative drain estimate, i.e. a screen saying
   * the queue emptied in the past.
   */
  it('discards the interval across an engine restart instead of going negative', () => {
    const rates = deriveQueueRates([
      sample(0, 100, 5000),
      sample(30, 100, 5150), // 5/s
      sample(60, 100, 40), // counter reset
      sample(90, 100, 190), // 5/s again
    ]);
    expect(rates.resetsDetected).toBe(1);
    expect(rates.egressPerSecond).toBeGreaterThan(0);
    expect(rates.egressPerSecond).toBeCloseTo(5);
  });

  it('refuses a drain estimate when the engine restarted in the window', () => {
    // We genuinely do not know how many messages left during the gap.
    const rates = deriveQueueRates([
      sample(0, 500, 5000),
      sample(30, 500, 5150),
      sample(60, 500, 40),
    ]);
    expect(rates.drainSeconds).toBeNull();
    expect(rates.drainUnavailableReason).toMatch(/restarted/);
  });

  it('estimates drain time from depth and a steady egress', () => {
    // 600 waiting, 5/s leaving -> 120s.
    const rates = deriveQueueRates([
      sample(0, 600, 1000),
      sample(30, 600, 1150),
      sample(60, 600, 1300),
    ]);
    expect(rates.drainSeconds).toBeCloseTo(120);
    expect(rates.drainUnavailableReason).toBeNull();
  });

  /**
   * §7 and UC-QUE-01 both call this out: "If egress is zero, drain time is
   * displayed as unavailable rather than infinity."
   */
  it('says a stalled queue will not drain rather than reporting infinity', () => {
    const rates = deriveQueueRates([
      sample(0, 400, 1000),
      sample(30, 400, 1000),
      sample(60, 400, 1000),
    ]);
    expect(rates.egressPerSecond).toBe(0);
    expect(rates.drainSeconds).toBeNull();
    expect(Number.isFinite(rates.drainSeconds as number)).toBe(false);
    expect(rates.drainUnavailableReason).toMatch(/will not drain/);
  });

  it('withholds the estimate when throughput is too erratic to mean anything', () => {
    // §7: "mark unreliable if rate is volatile".
    const rates = deriveQueueRates([
      sample(0, 900, 0),
      sample(30, 900, 300), // 10/s
      sample(60, 900, 303), // 0.1/s
      sample(90, 900, 900), // 20/s
    ]);
    expect(rates.egressPerSecond).toBeGreaterThan(0);
    expect(rates.drainSeconds).toBeNull();
    expect(rates.drainUnavailableReason).toMatch(/varying too much/);
  });

  it('reports an already-empty queue as drained, not as unavailable', () => {
    const rates = deriveQueueRates([sample(0, 0, 1000), sample(60, 0, 1000)]);
    expect(rates.drainSeconds).toBe(0);
    expect(rates.drainUnavailableReason).toBeNull();
  });

  it('never reports negative ingress, which would be meaningless', () => {
    // A queue draining faster than it fills still has ingress >= 0.
    const rates = deriveQueueRates([sample(0, 500, 1000), sample(60, 100, 1400)]);
    expect(rates.ingressPerSecond).toBeGreaterThanOrEqual(0);
    expect(rates.growthPerSecond).toBeLessThan(0);
  });

  it('returns nulls, not zeros, with nothing to measure', () => {
    // A zero rate is a measurement; "we have not measured" is not.
    expect(deriveQueueRates([]).egressPerSecond).toBeNull();
    const single = deriveQueueRates([sample(0, 10, 100)]);
    expect(single.depth).toBe(10);
    expect(single.egressPerSecond).toBeNull();
    expect(single.drainUnavailableReason).toMatch(/at least two/);
  });

  it('ignores samples that share a timestamp rather than dividing by zero', () => {
    const rates = deriveQueueRates([
      sample(0, 100, 1000),
      sample(0, 100, 1200),
      sample(60, 100, 1300),
    ]);
    expect(Number.isFinite(rates.egressPerSecond as number)).toBe(true);
  });

  it('tolerates unordered input', () => {
    const rates = deriveQueueRates([sample(60, 100, 1300), sample(0, 100, 1000)]);
    expect(rates.egressPerSecond).toBeCloseTo(5);
  });
});
