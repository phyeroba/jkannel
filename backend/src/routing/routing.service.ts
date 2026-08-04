import { Injectable } from '@nestjs/common';
import { CandidateRoute, selectRoute } from '../routing-depth/route-selection';

export interface RouteContext {
  messageId: string;
  destination: string;
  sender?: string;
  now: Date;
  healthySmscIds: ReadonlySet<string>;
}
export interface RouteRule {
  id: string;
  priority: number;
  enabled: boolean;
  destinationPrefix?: string;
  sender?: string;
  targetSmscId: string;
  fallbackSmscId?: string;
}
export interface RouteDecision {
  messageId: string;
  ruleId: string;
  smscId: string;
  reason: string;
}

/**
 * Legacy console route evaluator — now a thin ADAPTER over the one routing
 * engine, `selectRoute()`.
 *
 * There used to be two divergent engines. This one compared raw strings with
 * `startsWith`, so a rule with prefix `+256` never matched a destination stored
 * as `256700000000` (and vice versa); it knew nothing of route types,
 * strategies, costs, weights or time windows; and the operator-facing route
 * simulator called it, so the simulator and production could legitimately
 * disagree about where a message would go.
 *
 * Rather than leave both live on different paths, the implementation was
 * replaced with a translation into `CandidateRoute` and a call to the tested
 * selector. The class, its interfaces and its fail-closed behaviour are kept
 * verbatim so `/routes/simulate` and `/routes/:id/simulate` keep their existing
 * request/response contract — they now simulate exactly what the send path does.
 *
 * One behaviour deliberately changes with the convergence: the old loop walked
 * rules by priority and CASCADED to the next rule when a rule's target and
 * fallback were both down. `selectRoute` picks the most specific matching route
 * and reports it unroutable instead. That is what production now does, so the
 * simulator reporting anything else would be a lie.
 *
 * New code should call `RouteResolutionService` (routing-depth) directly; this
 * adapter exists for the console's two simulate endpoints.
 */
@Injectable()
export class RoutingService {
  evaluate(context: RouteContext, rules: RouteRule[]): RouteDecision {
    const candidates: CandidateRoute[] = rules.map((rule) => ({
      id: rule.id,
      // The legacy shape carries no name; sort ties fall back to it, so use the
      // id to keep the ordering deterministic.
      name: rule.id,
      priority: rule.priority,
      enabled: rule.enabled,
      routeType: 'static',
      strategy: 'priority',
      matchPrefix: null,
      destinationPrefix: rule.destinationPrefix ?? null,
      sender: rule.sender ?? null,
      targetSmscId: rule.targetSmscId,
      fallbackSmscId: rule.fallbackSmscId ?? null,
    }));

    const result = selectRoute(candidates, {
      msisdn: context.destination,
      sender: context.sender ?? null,
      now: context.now,
      availableSmscIds: [...context.healthySmscIds],
    });

    // Fail closed, exactly as before: the caller (the simulate endpoints) turns
    // this into a 400 rather than reporting a route that does not exist.
    if (!result.smscId || !result.routeId) throw new Error('No eligible route');

    return {
      messageId: context.messageId,
      ruleId: result.routeId,
      smscId: result.smscId,
      reason: result.fallbackUsed ? 'primary unavailable; fallback selected' : result.reason,
    };
  }
}
