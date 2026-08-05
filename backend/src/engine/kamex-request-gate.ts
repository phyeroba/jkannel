/**
 * A shared circuit breaker in front of every authenticated Kamex admin-port
 * request.
 *
 * WHY THIS EXISTS — the engine's failure mode is to get slower
 * ---------------------------------------------------------------------------
 * Kamex's `httpd_check_authorization` keeps a PROCESS-GLOBAL sleep counter. It
 * adds one second on every failed authentication and sleeps for the running
 * total before answering — on the single thread that serves `/health`,
 * `/status`, `/shutdown` and `/graceful-restart`. It never decays while the
 * process lives, and only a bearerbox restart clears it.
 *
 * JKANNEL drives that port continuously and, before this, unconditionally: the
 * status poller every 30s, an open Live Queue tab every 5s, an Operations
 * Overview tab every 30s, plus the container healthcheck. With a wrong password
 * that is tens of failed authentications per minute against a counter that only
 * climbs, so the admin port becomes unusable within about an hour — taking our
 * own health monitoring AND our configuration-deploy path with it. Retrying
 * harder is precisely the wrong response, which is what an un-gated client does
 * by default.
 *
 * So the loop has to be broken on our side: consecutive failures widen a
 * suppression window, and while it is open no request is issued at all.
 *
 * WHY IT LIVES HERE AND NOT IN THE POLLER
 * ---------------------------------------------------------------------------
 * The poller is only a small share of the traffic; a single open Live Queue tab
 * out-requests it six to one. A gate inside the adapter covers every caller —
 * poller, console, copilot, deploy — with one rule.
 *
 * WHY IT DOES NOT NEED TO RECOGNISE AN AUTH FAILURE TO WORK
 * ---------------------------------------------------------------------------
 * It gates on consecutive failures of ANY kind. That is deliberate: backing off
 * is also the right behaviour when the engine is genuinely down, and by the
 * third failed auth Kamex's own sleep already exceeds our request timeout, so
 * no response — and therefore no status code — comes back to classify anyway.
 *
 * It can still often TELL, and says so, because the two are fixed very
 * differently. `/health` needs no password while `/status.json` does, so
 * "health answers, status does not" is a differential diagnosis for a
 * credential problem. See {@link classifyOutage}.
 */

/** Consecutive failures tolerated before any suppression begins. */
const DEFAULT_FAILURE_THRESHOLD = 3;
/** First suppression window, doubling per failure after the threshold. */
const DEFAULT_BASE_MS = 5_000;
/**
 * Ceiling on the suppression window.
 *
 * Bounded rather than unbounded because bind availability is derived from the
 * data this polling produces: an indefinitely open gate would freeze that view
 * with no path back. Five minutes keeps recovery prompt while cutting the
 * request rate by roughly two orders of magnitude.
 */
const DEFAULT_MAX_MS = 300_000;

export type OutageKind = 'unreachable' | 'credentials' | 'unknown';

export interface GateDecision {
  /** False means: do not issue the request; use {@link GateDecision.detail}. */
  allowed: boolean;
  detail?: string;
}

export interface GateOptions {
  threshold?: number;
  baseMs?: number;
  maxMs?: number;
  /** Injectable clock. Tests must not depend on wall time. */
  now?: () => number;
}

/**
 * Distinguishes "the engine is unreachable" from "our credential is rejected".
 *
 * `/health` carries no password and `/status.json` does, so the pair separates
 * the two causes even though neither response alone can. This matters because
 * the operator-facing consequence is completely different: one is an engine
 * outage, the other is a configuration mistake in JKANNEL that is actively
 * damaging the engine, and reporting the second as "SMS engine unreachable" —
 * which is what happened before — sends someone to debug the wrong system.
 *
 * `unknown` is returned rather than guessed when health was not observed.
 */
export function classifyOutage(healthReachable: boolean | null): OutageKind {
  if (healthReachable === null) return 'unknown';
  return healthReachable ? 'credentials' : 'unreachable';
}

export class KamexRequestGate {
  private consecutiveFailures = 0;
  private suppressedUntil = 0;
  private lastDetail: string | null = null;
  private lastKind: OutageKind = 'unknown';
  private readonly threshold: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor(options: GateOptions = {}) {
    this.threshold = Math.max(1, options.threshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.baseMs = Math.max(1, options.baseMs ?? DEFAULT_BASE_MS);
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? DEFAULT_MAX_MS);
    // `() => Date.now()`, not the bare `Date.now` reference: capturing the
    // function pins the implementation at construction time, which silently
    // defeats any later clock substitution in a test.
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Whether to issue a request now.
   *
   * When the window has expired this returns `allowed` WITHOUT resetting the
   * counter: exactly one probe is let through, and only its success resets. A
   * reset here would restore full request volume on the strength of a request
   * that had not happened yet, re-opening the loop this class exists to close.
   */
  check(): GateDecision {
    if (this.consecutiveFailures < this.threshold) return { allowed: true };
    const remaining = this.suppressedUntil - this.now();
    if (remaining <= 0) return { allowed: true };
    return {
      allowed: false,
      detail:
        `Kamex requests suppressed after ${this.consecutiveFailures} consecutive failures ` +
        `(retrying in ${Math.ceil(remaining / 1000)}s). ` +
        `Last error: ${this.lastDetail ?? 'unknown'}`,
    };
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.suppressedUntil = 0;
    this.lastDetail = null;
    this.lastKind = 'unknown';
  }

  recordFailure(detail: string, kind: OutageKind = 'unknown'): void {
    this.consecutiveFailures += 1;
    this.lastDetail = detail;
    this.lastKind = kind;
    if (this.consecutiveFailures < this.threshold) return;
    // Exponent counts failures PAST the threshold, so the first suppression is
    // baseMs rather than baseMs already doubled several times.
    const exponent = Math.min(this.consecutiveFailures - this.threshold, 20);
    this.suppressedUntil = this.now() + Math.min(this.baseMs * 2 ** exponent, this.maxMs);
  }

  /** Snapshot for health reporting and alerting. Does not mutate state. */
  state(): {
    consecutiveFailures: number;
    suppressed: boolean;
    suppressedForMs: number;
    kind: OutageKind;
    detail: string | null;
  } {
    const remaining = Math.max(0, this.suppressedUntil - this.now());
    return {
      consecutiveFailures: this.consecutiveFailures,
      suppressed: this.consecutiveFailures >= this.threshold && remaining > 0,
      suppressedForMs: remaining,
      kind: this.lastKind,
      detail: this.lastDetail,
    };
  }
}
