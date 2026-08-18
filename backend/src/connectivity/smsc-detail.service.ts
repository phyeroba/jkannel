import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

/**
 * What the engine can and cannot tell us about a bind, stated as data.
 *
 * §5 asks for a per-SESSION view: bind state in SMPP vocabulary, endpoint,
 * uptime, last activity, enquire_link round-trip time, submit_sm /
 * submit_sm_resp / deliver_sm / generic_nack counters, protocol latency
 * percentiles, reconnect and timeout counts.
 *
 * bearerbox reports none of that. `/status.json` gives one entry per `smsc-id`
 * with `status`, `queued`, `failed`, `sent`, `received` and two rate triples —
 * coarse aggregates, no PDU breakdown, no latency, no enquire-link timing. And
 * `instances = N` forks N connections that all share one `smsc-id`, so there is
 * no per-session identity to key anything on even in principle.
 *
 * Rather than ship a screen with empty columns, the API returns this alongside
 * the data so the console can say exactly which fields are unavailable and why.
 * Inventing a session list we cannot populate would break the house rule the
 * design system states outright: honesty is the house rule.
 */
export interface ObservabilityLimits {
  /** Fields §5 asks for that this engine does not emit. */
  unavailable: string[];
  /** Why, in one sentence an operator can act on. */
  reason: string;
  /**
   * True when `instances > 1`, i.e. several real SMPP sessions are collapsed
   * into the single row below. The count is configuration, not observation.
   */
  sessionsCollapsed: boolean;
  configuredInstances: number;
}

export interface BindTransition {
  kind: string;
  fromState: string | null;
  toState: string | null;
  detail: Record<string, unknown> | null;
  observedAt: string;
}

export interface SmscDetail {
  id: string;
  engineId: string;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  enabled: boolean;
  lifecycleState: string;
  carrierId: string | null;
  carrierName: string | null;
  bindState: string | null;
  bindStateSince: string | null;
  bindObservedAt: string | null;
  /**
   * Operator hold on new submissions (UC-SMSC-02), distinct from a
   * carrier-dropped bind. Exposed here because it was previously written by the
   * control service and read by nothing, which made "visually distinguish
   * operator-suspended from carrier-disconnected" impossible on every screen —
   * a suspended SMSC looked identical to a healthy one.
   */
  trafficSuspendedAt: string | null;
  trafficSuspendedBy: string | null;
  trafficSuspendedReason: string | null;
  queued: number | null;
  failed: number | null;
  sent: number | null;
  received: number | null;
  outboundRate: number | null;
  inboundRate: number | null;
  capacity: CapacityView;
  transitions: BindTransition[];
  limits: ObservabilityLimits;
}

/**
 * Configured ceiling versus observed throughput (§4.2 "Capacity", spec's
 * "Known/configured ceiling and utilisation").
 *
 * `smsc_definitions.tps` was previously consumed only by the config generator
 * to render the engine directive; nothing ever compared it to reality.
 *
 * THE MULTIPLIER IS NOT COSMETIC. Kannel's `throughput` is enforced PER
 * CONNECTION, so an SMSC with `instances = 3` and `tps = 50` is allowed roughly
 * 150 messages/second, not 50. Reporting 50 as the ceiling would show an
 * operator 140% utilisation on a link that is well inside its contract — and,
 * worse, hide the fact that the gateway can legitimately exceed a carrier's
 * contracted rate.
 */
export interface CapacityView {
  perConnectionTps: number | null;
  connections: number;
  effectiveTps: number | null;
  observedTps: number | null;
  /** observed / effective, 0..n. Null when either side is unknown. */
  utilisation: number | null;
  note: string;
}

export function describeCapacity(input: {
  tps: number | null;
  connectionCount: number | null;
  observedTps: number | null;
}): CapacityView {
  const connections = Math.max(1, input.connectionCount ?? 1);
  const perConnectionTps = input.tps ?? null;
  const effectiveTps = perConnectionTps === null ? null : perConnectionTps * connections;
  const observedTps = input.observedTps ?? null;
  const utilisation =
    effectiveTps === null || effectiveTps === 0 || observedTps === null
      ? null
      : observedTps / effectiveTps;
  return {
    perConnectionTps,
    connections,
    effectiveTps,
    observedTps,
    utilisation,
    note:
      perConnectionTps === null
        ? 'No throughput ceiling is configured for this SMSC, so utilisation cannot be calculated.'
        : connections > 1
          ? `throughput is enforced per connection, so ${connections} parallel connections at ` +
            `${perConnectionTps}/s allow about ${effectiveTps}/s in total. Check this against the ` +
            'rate your contract with the carrier actually permits.'
          : `Configured ceiling ${perConnectionTps}/s on a single connection.`,
  };
}

@Injectable()
export class SmscDetailService {
  constructor(private readonly database: DatabaseService) {}

  async detail(actor: Actor, engineId: string): Promise<SmscDetail> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT s.id::text, s.engine_id, s.name, s.type, s.host, s.port, s.enabled,
                s.lifecycle_state, s.tps, s.connection_count,
                s.traffic_suspended_at, s.traffic_suspended_by, s.traffic_suspended_reason,
                s.carrier_id::text, c.name AS carrier_name,
                b.state, b.entered_at, b.observed_at, b.queued_count, b.failed_count,
                snap.sent, snap.received, snap.outbound_rate, snap.inbound_rate
           FROM smsc_definitions s
           LEFT JOIN carriers c ON c.id = s.carrier_id AND c.deleted_at IS NULL
           LEFT JOIN smsc_bind_state b ON b.smsc_id = s.id
           LEFT JOIN LATERAL (
                SELECT sent, received, outbound_rate, inbound_rate
                  FROM smsc_bind_snapshots
                 WHERE smsc_id = s.id
                 ORDER BY observed_at DESC LIMIT 1
           ) snap ON true
          WHERE s.engine_id = $1 AND s.deleted_at IS NULL`,
        [engineId],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('SMSC not found');

      // Kept forever by design (migration 031), so this is the real bind
      // history rather than a rolling window — which is what makes the flap
      // diagnosis in §5/UC-SMPP-01 possible at all.
      const history = await client.query<Record<string, unknown>>(
        `SELECT kind, from_state, to_state, detail, observed_at
           FROM smsc_bind_transitions
          WHERE smsc_id = $1::uuid
          ORDER BY observed_at DESC LIMIT 100`,
        [row.id],
      );

      const connectionCount = row.connection_count === null ? null : Number(row.connection_count);
      const outboundRate = firstRate(row.outbound_rate);
      return {
        id: String(row.id),
        engineId: String(row.engine_id),
        name: String(row.name ?? row.engine_id),
        type: String(row.type),
        host: (row.host as string) ?? null,
        port: row.port === null ? null : Number(row.port),
        enabled: Boolean(row.enabled),
        lifecycleState: String(row.lifecycle_state),
        carrierId: (row.carrier_id as string) ?? null,
        carrierName: (row.carrier_name as string) ?? null,
        bindState: (row.state as string) ?? null,
        bindStateSince: row.entered_at ? String(row.entered_at) : null,
        bindObservedAt: row.observed_at ? String(row.observed_at) : null,
        trafficSuspendedAt: row.traffic_suspended_at ? String(row.traffic_suspended_at) : null,
        trafficSuspendedBy: (row.traffic_suspended_by as string) ?? null,
        trafficSuspendedReason: (row.traffic_suspended_reason as string) ?? null,
        queued: numberOrNull(row.queued_count),
        failed: numberOrNull(row.failed_count),
        sent: numberOrNull(row.sent),
        received: numberOrNull(row.received),
        outboundRate,
        inboundRate: firstRate(row.inbound_rate),
        capacity: describeCapacity({
          tps: numberOrNull(row.tps),
          connectionCount,
          observedTps: outboundRate,
        }),
        transitions: history.rows.map((entry) => ({
          kind: String(entry.kind),
          fromState: (entry.from_state as string) ?? null,
          toState: (entry.to_state as string) ?? null,
          detail: (entry.detail as Record<string, unknown>) ?? null,
          observedAt: String(entry.observed_at),
        })),
        limits: observabilityLimits(connectionCount ?? 1),
      };
    });
  }
}

/** The engine's rate fields are triples (1/5/15-minute); the first is current. */
function firstRate(value: unknown): number | null {
  if (Array.isArray(value) && value.length) {
    const first = Number(value[0]);
    return Number.isFinite(first) ? first : null;
  }
  return numberOrNull(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function observabilityLimits(configuredInstances: number): ObservabilityLimits {
  const sessionsCollapsed = configuredInstances > 1;
  return {
    unavailable: [
      'per-session identity',
      'bind state in SMPP vocabulary (BOUND_TX/RX/TRX)',
      'enquire_link round-trip time and missed responses',
      'submit_sm / submit_sm_resp / deliver_sm / generic_nack counters',
      'protocol response latency (median, P95)',
      'session uptime and last protocol activity',
    ],
    reason: sessionsCollapsed
      ? `This SMSC is configured with ${configuredInstances} parallel connections, which the ` +
        'engine reports as a single entry sharing one smsc-id. bearerbox exposes only aggregate ' +
        'counters per smsc-id — no PDU breakdown, no protocol latency and no per-session ' +
        'identity — so the figures below cover all connections together and cannot be split.'
      : 'bearerbox exposes only aggregate counters per smsc-id through its status interface — ' +
        'no PDU breakdown, no protocol latency and no enquire-link timing. The bind timeline ' +
        "below is JKANNEL's own observation history, not engine-reported session data.",
    sessionsCollapsed,
    configuredInstances,
  };
}
