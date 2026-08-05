import { classifyOutage, KamexRequestGate } from './kamex-request-gate';

/**
 * The behaviour under test is a feedback loop, not a feature: Kamex answers a
 * failed authentication by sleeping for a process-global, ever-growing total on
 * the one thread serving /health, /status, /shutdown and /graceful-restart. A
 * client that retries at a fixed rate therefore makes the engine's admin port
 * worse the longer it is wrong, and eventually unusable. These tests pin the
 * properties that break that loop.
 */
describe('KamexRequestGate', () => {
  const makeClock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  const gateWith = (clock: { now: () => number }) =>
    new KamexRequestGate({ threshold: 3, baseMs: 5_000, maxMs: 60_000, now: clock.now });

  it('allows requests freely until the failure threshold is reached', () => {
    const clock = makeClock();
    const gate = gateWith(clock);
    expect(gate.check().allowed).toBe(true);
    gate.recordFailure('boom');
    expect(gate.check().allowed).toBe(true);
    gate.recordFailure('boom');
    // Two failures is a blip, not a pattern; suppressing here would make a
    // transient network hiccup look like an outage.
    expect(gate.check().allowed).toBe(true);
  });

  it('suppresses once the threshold is crossed, and says so rather than claiming an outage', () => {
    const clock = makeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 3; i += 1) gate.recordFailure('Kamex status unavailable: timeout');
    const decision = gate.check();
    expect(decision.allowed).toBe(false);
    // The operator must be able to tell "we stopped asking" from "it is down".
    expect(decision.detail).toMatch(/suppressed/i);
    expect(decision.detail).toMatch(/3 consecutive failures/);
    expect(decision.detail).toContain('Kamex status unavailable: timeout');
  });

  it('widens the window exponentially, so a long outage costs few requests', () => {
    const clock = makeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 3; i += 1) gate.recordFailure('x');
    expect(gate.state().suppressedForMs).toBe(5_000);
    gate.recordFailure('x');
    expect(gate.state().suppressedForMs).toBe(10_000);
    gate.recordFailure('x');
    expect(gate.state().suppressedForMs).toBe(20_000);
  });

  it('caps the window so bind-state polling always recovers on its own', () => {
    const clock = makeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 40; i += 1) gate.recordFailure('x');
    // Route resolution reads the data this polling produces. An unbounded
    // window would freeze that view with no path back.
    expect(gate.state().suppressedForMs).toBe(60_000);
  });

  it('lets exactly ONE probe through when the window expires, without resetting first', () => {
    const clock = makeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 3; i += 1) gate.recordFailure('x');
    expect(gate.check().allowed).toBe(false);

    clock.advance(5_001);
    expect(gate.check().allowed).toBe(true);

    // Resetting on `check` would restore full request volume on the strength of
    // a request that has not happened yet — re-opening the very loop this
    // class closes. The counter must still be armed.
    gate.recordFailure('still failing');
    expect(gate.check().allowed).toBe(false);
    expect(gate.state().consecutiveFailures).toBe(4);
  });

  it('resets fully on success, so a recovered engine is polled at full rate again', () => {
    const clock = makeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 5; i += 1) gate.recordFailure('x');
    clock.advance(60_000);
    gate.recordSuccess();
    expect(gate.check().allowed).toBe(true);
    expect(gate.state()).toMatchObject({ consecutiveFailures: 0, suppressed: false });
  });
});

describe('classifyOutage', () => {
  /**
   * The differential is the whole point. Neither response alone identifies a
   * credential fault — and past the third failure the engine's own sleep
   * exceeds our request timeout, so no status code comes back at all. But
   * /health needs no password while /status.json does, so the PAIR separates
   * "engine down" from "our password is wrong". Those have completely
   * different fixes, and reporting the second as the first sends an operator
   * to debug the wrong system.
   */
  it('reads a reachable /health beside a failing authenticated call as a credential fault', () => {
    expect(classifyOutage(true)).toBe('credentials');
  });

  it('reads an unreachable /health as a genuine engine outage', () => {
    expect(classifyOutage(false)).toBe('unreachable');
  });

  it('refuses to guess when /health was never observed', () => {
    expect(classifyOutage(null)).toBe('unknown');
  });
});
