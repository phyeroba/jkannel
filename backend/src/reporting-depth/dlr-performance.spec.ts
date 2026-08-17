import {
  assessMaturity,
  buildDeliveryQuality,
  RECEIPT_SETTLING_SECONDS,
  type DeliveryFunnel,
} from './dlr-performance';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

const funnel = (overrides: Partial<DeliveryFunnel> = {}): DeliveryFunnel => ({
  submitted: 1000,
  accepted: 1000,
  receiptsReceived: 1000,
  delivered: 950,
  failed: 40,
  expired: 5,
  rejected: 5,
  pending: 0,
  unknown: 0,
  ...overrides,
});

/**
 * §8: "Make DLR maturity/window warnings prominent to avoid false incident
 * conclusions."
 *
 * A receipt arrives after its message, so any window touching the present
 * contains messages whose receipts have not landed. The rate over it is
 * mechanically low and falls the fresher the window gets — an operator
 * watching it in real time sees a carrier outage that is not happening.
 */
describe('assessMaturity', () => {
  it('warns when the window sits inside the settling period', () => {
    const result = assessMaturity({
      windowStartMs: minutesAgo(10),
      windowEndMs: NOW,
      nowMs: NOW,
      accepted: 100,
      pending: 5,
    });
    expect(result.immature).toBe(true);
    expect(result.warning).toMatch(/mechanically low/);
    expect(result.warning).toMatch(/will rise on its own/);
  });

  it('does not warn on a settled historical window', () => {
    // Yesterday: every receipt that was coming has arrived.
    const result = assessMaturity({
      windowStartMs: minutesAgo(2880),
      windowEndMs: minutesAgo(1440),
      nowMs: NOW,
      accepted: 5000,
      pending: 0,
    });
    expect(result.immature).toBe(false);
    expect(result.warning).toBeNull();
  });

  /**
   * Window overlap alone is not enough. A 24-hour window whose last quarter
   * hour is unsettled is fine — the unsettled part is a rounding error — so a
   * check on overlap alone would cry wolf on every long window.
   */
  it('tolerates a long window with only its tail unsettled', () => {
    const result = assessMaturity({
      windowStartMs: minutesAgo(1440),
      windowEndMs: NOW,
      nowMs: NOW,
      accepted: 10000,
      pending: 30,
    });
    expect(result.immature).toBe(false);
  });

  /**
   * And pending share alone is not enough either: a window entirely inside the
   * settling period with few messages could show low pending by chance. The two
   * signals cover each other's blind spot.
   */
  it('warns on a high pending share even when the window looks long enough', () => {
    const result = assessMaturity({
      windowStartMs: minutesAgo(600),
      windowEndMs: minutesAgo(120),
      nowMs: NOW,
      accepted: 1000,
      pending: 400,
    });
    expect(result.immature).toBe(true);
    expect(result.warning).toMatch(/40% of accepted messages have no receipt yet/);
  });

  it('reports both reasons when both apply', () => {
    const result = assessMaturity({
      windowStartMs: minutesAgo(5),
      windowEndMs: NOW,
      nowMs: NOW,
      accepted: 100,
      pending: 60,
    });
    expect(result.warning).toMatch(/and/);
    expect(result.warning).toMatch(/inside the last 15 minutes/);
  });

  it('does not divide by zero on an empty window', () => {
    const result = assessMaturity({
      windowStartMs: minutesAgo(60),
      windowEndMs: NOW,
      nowMs: NOW,
      accepted: 0,
      pending: 0,
    });
    expect(Number.isFinite(result.pendingShare)).toBe(true);
    expect(result.pendingShare).toBe(0);
  });

  it('uses a generous settling period, because a missing warning is the bad failure', () => {
    expect(RECEIPT_SETTLING_SECONDS).toBeGreaterThanOrEqual(10 * 60);
  });
});

describe('buildDeliveryQuality', () => {
  const settledWindow = {
    windowStartMs: minutesAgo(2880),
    windowEndMs: minutesAgo(1440),
    nowMs: NOW,
  };

  it('excludes pending from the delivery rate denominator', () => {
    // 950 delivered of 1000 settled = 95%, even though 500 more are in flight.
    // Counting those as failures would show 63% and read as a collapse.
    const quality = buildDeliveryQuality({
      funnel: funnel({ accepted: 1500, pending: 500 }),
      ...settledWindow,
    });
    expect(quality.deliveryRate).toBeCloseTo(0.95);
    expect(quality.deliveryRateIncludingPending).toBeCloseTo(950 / 1500);
  });

  it('publishes both rates so the difference is visible rather than hidden', () => {
    const quality = buildDeliveryQuality({
      funnel: funnel({ accepted: 1200, pending: 200 }),
      ...settledWindow,
    });
    expect(quality.deliveryRate).not.toBeCloseTo(quality.deliveryRateIncludingPending!);
  });

  it('reports the no-receipt rate as its own figure', () => {
    const quality = buildDeliveryQuality({
      funnel: funnel({ accepted: 1000, pending: 250 }),
      ...settledWindow,
    });
    expect(quality.noReceiptRate).toBeCloseTo(0.25);
  });

  it('returns null rates, not zero, when nothing settled', () => {
    // 0% delivery and "no data yet" are different claims.
    const quality = buildDeliveryQuality({
      funnel: funnel({
        submitted: 10,
        accepted: 10,
        receiptsReceived: 0,
        delivered: 0,
        failed: 0,
        expired: 0,
        rejected: 0,
        pending: 10,
      }),
      ...settledWindow,
    });
    expect(quality.deliveryRate).toBeNull();
  });

  it('attaches the maturity warning to a fresh window', () => {
    const quality = buildDeliveryQuality({
      funnel: funnel({ accepted: 100, pending: 40 }),
      windowStartMs: minutesAgo(5),
      windowEndMs: NOW,
      nowMs: NOW,
    });
    expect(quality.maturity.immature).toBe(true);
    expect(quality.maturity.warning).toBeTruthy();
  });
});
