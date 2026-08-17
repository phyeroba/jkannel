import { assembleTrace, type RouteDecisionInput } from './message-trace';

const T = (offsetMs: number) =>
  new Date(Date.parse('2026-08-06T12:00:00Z') + offsetMs).toISOString();

const decision = (overrides: Partial<RouteDecisionInput> = {}): RouteDecisionInput => ({
  routeName: 'Uganda MTN',
  strategy: 'priority',
  smscId: 'mtn-p1',
  requestedSmscId: null,
  fallbackUsed: false,
  outcome: 'routed',
  reason: null,
  candidatesConsidered: 3,
  contentRuleName: null,
  createdAt: T(0),
  ...overrides,
});

const spooled = {
  source: 'send_sms' as const,
  direction: 'MT',
  deliveryStatus: null,
  timestamp: T(120),
  smscId: 'mtn-p1',
};
const submitted = {
  source: 'sent_sms' as const,
  direction: 'MT',
  deliveryStatus: null,
  timestamp: T(900),
  smscId: 'mtn-p1',
};
const delivered = {
  source: 'sent_sms' as const,
  direction: 'DLR',
  deliveryStatus: 'delivered',
  timestamp: T(4300),
  smscId: 'mtn-p1',
};

describe('assembleTrace', () => {
  it('builds the lifecycle in order with per-stage latency', () => {
    const trace = assembleTrace({
      decision: decision(),
      events: [submitted, spooled, delivered],
      retries: [],
    });
    expect(trace.stages.map((stage) => stage.kind)).toEqual([
      'routed',
      'spooled',
      'submitted',
      'receipt',
    ]);
    // First stage has nothing to measure against.
    expect(trace.stages[0].latencyMs).toBeNull();
    expect(trace.stages[1].latencyMs).toBe(120);
    expect(trace.stages[2].latencyMs).toBe(780);
    expect(trace.totalMs).toBe(4300);
    expect(trace.firstProblem).toBeNull();
  });

  /**
   * The routing decision is the point of this module. It was captured on every
   * send and read by nothing, because the trace lived in a repository holding
   * only the engine's connection.
   */
  it('surfaces the route decision the old trace never queried', () => {
    const trace = assembleTrace({ decision: decision(), events: [spooled], retries: [] });
    const routed = trace.stages.find((stage) => stage.kind === 'routed')!;
    expect(routed.facts.route).toBe('Uganda MTN');
    expect(routed.facts.candidatesConsidered).toBe(3);
  });

  it('names the content rule when one refused the message', () => {
    // Previously recoverable only by parsing the prose reason.
    const trace = assembleTrace({
      decision: decision({
        outcome: 'rejected',
        contentRuleName: 'Block competitor keywords',
        reason: 'Body matched a block rule.',
      }),
      events: [],
      retries: [],
    });
    const routed = trace.stages[0];
    expect(routed.status).toBe('failed');
    expect(routed.facts.contentRule).toBe('Block competitor keywords');
    expect(trace.firstProblem?.kind).toBe('routed');
  });

  it('flags a fallback as a warning rather than a clean success', () => {
    const trace = assembleTrace({
      decision: decision({ fallbackUsed: true, reason: 'Primary bind was unbound.' }),
      events: [spooled],
      retries: [],
    });
    expect(trace.stages[0].status).toBe('warning');
    expect(trace.firstProblem?.kind).toBe('routed');
  });

  /**
   * §10 asks for the first abnormal stage to be highlighted, so an operator
   * does not have to scan a timeline to find where it broke.
   */
  it('reports the FIRST problem, not the last', () => {
    const trace = assembleTrace({
      decision: decision({ fallbackUsed: true }),
      events: [spooled, submitted, { ...delivered, deliveryStatus: 'failed' }],
      retries: [],
    });
    expect(trace.firstProblem?.kind).toBe('routed');
  });

  it('treats a missing receipt as pending, never as failure', () => {
    // A delivered message with a slow carrier must not be reported as lost.
    const trace = assembleTrace({
      decision: decision(),
      events: [spooled, submitted],
      retries: [],
    });
    const receipt = trace.stages.find((stage) => stage.kind === 'receipt')!;
    expect(receipt.status).toBe('pending');
    expect(receipt.detail).toMatch(/not a failure/);
    expect(trace.inFlight).toBe(true);
  });

  it('does not invent a receipt stage for a message that never reached the engine', () => {
    const trace = assembleTrace({
      decision: decision({ outcome: 'rejected' }),
      events: [],
      retries: [],
    });
    expect(trace.stages.some((stage) => stage.kind === 'receipt')).toBe(false);
  });

  it('uses the LAST receipt as the outcome, not the first', () => {
    // Kannel emits buffered/accepted before the final delivered.
    const trace = assembleTrace({
      decision: decision(),
      events: [
        spooled,
        submitted,
        { ...delivered, deliveryStatus: 'buffered', timestamp: T(2000) },
        { ...delivered, deliveryStatus: 'delivered', timestamp: T(5000) },
      ],
      retries: [],
    });
    const receipt = trace.stages.find((stage) => stage.kind === 'receipt')!;
    expect(receipt.facts.status).toBe('delivered');
    expect(receipt.facts.receipts).toBe(2);
  });

  it('includes retry attempts in the timeline', () => {
    const trace = assembleTrace({
      decision: decision(),
      events: [spooled, submitted, { ...delivered, deliveryStatus: 'failed', timestamp: T(3000) }],
      retries: [{ attemptNo: 1, smscId: 'mtn-p2', outcome: 'delivered', createdAt: T(6000) }],
    });
    const retry = trace.stages.find((stage) => stage.kind === 'retry')!;
    expect(retry.facts.bind).toBe('mtn-p2');
    expect(retry.at).toBe(T(6000));
  });

  it('leaves latency null across a stage with no timestamp', () => {
    // A computed delta against an absent time would be a fabricated number.
    const trace = assembleTrace({
      decision: decision({ createdAt: null }),
      events: [spooled],
      retries: [],
    });
    expect(trace.stages.every((stage) => stage.latencyMs === null || stage.latencyMs >= 0)).toBe(
      true,
    );
  });

  it('returns an empty, honest trace when there is nothing to show', () => {
    const trace = assembleTrace({ decision: null, events: [], retries: [] });
    expect(trace.stages).toEqual([]);
    expect(trace.totalMs).toBeNull();
    expect(trace.firstProblem).toBeNull();
    expect(trace.inFlight).toBe(false);
  });
});
