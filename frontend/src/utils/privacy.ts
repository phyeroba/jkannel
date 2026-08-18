/**
 * The masking / reveal vocabulary shared by every screen that shows subscriber
 * data (PLAN.md Phase 6, spec §10, §18).
 *
 * Three rules live here rather than in each grid:
 *
 * - **The console never decides whether data is masked.** The API masks, and
 *   states in `privacy.masked` that it did. A screen that re-derived masking
 *   client-side could disagree with what it was actually sent, and would then
 *   be telling the operator something false about a privacy control.
 * - **A masked value is never presented as if it were the real one.** The
 *   notice is transported verbatim from the API and rendered whenever
 *   `masked` is true, because an operator quoting `+2567••••••18` into a
 *   carrier ticket is a worse outcome than one who knows to ask.
 * - **The reason is validated here the way the API validates it**, before the
 *   request goes out. A red "Request failed (400)" after the dialog closed
 *   tells an operator nothing, and the reason they typed is gone.
 */

/** Mirrors the `privacy` block every masked read path attaches to its payload. */
export interface PrivacyState {
  masked: boolean;
  /** Rendered verbatim when masked. Null when the caller revealed. */
  notice: string | null;
  /** Why a reveal was refused, when one was asked for. Null otherwise. */
  refusal?: string | null;
  /** The grant a revealed payload was read under, for the audit trail. */
  revealedUnder?: string | null;
}

/** Mirrors `RevealGrant` in backend/src/privacy/pii-reveal.service.ts. */
export interface RevealGrant {
  id: string;
  reason: string;
  scopeMessageRef: string | null;
  grantedAt: string;
  expiresAt: string;
  revealCount: number;
}

/** The API's own bounds, restated so the form can enforce them before sending. */
export const REVEAL_MIN_REASON = 3;
export const REVEAL_DEFAULT_MINUTES = 15;
export const REVEAL_MAX_MINUTES = 60;

/**
 * Whether a payload said anything at all about masking.
 *
 * Read paths that carry no subscriber data attach no `privacy` block, and their
 * screens must not sprout a masking notice. Absence means "not applicable", not
 * "unmasked" — the two look identical if you only test truthiness of `masked`.
 */
export function statesPrivacy(payload: unknown): payload is { privacy: PrivacyState } {
  const privacy = (payload as { privacy?: unknown } | null)?.privacy;
  return Boolean(privacy) && typeof (privacy as PrivacyState).masked === 'boolean';
}

export function privacyOf(payload: unknown): PrivacyState | null {
  return statesPrivacy(payload) ? payload.privacy : null;
}

/** The API's rule: at least three characters after trimming. */
export function reasonIsUsable(reason: string): boolean {
  return reason.trim().length >= REVEAL_MIN_REASON;
}

export function describeReasonProblem(reason: string): string | null {
  return reasonIsUsable(reason)
    ? null
    : `A reason of at least ${REVEAL_MIN_REASON} characters is required. It is recorded against every row you then read.`;
}

/** Clamps to the window the API will actually honour, so the form cannot lie. */
export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return REVEAL_DEFAULT_MINUTES;
  return Math.min(Math.max(Math.floor(minutes), 1), REVEAL_MAX_MINUTES);
}

/**
 * Milliseconds left on a grant, floored at zero.
 *
 * `now` is injected rather than read from the clock so a countdown can be
 * tested without waiting for real time to pass.
 */
export function remainingMs(grant: RevealGrant | null, now: number): number {
  if (!grant) return 0;
  const expires = Date.parse(grant.expiresAt);
  if (Number.isNaN(expires)) return 0;
  return Math.max(0, expires - now);
}

export function grantIsLive(grant: RevealGrant | null, now: number): boolean {
  return remainingMs(grant, now) > 0;
}

/**
 * "14m 30s left", or "expired".
 *
 * Seconds are shown throughout rather than only under a minute: the whole point
 * of the window is that it is short, and "14m left" hides the fact that it is
 * actively counting down.
 */
export function describeRemaining(grant: RevealGrant | null, now: number): string {
  const ms = remainingMs(grant, now);
  if (ms <= 0) return 'expired';
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
}

/**
 * What the reveal control should say, given the state it is in.
 *
 * Kept as data rather than as template branches so the four states are visible
 * in one place and none of them can quietly go missing.
 */
export function revealStatus(
  privacy: PrivacyState | null,
  grant: RevealGrant | null,
  permitted: boolean,
  now: number,
): { state: 'not-applicable' | 'unmasked' | 'no-permission' | 'maskable'; detail: string } {
  if (!privacy) return { state: 'not-applicable', detail: '' };
  if (!privacy.masked)
    return {
      state: 'unmasked',
      detail: grantIsLive(grant, now)
        ? `Showing real values — ${describeRemaining(grant, now)}. Every row read is audited.`
        : 'Showing real values. Every row read is audited.',
    };
  if (!permitted)
    return {
      state: 'no-permission',
      detail: 'Revealing subscriber data requires the messages.reveal permission.',
    };
  return { state: 'maskable', detail: privacy.notice ?? '' };
}
