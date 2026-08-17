import { describeCapacity, observabilityLimits } from './smsc-detail.service';

/**
 * §4.2 asks for "known/configured ceiling and utilisation". The trap is that
 * Kannel enforces `throughput` PER CONNECTION, so an SMSC with `instances = 3`
 * and `tps = 50` may legitimately send about 150/s.
 *
 * Getting this wrong is not a rounding error. Reporting 50 as the ceiling shows
 * an operator 140% utilisation on a link that is comfortably inside its limit —
 * and conceals the opposite, more dangerous case: that the gateway can exceed
 * the rate a carrier contract actually permits without any screen noticing.
 */
describe('describeCapacity', () => {
  it('multiplies the per-connection ceiling by the number of connections', () => {
    const capacity = describeCapacity({ tps: 50, connectionCount: 3, observedTps: 75 });
    expect(capacity.effectiveTps).toBe(150);
    expect(capacity.utilisation).toBeCloseTo(0.5);
    // The multiplication has to be visible, not just applied.
    expect(capacity.note).toContain('per connection');
    expect(capacity.note).toContain('150');
  });

  it('warns that the effective ceiling may exceed the contracted rate', () => {
    const capacity = describeCapacity({ tps: 50, connectionCount: 4, observedTps: null });
    expect(capacity.note).toMatch(/contract/);
  });

  it('treats a single connection as the plain configured ceiling', () => {
    const capacity = describeCapacity({ tps: 50, connectionCount: 1, observedTps: 25 });
    expect(capacity.effectiveTps).toBe(50);
    expect(capacity.utilisation).toBeCloseTo(0.5);
    expect(capacity.note).not.toContain('per connection');
  });

  it('treats an unset connection count as one, never as zero', () => {
    // Zero would make the effective ceiling zero and utilisation infinite.
    const capacity = describeCapacity({ tps: 50, connectionCount: null, observedTps: 10 });
    expect(capacity.connections).toBe(1);
    expect(capacity.effectiveTps).toBe(50);
  });

  it('reports utilisation as unknown when no ceiling is configured', () => {
    // Not 0%, and not 100%. There is nothing to be a percentage of.
    const capacity = describeCapacity({ tps: null, connectionCount: 2, observedTps: 40 });
    expect(capacity.effectiveTps).toBeNull();
    expect(capacity.utilisation).toBeNull();
    expect(capacity.note).toMatch(/cannot be calculated/);
  });

  it('reports utilisation as unknown when throughput has not been observed', () => {
    const capacity = describeCapacity({ tps: 50, connectionCount: 1, observedTps: null });
    expect(capacity.utilisation).toBeNull();
  });

  it('does not divide by a zero ceiling', () => {
    const capacity = describeCapacity({ tps: 0, connectionCount: 1, observedTps: 10 });
    expect(capacity.utilisation).toBeNull();
  });

  it('reports utilisation above 1 rather than clamping it', () => {
    // A link over its configured ceiling is exactly what an operator needs to
    // see; clamping to 100% would hide it.
    const capacity = describeCapacity({ tps: 10, connectionCount: 1, observedTps: 17 });
    expect(capacity.utilisation).toBeCloseTo(1.7);
  });
});

/**
 * §5 asks for per-session SMPP telemetry the engine simply does not emit. The
 * API returns the gap as data so the console can render it, rather than showing
 * empty columns that read as "no errors".
 */
describe('observabilityLimits', () => {
  it('names the fields the engine cannot report', () => {
    const limits = observabilityLimits(1);
    expect(limits.unavailable).toEqual(
      expect.arrayContaining([
        expect.stringContaining('enquire_link'),
        expect.stringContaining('submit_sm'),
        expect.stringContaining('per-session identity'),
      ]),
    );
  });

  it('says the bind timeline is our own observation, not engine session data', () => {
    // Otherwise an operator could read the timeline as protocol-level evidence.
    expect(observabilityLimits(1).reason).toMatch(/own observation history/);
  });

  it('explains that parallel connections are collapsed into one reported entry', () => {
    const limits = observabilityLimits(3);
    expect(limits.sessionsCollapsed).toBe(true);
    expect(limits.reason).toContain('3 parallel connections');
    expect(limits.reason).toMatch(/cannot be split/);
  });

  it('does not claim collapsing when there is only one connection', () => {
    expect(observabilityLimits(1).sessionsCollapsed).toBe(false);
  });
});
