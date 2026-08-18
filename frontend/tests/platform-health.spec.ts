import { describe, expect, it } from 'vitest';
import {
  advise,
  byUrgency,
  formatBytes,
  formatPercent,
  formatUptime,
  pressureTone,
  stateTone,
  stateWord,
  type ServiceReading,
} from '../src/utils/platform-health';

const reading = (overrides: Partial<ServiceReading> = {}): ServiceReading => ({
  name: 'bearerbox',
  role: 'Holds the carrier binds',
  state: 'healthy',
  observation: 'probed',
  detail: 'The engine answered its health probe.',
  dependsOn: [],
  affects: [],
  rootCause: null,
  observedAt: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

describe('an unwatched component never renders like a healthy one', () => {
  it('says "not observed", not "unknown"', () => {
    // "Unknown" reads as a transient gap that the next poll might fill. Nothing
    // is polling, and the word has to say so.
    expect(stateWord(reading({ state: 'unknown', observation: 'unobserved' }))).toBe('not observed');
    expect(stateWord(reading({ state: 'unknown', observation: 'derived' }))).toBe('unknown');
  });

  it('is toned apart from healthy, degraded and failing', () => {
    expect(stateTone('healthy')).toBe('good');
    expect(stateTone('degraded')).toBe('warn');
    expect(stateTone('critical')).toBe('bad');
    expect(stateTone('unknown')).toBe('muted');
  });

  it('sorts above healthy rows, because a blind spot is a gap to close', () => {
    const rows = [
      reading({ name: 'database', state: 'healthy' }),
      reading({ name: 'smsbox', state: 'unknown', observation: 'unobserved' }),
      reading({ name: 'sqlbox', state: 'critical' }),
      reading({ name: 'cache', state: 'degraded' }),
    ].sort(byUrgency);
    expect(rows.map((r) => r.name)).toEqual(['sqlbox', 'cache', 'smsbox', 'database']);
  });

  it('sorts alphabetically within a state, so the order is stable between polls', () => {
    const rows = [
      reading({ name: 'zeta', state: 'critical' }),
      reading({ name: 'alpha', state: 'critical' }),
    ].sort(byUrgency);
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('advise', () => {
  it('sends the operator to the dependency, not to the symptom', () => {
    // The failure this prevents: restarting bearerbox six times while
    // PostgreSQL is the thing that is actually down.
    const text = advise(reading({ state: 'critical', dependsOn: ['database'], rootCause: 'database' }));
    expect(text).toContain('Fix database first');
    expect(text).toContain('usually changes nothing');
  });

  it('names what breaks next when this is the root failure', () => {
    const text = advise(
      reading({ name: 'database', state: 'critical', affects: ['bearerbox', 'job-worker'] }),
    );
    expect(text).toContain('root failure');
    expect(text).toContain('bearerbox, job-worker');
  });

  it('says an unobserved component is not a fault', () => {
    const text = advise(reading({ state: 'unknown', observation: 'unobserved' }));
    expect(text).toContain('Not a fault');
    expect(text).toContain('unknown, not healthy');
  });

  it('has nothing to say about a healthy component', () => {
    expect(advise(reading())).toBe('Nothing to do.');
  });
});

describe('formatting a figure that was never measured', () => {
  it('says "unknown" rather than 0%', () => {
    // 0% reads as "idle" and is a measurement an operator acts on.
    expect(formatPercent(null)).toBe('unknown');
    expect(formatPercent(undefined)).toBe('unknown');
    expect(formatPercent(Number.NaN)).toBe('unknown');
    expect(formatPercent(0)).toBe('0%');
  });

  it('says "unknown" rather than 0 B', () => {
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes(Number.NaN)).toBe('unknown');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('says "unknown" rather than 0s of uptime', () => {
    expect(formatUptime(null)).toBe('unknown');
    expect(formatUptime(0)).toBe('0s');
  });
});

describe('formatBytes', () => {
  it('scales to the unit an operator reads', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(536870912)).toBe('512 MB');
    expect(formatBytes(2147483648)).toBe('2.0 GB');
  });
});

describe('formatUptime', () => {
  it('drops precision as the duration grows', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(605)).toBe('10m');
    expect(formatUptime(3720)).toBe('1h 2m');
    expect(formatUptime(273600)).toBe('3d 4h');
  });
});

describe('pressureTone', () => {
  it('escalates only where it means something', () => {
    expect(pressureTone(40)).toBe('good');
    expect(pressureTone(75)).toBe('warn');
    expect(pressureTone(90)).toBe('bad');
  });

  it('is muted, not green, when there is no figure', () => {
    // Green on a missing measurement is the worst possible reading.
    expect(pressureTone(null)).toBe('muted');
  });
});
