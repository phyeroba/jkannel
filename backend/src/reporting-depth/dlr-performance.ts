/**
 * Delivery-receipt quality (spec §8).
 *
 * THE MATURITY PROBLEM IS THE REASON THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * §8's UI requirement: *"Make DLR maturity/window warnings prominent to avoid
 * false incident conclusions."*
 *
 * A delivery receipt arrives some time after the message is submitted —
 * typically seconds, sometimes minutes, occasionally not at all. So a window
 * that includes the last few minutes ALWAYS contains messages whose receipts
 * have not landed yet. Compute a delivery rate over it and the answer is
 * mechanically too low, and it gets lower the fresher the window.
 *
 * An operator watching that number fall in real time reads a carrier outage.
 * There is no outage: they are watching messages age into their own receipts.
 * This is the single easiest way to declare a false incident from a real
 * dashboard, and the reason the funnel below reports `pending` as its own
 * outcome rather than folding it into failure.
 */

export type DlrOutcome = 'delivered' | 'failed' | 'rejected' | 'expired' | 'pending' | 'unknown';

export interface DeliveryFunnel {
  /** Messages JKANNEL handed to the engine in the window. */
  submitted: number;
  /** Of those, how many the engine accepted. */
  accepted: number;
  /** Of those, how many have produced any delivery receipt at all. */
  receiptsReceived: number;
  delivered: number;
  failed: number;
  expired: number;
  rejected: number;
  /** Accepted, but no receipt yet. NOT a failure. */
  pending: number;
  unknown: number;
}

export interface MaturityAssessment {
  /** True when the window is too recent for its receipts to have settled. */
  immature: boolean;
  /** Share of accepted messages still awaiting a receipt, 0..1. */
  pendingShare: number;
  /** How much of the window falls inside the settling period, 0..1. */
  windowOverlapShare: number;
  /** A sentence to put in front of the operator. Null when mature. */
  warning: string | null;
}

export interface DeliveryQuality {
  funnel: DeliveryFunnel;
  /**
   * delivered / (delivered + failed + expired + rejected).
   *
   * Pending is EXCLUDED from the denominator on purpose. Including it makes a
   * fresh window look like a delivery collapse, which is precisely the false
   * conclusion §8 warns about.
   */
  deliveryRate: number | null;
  /** delivered / accepted — the same figure with pending counted as failure. */
  deliveryRateIncludingPending: number | null;
  /** Accepted messages with no receipt at all, as a share. */
  noReceiptRate: number | null;
  /**
   * Round-trip receipt latency in SECONDS, over delivered receipts only.
   *
   * Null when nothing was delivered in the window — a percentile over an empty
   * set is not zero, and rendering 0s would claim instant delivery for a bind
   * that delivered nothing at all.
   *
   * Failures and rejections are excluded from the ordering: a carrier that
   * rejects instantly would otherwise pull the percentile down and make a bad
   * bind look fast.
   */
  latency: { p50: number | null; p95: number | null; p99: number | null };
  maturity: MaturityAssessment;
}

/**
 * How long after submission a receipt is still plausibly in flight.
 *
 * Fifteen minutes is generous. Most carriers return a receipt within seconds,
 * but a handset that is off or out of coverage delays it for as long as the
 * validity period allows, and being generous here only ever makes the warning
 * appear more often — the failure mode we are guarding against is the warning
 * being ABSENT when it was needed.
 */
export const RECEIPT_SETTLING_SECONDS = 15 * 60;

/**
 * Is this window's delivery rate safe to draw a conclusion from?
 *
 * Two independent signals, because either alone gives false readings. Window
 * overlap alone would warn on a 24-hour window where the last 15 minutes are
 * a rounding error. Pending share alone would stay silent on a window that is
 * entirely inside the settling period but happens to have few messages.
 */
export function assessMaturity(input: {
  windowEndMs: number;
  windowStartMs: number;
  nowMs: number;
  accepted: number;
  pending: number;
}): MaturityAssessment {
  const { windowStartMs, windowEndMs, nowMs, accepted, pending } = input;
  const pendingShare = accepted > 0 ? pending / accepted : 0;

  // How much of the window lies within the settling period before now.
  const settlingStart = nowMs - RECEIPT_SETTLING_SECONDS * 1000;
  const overlapMs = Math.max(
    0,
    Math.min(windowEndMs, nowMs) - Math.max(windowStartMs, settlingStart),
  );
  const windowMs = Math.max(1, windowEndMs - windowStartMs);
  const windowOverlapShare = Math.min(1, overlapMs / windowMs);

  // A tenth of the window unsettled, or a fifth of messages still pending, is
  // enough to make the rate misleading.
  const immature = windowOverlapShare > 0.1 || pendingShare > 0.2;
  if (!immature) return { immature, pendingShare, windowOverlapShare, warning: null };

  const minutes = Math.round(RECEIPT_SETTLING_SECONDS / 60);
  const parts: string[] = [];
  if (windowOverlapShare > 0.1)
    parts.push(
      `${Math.round(windowOverlapShare * 100)}% of this window is inside the last ${minutes} minutes`,
    );
  if (pendingShare > 0.2)
    parts.push(`${Math.round(pendingShare * 100)}% of accepted messages have no receipt yet`);

  return {
    immature,
    pendingShare,
    windowOverlapShare,
    warning:
      `${parts.join(' and ')}. Receipts arrive after submission, so the delivery rate for a ` +
      'window this recent is mechanically low and will rise on its own. Do not read it as a ' +
      'delivery failure — compare against a settled window before concluding anything.',
  };
}

export function buildDeliveryQuality(input: {
  funnel: DeliveryFunnel;
  windowStartMs: number;
  windowEndMs: number;
  nowMs?: number;
  /**
   * Receipt-latency percentiles in seconds, when the caller measured them.
   * Omitted by callers that aggregate a funnel without the underlying rows —
   * percentiles cannot be summed, so an aggregate of several binds has no
   * meaningful latency and says so rather than averaging averages.
   */
  latency?: { p50: number | null; p95: number | null; p99: number | null };
}): DeliveryQuality {
  const { funnel } = input;
  const settled = funnel.delivered + funnel.failed + funnel.expired + funnel.rejected;
  return {
    funnel,
    deliveryRate: settled > 0 ? funnel.delivered / settled : null,
    deliveryRateIncludingPending: funnel.accepted > 0 ? funnel.delivered / funnel.accepted : null,
    noReceiptRate: funnel.accepted > 0 ? funnel.pending / funnel.accepted : null,
    latency: input.latency ?? { p50: null, p95: null, p99: null },
    maturity: assessMaturity({
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      nowMs: input.nowMs ?? Date.now(),
      accepted: funnel.accepted,
      pending: funnel.pending,
    }),
  };
}
