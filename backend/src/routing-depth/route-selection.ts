/**
 * Pure route selection.
 *
 * Given a destination MSISDN and a set of candidate routes, decide which SMSC a
 * message should be submitted through, and explain why. This module is
 * deliberately free of NestJS, database and I/O concerns: it is a deterministic
 * function of its inputs so it can be exhaustively unit tested and reused by the
 * live router, the `resolve`/preview endpoint and the frontend simulator alike.
 *
 * Two decisions are made, in order:
 *   1. MATCHING  — which routes apply to this destination (by route_type), after
 *      excluding disabled routes and routes outside their active time window.
 *   2. SELECTION — among the matching routes, a single "controlling" route is
 *      chosen (longest/most-specific match first, then lowest priority number),
 *      and that route's STRATEGY decides which of the available SMSCs to use,
 *      falling back to a secondary SMSC when the primary is unavailable.
 *
 * Availability is an input (`availableSmscIds`): when provided, only those SMSC
 * ids are considered reachable, which is what makes "fall back when the primary
 * is down" and "least-cost among available" testable without a live engine.
 */

import { digitsOnly } from './msisdn';
import { matchesWildcard } from './wildcard';
import type { RouteAction, RouteRuleEffect } from './route-overrides';

export type RouteType =
  | 'static'
  | 'prefix'
  | 'country'
  | 'operator'
  | 'weighted'
  // SMS Studio wildcard grammar against the destination: * # $ |
  | 'wildcard';

export type SelectionStrategy =
  'priority' | 'least-cost' | 'load-balance' | 'round-robin' | 'time-based';

/** One weighted destination SMSC of a `weighted` route. */
export interface RouteTarget {
  smscId: string;
  weight: number;
  cost?: number | null;
  enabled?: boolean;
}

/** Local time-of-day window a `time-based` route is active within. */
export interface TimeWindow {
  /** Inclusive start, "HH:MM" (24h). */
  start: string;
  /** Exclusive end, "HH:MM" (24h). A window whose end <= start wraps midnight. */
  end: string;
  /** Weekdays the window applies to (0=Sunday..6=Saturday). Empty/undefined = every day. */
  days?: number[];
}

/**
 * A candidate route as seen by the selector. Mirrors a routing_rules row (plus
 * its route_targets) but uses camelCase and only the fields selection needs.
 */
export interface CandidateRoute {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  routeType: RouteType;
  strategy: SelectionStrategy;
  /** Prefix matched by a `prefix` route (longest match wins). */
  matchPrefix?: string | null;
  /** Country calling code matched by a `country` route, digits only, no '+'. */
  countryCode?: string | null;
  /** Operator id/name matched by an `operator` route against the context operator. */
  operator?: string | null;
  /** Legacy destination prefix from routing_rules; used by `static` routes. */
  destinationPrefix?: string | null;
  /**
   * Optional sender-id constraint, matched as a wildcard pattern.
   *
   * A value with no metacharacter is an anchored exact match, which is what
   * every rule written before the grammar existed already meant — so this is
   * an addition, not a change. `URA*` and `URASMS|URAOTP` now work too.
   */
  sender?: string | null;
  /** Per-route cost used by least-cost when the route has no per-target cost. */
  cost?: number | null;
  /** Primary SMSC (routing_rules.target_smsc_id). */
  targetSmscId: string;
  /** Secondary SMSC used when the primary is unavailable (routing_rules.fallback_smsc_id). */
  fallbackSmscId?: string | null;
  /** Weighted fan-out targets (route_targets); only meaningful for `weighted` routes. */
  targets?: RouteTarget[];
  /** Active window for a `time-based` route. */
  window?: TimeWindow | null;

  // --- migration 052: what the rule DOES once it has matched ----------------
  // Carried on the candidate rather than fetched separately, so the send path
  // reads the effect from the same row it read the match from and the two can
  // never disagree.
  /** `route` (default) or `drop`. */
  action?: RouteAction;
  overrideSender?: string | null;
  overrideRecipient?: string | null;
  overrideText?: string | null;
  dropReason?: string | null;
}

export interface SelectionContext {
  /** Destination address; a leading '+' and spaces are ignored. */
  msisdn: string;
  /** Message sender id, matched against a route's `sender` constraint when present. */
  sender?: string | null;
  /** Operator resolved for the destination, matched by `operator` routes. */
  operator?: string | null;
  /** Evaluation instant for time-based windows (defaults to now()). */
  now?: Date;
  /**
   * SMSC ids currently reachable. When provided, any SMSC not in the list is
   * treated as unavailable (drives fallback and least-cost-among-available).
   * When omitted/null every referenced SMSC is assumed available.
   */
  availableSmscIds?: string[] | null;
  /**
   * Monotonic counter used to make load-balance / round-robin deterministic and
   * testable (e.g. a per-tenant message sequence). Defaults to 0.
   */
  rotation?: number;
}

export interface SelectionResult {
  /** The chosen SMSC id, or null when nothing matched / nothing was available. */
  smscId: string | null;
  /** The controlling route, or null when no route matched. */
  routeId: string | null;
  routeName: string | null;
  strategy: SelectionStrategy | null;
  /** True when the secondary (fallback) SMSC was chosen because the primary was down. */
  fallbackUsed: boolean;
  /** Short human-readable summary of the decision. */
  reason: string;
  /** Ordered trace of the decision steps, for the preview endpoint. */
  trace: string[];
  /**
   * What the controlling rule DOES once it has matched (migration 052): drop,
   * or rewrite the sender / recipient / body.
   *
   * Carried on the selection result rather than fetched by the caller, so the
   * effect always comes from the same route the selector actually chose. A
   * second lookup could resolve a different rule under concurrent edits and
   * apply an override that nothing selected.
   *
   * Null when no route matched at all.
   */
  effect?: RouteRuleEffect | null;
}

/**
 * Digits-only view of an address (drops '+', spaces, dashes). Delegates to the
 * shared normaliser in ./msisdn so route prefixes and destinations are compared
 * on exactly the same footing everywhere in the platform.
 */
const normalizeMsisdn = digitsOnly;

/** "HH:MM" -> minutes since midnight, or null when malformed. */
function minutesOfDay(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time?.trim() ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Whether `now` falls inside a route's active window (handles midnight wrap). */
export function isWithinWindow(window: TimeWindow | null | undefined, now: Date): boolean {
  if (!window || !window.start || !window.end) return true;
  if (window.days && window.days.length && !window.days.includes(now.getDay())) return false;
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  if (start === null || end === null) return true; // treat malformed window as "always on"
  const current = now.getHours() * 60 + now.getMinutes();
  // end <= start means the window wraps past midnight (e.g. 22:00 -> 06:00).
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

/**
 * How specifically a route matches a destination.
 * Returns null when the route does not match at all, otherwise a specificity
 * score (higher = more specific, so longest-prefix / operator beats a catch-all).
 */
function matchSpecificity(route: CandidateRoute, ctx: SelectionContext): number | null {
  const digits = normalizeMsisdn(ctx.msisdn);
  // A sender constraint, when present, must match regardless of route type.
  //
  // Matched as a wildcard rather than by string equality. This is deliberately
  // behaviour-preserving: a pattern with no metacharacter compiles to an
  // anchored exact match, which is what every existing rule already means. What
  // it adds is `URA*` and `URASMS|URAOTP`, which previously needed one rule per
  // sender id.
  if (route.sender && !matchesWildcard(ctx.sender ?? '', route.sender)) return null;

  switch (route.routeType) {
    // The SMS Studio grammar (`*`, `#`, `$`, `|`) against the destination.
    // Exists because `25677*|25678*|25676*|25679*` — "all MTN Uganda" — was
    // four separate prefix rules to create, keep in step and disable together.
    case 'wildcard': {
      const pattern = route.matchPrefix ?? route.destinationPrefix ?? '';
      if (!pattern.trim()) return null;
      return matchesWildcard(digits, pattern) ? wildcardSpecificity(pattern) : null;
    }
    case 'prefix': {
      const prefix = normalizeMsisdn(route.matchPrefix ?? '');
      if (!prefix) return 0;
      return digits.startsWith(prefix) ? prefix.length : null;
    }
    case 'country': {
      const code = normalizeMsisdn(route.countryCode ?? '');
      if (!code) return null;
      return digits.startsWith(code) ? code.length : null;
    }
    case 'operator': {
      const op = (route.operator ?? '').trim();
      if (!op) return null;
      return op === (ctx.operator ?? '').trim() ? 1000 : null;
    }
    case 'static':
    case 'weighted':
    default: {
      // Static / weighted match on the legacy destination_prefix (or match_prefix
      // if set); an empty prefix is an unconditional catch-all.
      const prefix = normalizeMsisdn(route.matchPrefix ?? route.destinationPrefix ?? '');
      if (!prefix) return 0;
      return digits.startsWith(prefix) ? prefix.length : null;
    }
  }
}

/**
 * How specific a wildcard pattern is, so a narrow one beats a catch-all.
 *
 * Counted as the literal characters in the LEAST specific alternative, not the
 * most. `25677*|*` must not outrank `2567*` on the strength of its first
 * alternative when its second matches everything — the pattern as a whole is
 * only as narrow as its widest branch.
 */
function wildcardSpecificity(pattern: string): number {
  const alternatives = pattern.split('|');
  let weakest = Number.POSITIVE_INFINITY;
  for (const alternative of alternatives) {
    const literals = alternative.replace(/[*#$]/g, '').length;
    if (literals < weakest) weakest = literals;
  }
  return Number.isFinite(weakest) ? weakest : 0;
}

/** The controlling route's effect, defaulted so a pre-052 row still routes. */
function effectOf(route: CandidateRoute): RouteRuleEffect {
  return {
    action: route.action ?? 'route',
    overrideSender: route.overrideSender ?? null,
    overrideRecipient: route.overrideRecipient ?? null,
    overrideText: route.overrideText ?? null,
    dropReason: route.dropReason ?? null,
  };
}

function isAvailable(smscId: string | null | undefined, ctx: SelectionContext): boolean {
  if (!smscId) return false;
  if (ctx.availableSmscIds == null) return true;
  return ctx.availableSmscIds.includes(smscId);
}

/** Ordered, enabled SMSC candidates for a route with their costs (primary first). */
interface SmscCandidate {
  smscId: string;
  cost: number | null;
  /** True for the primary target; used to report whether a fallback was taken. */
  primary: boolean;
  weight: number;
}

function routeCandidates(route: CandidateRoute): SmscCandidate[] {
  if (route.routeType === 'weighted' && route.targets && route.targets.length) {
    return route.targets
      .filter((t) => t.enabled !== false && t.weight > 0 && t.smscId)
      .map((t, index) => ({
        smscId: t.smscId,
        cost: t.cost ?? route.cost ?? null,
        primary: index === 0,
        weight: t.weight,
      }));
  }
  const candidates: SmscCandidate[] = [
    { smscId: route.targetSmscId, cost: route.cost ?? null, primary: true, weight: 1 },
  ];
  if (route.fallbackSmscId)
    candidates.push({
      smscId: route.fallbackSmscId,
      cost: route.cost ?? null,
      primary: false,
      weight: 1,
    });
  return candidates;
}

/** Deterministic weighted pick: expands weights and indexes by the rotation counter. */
function weightedPick(candidates: SmscCandidate[], rotation: number): SmscCandidate {
  const totalWeight = candidates.reduce((sum, c) => sum + Math.max(c.weight, 0), 0);
  if (totalWeight <= 0) return candidates[0];
  let position = ((rotation % totalWeight) + totalWeight) % totalWeight;
  for (const candidate of candidates) {
    position -= Math.max(candidate.weight, 0);
    if (position < 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

function noMatch(trace: string[], reason: string): SelectionResult {
  return {
    smscId: null,
    routeId: null,
    routeName: null,
    strategy: null,
    fallbackUsed: false,
    reason,
    trace: [...trace, reason],
  };
}

/**
 * Select the SMSC for a destination. Never throws: an unroutable destination
 * yields a result with `smscId: null` and an explanatory reason/trace.
 */
export function selectRoute(routes: CandidateRoute[], ctx: SelectionContext): SelectionResult {
  const now = ctx.now ?? new Date();
  const rotation = ctx.rotation ?? 0;
  const trace: string[] = [];
  const digits = normalizeMsisdn(ctx.msisdn);
  trace.push(`destination ${ctx.msisdn} (digits ${digits || 'none'})`);

  if (!digits) return noMatch(trace, 'destination has no dialable digits');

  // 1. MATCHING: enabled, in-window, and matching by route type.
  const matched = routes
    .filter((route) => {
      if (!route.enabled) return false;
      if (route.strategy === 'time-based' && !isWithinWindow(route.window, now)) return false;
      // A window on a non time-based route is still honoured when present.
      if (route.window && !isWithinWindow(route.window, now)) return false;
      return matchSpecificity(route, ctx) !== null;
    })
    .map((route) => ({ route, specificity: matchSpecificity(route, ctx) as number }));

  if (!matched.length) return noMatch(trace, 'no route matched the destination');
  trace.push(`${matched.length} route(s) matched`);

  // 2. CONTROLLING ROUTE: most specific wins; ties broken by lowest priority
  // number, then by name for determinism.
  matched.sort(
    (a, b) =>
      b.specificity - a.specificity ||
      a.route.priority - b.route.priority ||
      a.route.name.localeCompare(b.route.name),
  );
  const controlling = matched[0].route;
  trace.push(
    `controlling route "${controlling.name}" (${controlling.routeType}, priority ${controlling.priority}, strategy ${controlling.strategy})`,
  );

  const finish = (
    chosen: SmscCandidate | null,
    controllingRoute: CandidateRoute,
    reason: string,
  ): SelectionResult => {
    // The route matched but produced no usable SMSC: keep the route context so
    // the preview can explain which route was chosen yet left unroutable.
    if (!chosen) {
      const explained = `${reason}; no available SMSC`;
      trace.push(explained);
      return {
        smscId: null,
        routeId: controllingRoute.id,
        routeName: controllingRoute.name,
        strategy: controllingRoute.strategy,
        fallbackUsed: false,
        reason: explained,
        trace,
        effect: effectOf(controllingRoute),
      };
    }
    trace.push(`selected SMSC ${chosen.smscId} (${reason})`);
    return {
      smscId: chosen.smscId,
      routeId: controllingRoute.id,
      routeName: controllingRoute.name,
      strategy: controllingRoute.strategy,
      fallbackUsed: !chosen.primary,
      reason,
      trace,
      effect: effectOf(controllingRoute),
    };
  };

  // 3. STRATEGY: the controlling route's strategy decides the SMSC.
  switch (controlling.strategy) {
    case 'least-cost': {
      // Cheapest available SMSC across ALL matching routes; unknown cost sorts
      // last so a priced route is preferred over an unpriced one.
      const priced = matched
        .flatMap(({ route }) => routeCandidates(route))
        .filter((candidate) => isAvailable(candidate.smscId, ctx));
      if (!priced.length) return finish(null, controlling, 'least-cost');
      priced.sort(
        (a, b) =>
          (a.cost ?? Number.POSITIVE_INFINITY) - (b.cost ?? Number.POSITIVE_INFINITY) ||
          a.smscId.localeCompare(b.smscId),
      );
      const cheapest = priced[0];
      return finish(cheapest, controlling, `least-cost (cost ${cheapest.cost ?? 'n/a'})`);
    }

    case 'load-balance':
    case 'round-robin': {
      const available = routeCandidates(controlling).filter((candidate) =>
        isAvailable(candidate.smscId, ctx),
      );
      if (!available.length) return finish(null, controlling, controlling.strategy);
      const chosen =
        controlling.strategy === 'round-robin'
          ? available[((rotation % available.length) + available.length) % available.length]
          : weightedPick(available, rotation);
      return finish(chosen, controlling, `${controlling.strategy} (rotation ${rotation})`);
    }

    case 'priority':
    case 'time-based':
    default: {
      // Take the primary; fall back to the secondary when the primary is down.
      const candidates = routeCandidates(controlling);
      const primary = candidates.find((c) => c.primary);
      if (primary && isAvailable(primary.smscId, ctx))
        return finish(primary, controlling, 'primary target');
      const fallback = candidates.find((c) => !c.primary && isAvailable(c.smscId, ctx));
      if (fallback) return finish(fallback, controlling, 'primary unavailable, using fallback');
      return finish(null, controlling, 'primary and fallback unavailable');
    }
  }
}
