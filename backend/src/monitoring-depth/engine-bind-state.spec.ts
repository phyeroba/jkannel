import {
  BIND_STATES,
  isHardDown,
  isHealthy,
  severityFor,
  toBindState,
  toSmscHealthState,
} from './engine-bind-state';

describe('engine bind state vocabulary', () => {
  it('maps bearerbox tokens onto the eight Ch.22 states', () => {
    expect(toBindState('online')).toBe('bound');
    expect(toBindState('online 0d 0h 3m')).toBe('bound');
    expect(toBindState('running')).toBe('bound');
    expect(toBindState('connecting')).toBe('connecting');
    expect(toBindState('re-connecting')).toBe('retrying');
    expect(toBindState('dead')).toBe('disconnected');
    expect(toBindState('failed')).toBe('failed');
  });

  it('never invents health for an unrecognised, empty or missing status', () => {
    expect(toBindState('something-new')).toBe('unknown');
    expect(toBindState('')).toBe('unknown');
    expect(toBindState(null)).toBe('unknown');
    expect(toBindState(undefined)).toBe('unknown');
  });

  it('only treats bound as healthy', () => {
    for (const state of BIND_STATES) expect(isHealthy(state)).toBe(state === 'bound');
  });

  it('separates hard-down states from transitional ones', () => {
    expect(isHardDown('disconnected')).toBe(true);
    expect(isHardDown('failed')).toBe(true);
    expect(isHardDown('connecting')).toBe(false);
    expect(isHardDown('retrying')).toBe(false);
  });

  it('projects onto the narrower smsc_health vocabulary from migration 006', () => {
    expect(toSmscHealthState('bound')).toBe('active');
    expect(toSmscHealthState('connecting')).toBe('degraded');
    expect(toSmscHealthState('dead' as never)).toBe('degraded'); // not a Ch.22 value
    expect(toSmscHealthState('disconnected')).toBe('unreachable');
    expect(toSmscHealthState('failed')).toBe('unreachable');
    expect(toSmscHealthState('unknown')).toBe('unknown');
  });

  it('escalates severity for hard-down states', () => {
    expect(severityFor('disconnected')).toBe('critical');
    expect(severityFor('failed')).toBe('critical');
    expect(severityFor('connecting')).toBe('warning');
    expect(severityFor('bound')).toBe('info');
  });
});
