/**
 * The end-to-end message lifecycle (spec §10).
 *
 * §10 asks for "a chronological trace, not a raw log dump", with per-stage
 * timestamps, calculated latency, and the first abnormal or missing stage
 * highlighted.
 *
 * WHY THE OLD TRACE COULD NOT DO THIS
 * ---------------------------------------------------------------------------
 * `KamexSqlboxRepository.trace()` returns two or three rows: the spool row, the
 * sent row and the receipt. It is not shallow by oversight — it holds only the
 * SQLBox pool, and the routing decision lives in JKANNEL's own database. So the
 * richest evidence we capture on every single send (`message_route_decisions`:
 * which route matched, which candidates were considered, whether the fallback
 * was taken, why) was written on every message and read by nothing.
 *
 * Assembling the stages needs both connections, so it happens here rather than
 * in either repository.
 */

export type StageKind = 'accepted' | 'routed' | 'spooled' | 'submitted' | 'receipt' | 'retry';

export type StageStatus = 'ok' | 'warning' | 'failed' | 'pending';

export interface TraceStage {
  kind: StageKind;
  label: string;
  status: StageStatus;
  at: string | null;
  /** Milliseconds since the previous stage. Null on the first, or if unknown. */
  latencyMs: number | null;
  detail: string;
  /** Anything worth showing verbatim: route name, command status, reason. */
  facts: Record<string, string | number | null>;
}

export interface AssembledTrace {
  stages: TraceStage[];
  /** Total time from the first stage to the last, in milliseconds. */
  totalMs: number | null;
  /**
   * The first stage that is not `ok`. §10: "highlights the first abnormal or
   * missing stage" — an operator should not have to scan a timeline to find
   * where it went wrong.
   */
  firstProblem: { kind: StageKind; label: string; detail: string } | null;
  /** True when the message is still in flight rather than finished. */
  inFlight: boolean;
}

export interface RouteDecisionInput {
  routeName: string | null;
  strategy: string | null;
  smscId: string | null;
  requestedSmscId: string | null;
  fallbackUsed: boolean;
  outcome: string | null;
  reason: string | null;
  candidatesConsidered: number | null;
  contentRuleName: string | null;
  createdAt: string | null;
}

export interface EngineEventInput {
  source: 'send_sms' | 'sent_sms';
  direction: string | null;
  deliveryStatus: string | null;
  timestamp: string | null;
  smscId: string | null;
}

export interface RetryAttemptInput {
  attemptNo: number;
  smscId: string | null;
  outcome: string | null;
  createdAt: string | null;
}

const at = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export function assembleTrace(input: {
  decision: RouteDecisionInput | null;
  events: EngineEventInput[];
  retries: RetryAttemptInput[];
}): AssembledTrace {
  const stages: TraceStage[] = [];
  const { decision, events, retries } = input;

  const spool = events.find((event) => event.source === 'send_sms') ?? null;
  const sent =
    events.find((event) => event.source === 'sent_sms' && event.direction !== 'DLR') ?? null;
  const receipts = events.filter((event) => event.direction === 'DLR');
  // The LAST receipt is the outcome: Kannel emits intermediate buffered and
  // accepted receipts before the final delivered or failed one.
  const receipt = receipts.length ? receipts[receipts.length - 1] : null;

  if (decision) {
    const rejected = decision.outcome === 'rejected';
    stages.push({
      kind: 'routed',
      label: rejected ? 'Refused before routing' : 'Route selected',
      status: rejected ? 'failed' : decision.fallbackUsed ? 'warning' : 'ok',
      at: decision.createdAt,
      latencyMs: null,
      detail: rejected
        ? (decision.reason ?? 'The message was refused and never reached the engine.')
        : decision.fallbackUsed
          ? `The primary target was not usable, so the fallback carried this message. ${decision.reason ?? ''}`.trim()
          : (decision.reason ?? `Matched route ${decision.routeName ?? 'unnamed'}.`),
      facts: {
        route: decision.routeName,
        strategy: decision.strategy,
        chosenBind: decision.smscId,
        requestedBind: decision.requestedSmscId,
        candidatesConsidered: decision.candidatesConsidered,
        // Present only when a content rule stopped the message. Until now the
        // only way to learn this was to read the prose `reason`.
        contentRule: decision.contentRuleName,
      },
    });
  }

  if (spool)
    stages.push({
      kind: 'spooled',
      label: 'Written to the engine spool',
      status: 'ok',
      at: spool.timestamp,
      latencyMs: null,
      detail: 'JKANNEL wrote the message to send_sms; SQLBox had not yet consumed it.',
      facts: { bind: spool.smscId },
    });

  if (sent)
    stages.push({
      kind: 'submitted',
      label: 'Handed to the carrier',
      status: 'ok',
      at: sent.timestamp,
      latencyMs: null,
      detail: 'The engine accepted the message and submitted it on the bind below.',
      facts: { bind: sent.smscId },
    });

  for (const attempt of retries)
    stages.push({
      kind: 'retry',
      label: `Retry attempt ${attempt.attemptNo}`,
      status: attempt.outcome === 'delivered' ? 'ok' : 'warning',
      at: attempt.createdAt,
      latencyMs: null,
      detail: 'The message was re-sent after a negative delivery receipt.',
      facts: { bind: attempt.smscId, outcome: attempt.outcome },
    });

  if (receipt) {
    const status = receipt.deliveryStatus ?? 'unknown';
    const bad = status === 'failed' || status === 'rejected';
    stages.push({
      kind: 'receipt',
      label: 'Delivery receipt',
      status: bad ? 'failed' : status === 'delivered' ? 'ok' : 'warning',
      at: receipt.timestamp,
      latencyMs: null,
      detail: `The carrier reported ${status}.`,
      facts: { status, receipts: receipts.length },
    });
  } else if (sent) {
    // Absence is a state, and the distinction matters: no receipt is not the
    // same as a failure, and presenting it as one is how a delivered message
    // gets reported as lost.
    stages.push({
      kind: 'receipt',
      label: 'Delivery receipt',
      status: 'pending',
      at: null,
      latencyMs: null,
      detail:
        'No delivery receipt has arrived yet. That is not a failure: receipts follow ' +
        'submission, and some carriers never send one.',
      facts: { status: 'pending', receipts: 0 },
    });
  }

  stages.sort(
    (a, b) => (at(a.at) ?? Number.MAX_SAFE_INTEGER) - (at(b.at) ?? Number.MAX_SAFE_INTEGER),
  );

  // Latency is only meaningful between two stages that both happened.
  let previous: number | null = null;
  for (const stage of stages) {
    const current = at(stage.at);
    stage.latencyMs = previous !== null && current !== null ? current - previous : null;
    if (current !== null) previous = current;
  }

  const timestamps = stages
    .map((stage) => at(stage.at))
    .filter((value): value is number => value !== null);
  const problem = stages.find((stage) => stage.status === 'failed' || stage.status === 'warning');

  return {
    stages,
    totalMs: timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : null,
    firstProblem: problem
      ? { kind: problem.kind, label: problem.label, detail: problem.detail }
      : null,
    inFlight: stages.some((stage) => stage.status === 'pending'),
  };
}
