import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CandidateRoute, SelectionResult, selectRoute } from './route-selection';
import { RoutingDepthRepository } from './routing-depth.repository';

/** Everything the send path needs to choose a bind for one message. */
export interface SendRouteContext {
  /** Canonical digits-only destination (see ./msisdn). */
  msisdn: string;
  sender?: string | null;
  operator?: string | null;
  /** When set, only routes/SMSCs the customer is bound to are considered. */
  customerId?: string | null;
  /** Monotonic counter making load-balance / round-robin deterministic. */
  rotation?: number;
  now?: Date;
}

export interface SendRouteDecision extends SelectionResult {
  /** How many deployed, enabled, customer-permitted routes were considered. */
  candidatesConsidered: number;
  /** The health-derived candidate bind set the decision was made against. */
  availableSmscIds: string[];
  /** True when bind health was unavailable and every enabled bind was assumed up. */
  healthAssumed: boolean;
  /** Per-message cost of the controlling route, when it prices its traffic. */
  cost: number | null;
}

interface SmscRow {
  id: string;
  engine_id: string;
  bind_state: string | null;
}

/**
 * Route resolution FOR THE LIVE SEND PATH.
 *
 * `RoutingDepthService.resolve` is the operator-facing preview: it answers
 * "where would this go", against every enabled route, with the caller supplying
 * the availability set. This service answers the production question, which
 * needs four things the preview does not:
 *
 *   1. **Engine ids, not row ids.** `routing_rules.target_smsc_id` is a
 *      `smsc_definitions.id` (uuid); the engine spool keys on
 *      `smsc_definitions.engine_id` (e.g. `local-fake`). Candidates are
 *      translated to engine ids before selection, so the chosen `smscId` is
 *      directly submittable and the availability set is comparable.
 *   2. **Real bind health.** `availableSmscIds` is derived from
 *      `smsc_bind_state` (written continuously by `SmscStatusPoller`), so the
 *      fallback branch of the selector can actually fire. Before this, nothing
 *      ever populated it and failover was unreachable even in simulation.
 *   3. **Deployment state.** Only `deployment_state='deployed'` routes are live.
 *   4. **Customer entitlement.** When the message carries a customer with route
 *      bindings, only the bound routes / SMSCs are candidates.
 *
 * Everything runs inside the caller's tenant transaction so the decision, the
 * entitlement consumption and the send commit together.
 */
@Injectable()
export class RouteResolutionService {
  constructor(private readonly repository: RoutingDepthRepository) {}

  /**
   * Enabled SMSCs with their current bind state.
   *
   * A bind is available when the poller last observed it `bound`. When NO
   * enabled SMSC has a `smsc_bind_state` row at all — a deployment where the
   * poller is disabled or has not completed its first cycle — health is
   * unknown rather than bad, so every enabled bind is assumed available and
   * `healthAssumed` is reported so the decision record says so. Partial data is
   * treated as real: an SMSC the poller has never seen is not assumed healthy
   * once the poller is demonstrably running.
   */
  async availability(client: PoolClient): Promise<{
    byId: Map<string, string>;
    available: string[];
    healthAssumed: boolean;
  }> {
    const rows = (
      await client.query<SmscRow>(
        // `traffic_suspended_at IS NULL` is the send-path half of UC-SMSC-02.
        // Without it, "Suspend traffic" would be a button that records an
        // event, shows a badge and changes nothing — the worst kind of control,
        // because an operator would believe traffic had stopped.
        //
        // Applied in the WHERE clause rather than to `available`, so a
        // suspended SMSC is not a candidate at all: it must not be picked, and
        // it must not silently satisfy an explicitly pinned smscId either.
        `SELECT d.id::text AS id, d.engine_id, s.state AS bind_state
           FROM smsc_definitions d
           LEFT JOIN smsc_bind_state s ON s.smsc_id = d.id
          WHERE d.enabled = true AND d.traffic_suspended_at IS NULL`,
      )
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row.engine_id]));
    const observed = rows.some((row) => row.bind_state !== null);
    const available = observed
      ? rows.filter((row) => row.bind_state === 'bound').map((row) => row.engine_id)
      : rows.map((row) => row.engine_id);
    return { byId, available, healthAssumed: !observed };
  }

  /** Route / SMSC bindings entitling a customer, or null when unconstrained. */
  private async customerBindings(
    client: PoolClient,
    customerId: string,
  ): Promise<{ routeIds: Set<string>; smscIds: Set<string> } | null> {
    const rows = (
      await client.query<{ route_id: string | null; smsc_id: string | null }>(
        'SELECT route_id::text, smsc_id::text FROM customer_routes WHERE customer_id=$1 AND enabled=true',
        [customerId],
      )
    ).rows;
    if (!rows.length) return null; // no bindings configured = unconstrained
    return {
      routeIds: new Set(rows.map((r) => r.route_id).filter((v): v is string => Boolean(v))),
      smscIds: new Set(rows.map((r) => r.smsc_id).filter((v): v is string => Boolean(v))),
    };
  }

  /**
   * Translate a candidate's SMSC references from `smsc_definitions.id` to
   * `engine_id`, dropping any reference to an SMSC that is disabled or gone.
   * Returns null when the route has no usable primary target left.
   */
  private toEngineIds(route: CandidateRoute, byId: Map<string, string>): CandidateRoute | null {
    const primary = byId.get(route.targetSmscId);
    if (!primary) return null;
    const fallback = route.fallbackSmscId ? (byId.get(route.fallbackSmscId) ?? null) : null;
    const targets = (route.targets ?? [])
      .map((target) => {
        const engineId = byId.get(target.smscId);
        return engineId ? { ...target, smscId: engineId } : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    return { ...route, targetSmscId: primary, fallbackSmscId: fallback, targets };
  }

  /**
   * Chooses the bind for one message. Never throws for an unroutable
   * destination: the result carries `smscId: null` with a reason, and it is the
   * send path's job to refuse the submission rather than pick something.
   */
  async resolveInClient(client: PoolClient, ctx: SendRouteContext): Promise<SendRouteDecision> {
    const { byId, available, healthAssumed } = await this.availability(client);
    const all = await this.repository.candidateRoutesInClient(client, { deployedOnly: true });

    let scoped = all;
    if (ctx.customerId) {
      const bindings = await this.customerBindings(client, ctx.customerId);
      if (bindings)
        scoped = all.filter(
          (route) => bindings.routeIds.has(route.id) || bindings.smscIds.has(route.targetSmscId),
        );
    }

    const candidates = scoped
      .map((route) => this.toEngineIds(route, byId))
      .filter((route): route is CandidateRoute => route !== null);

    const result = selectRoute(candidates, {
      msisdn: ctx.msisdn,
      sender: ctx.sender ?? null,
      operator: ctx.operator ?? null,
      now: ctx.now,
      availableSmscIds: available,
      rotation: ctx.rotation ?? 0,
    });

    const controlling = result.routeId
      ? (candidates.find((route) => route.id === result.routeId) ?? null)
      : null;

    return {
      ...result,
      candidatesConsidered: candidates.length,
      availableSmscIds: available,
      healthAssumed,
      cost: controlling?.cost ?? null,
    };
  }
}
