import { describe, expect, it } from 'vitest';
import {
  MAX_REASON_LENGTH,
  activePathOf,
  actorLabel,
  controlEndpoint,
  operationVerb,
  reasonIsRecorded,
  reasonProblem,
  smscLabel,
  smscOptionsFrom,
  verificationTone,
  verificationWord,
  type ActiveFailover,
  type RouteRow,
} from '../src/utils/safe-control';

const route = (overrides: Partial<RouteRow> = {}): RouteRow => ({
  id: 'r1',
  name: 'MTN national',
  priority: 10,
  enabled: true,
  destination_prefix: '25677',
  sender: null,
  target_smsc_id: 's1',
  target_smsc_name: 'MTN Primary',
  fallback_smsc_id: null,
  fallback_smsc_name: null,
  ...overrides,
});

const override = (overrides: Partial<ActiveFailover> = {}): ActiveFailover => ({
  id: 'f1',
  route_id: 'r1',
  route_name: 'MTN national',
  from_smsc_id: 's1',
  to_smsc_id: 's2',
  to_engine_id: 'mtn-p2',
  to_name: 'MTN Secondary',
  reason: 'Carrier instructed traffic movement',
  started_by: 'amina',
  started_at: '2026-08-17T09:00:00Z',
  ...overrides,
});

describe('reason validation mirrors the API', () => {
  it('accepts nothing shorter than the three characters the service demands', () => {
    // safe-control.service.ts MIN_REASON = 3, and it answers 400 — by which
    // point the dialog has closed and the text is gone.
    expect(reasonProblem('', true)).toContain('A reason is required');
    expect(reasonProblem('  ', true)).toContain('A reason is required');
    expect(reasonProblem('ab', true)).toContain('at least 3 characters');
    expect(reasonProblem('  cycling per runbook  ', true)).toBe('');
  });

  it('rejects a reason past the server’s upper bound', () => {
    expect(reasonProblem('x'.repeat(MAX_REASON_LENGTH), true)).toBe('');
    expect(reasonProblem('x'.repeat(MAX_REASON_LENGTH + 1), true)).toContain('at most 500');
    // Even where a reason is optional, an over-long one would still 400.
    expect(reasonProblem('x'.repeat(MAX_REASON_LENGTH + 1), false)).toContain('at most 500');
    expect(reasonProblem('', false)).toBe('');
  });
});

describe('which endpoint keeps the reason it is given', () => {
  it('routes suspension through the control API and the rest through the legacy action', () => {
    expect(controlEndpoint('suspend', 'abc')).toBe('/control/smscs/abc/suspend');
    expect(controlEndpoint('resume', 'abc')).toBe('/control/smscs/abc/resume');
    expect(controlEndpoint('reconnect', 'abc')).toBe('/smscs/abc/actions/reconnect');
  });

  it('does not claim an audit entry the action endpoint will not write', () => {
    // POST /smscs/:id/actions/:operation declares only an Idempotency-Key
    // header; it never reads a body, so a reason sent to it is discarded.
    expect(reasonIsRecorded('reconnect')).toBe(false);
    expect(reasonIsRecorded('disable')).toBe(false);
    expect(reasonIsRecorded('enable')).toBe(false);
    expect(reasonIsRecorded('suspend')).toBe(true);
    expect(reasonIsRecorded('resume')).toBe(true);
  });

  it('gives every operation a verb', () => {
    expect(operationVerb('suspend')).toBe('Suspend traffic');
    expect(operationVerb('reconnect')).toBe('Reconnect');
    // An operation this build has not heard of prints as itself, not as blank.
    expect(operationVerb('teleport')).toBe('teleport');
  });
});

describe('the active path always carries its mode', () => {
  it('reports the configured target and automatic mode when nothing overrides it', () => {
    const path = activePathOf(route(), []);
    expect(path.targetName).toBe('MTN Primary');
    expect(path.overridden).toBe(false);
    expect(path.modeWord).toBe('automatic');
    expect(path.failover).toBeNull();
  });

  it('reports the override target AND says an override is in effect', () => {
    const path = activePathOf(route(), [override()]);
    expect(path.targetName).toBe('MTN Secondary');
    expect(path.overridden).toBe(true);
    // UC-RTE-02: the target can never be read without the mode beside it.
    expect(path.modeWord).toBe('manual override');
    expect(path.modeTone).toBe('warn');
    // The route's own configuration is unchanged and still readable.
    expect(path.configuredName).toBe('MTN Primary');
  });

  it('names a target even when the override row lost its joins', () => {
    const path = activePathOf(route(), [override({ to_name: null, to_engine_id: null })]);
    expect(path.targetName).toBe('s2');
    expect(path.overridden).toBe(true);
  });

  it('says a route has no configured target rather than rendering a blank', () => {
    const path = activePathOf(route({ target_smsc_id: null, target_smsc_name: null }), []);
    expect(path.targetName).toBe('no target configured');
  });

  it('ignores an override belonging to a different route', () => {
    expect(activePathOf(route({ id: 'r2' }), [override()]).overridden).toBe(false);
  });

  it('never renders an unattributed change as a blank actor', () => {
    expect(actorLabel(null)).toBe('not recorded');
    expect(actorLabel('   ')).toBe('not recorded');
    expect(actorLabel('amina')).toBe('amina');
  });
});

describe('SMSC options', () => {
  it('keeps the uuid the control endpoints take and labels it with the engine id', () => {
    const options = smscOptionsFrom([
      { id: 's1', engine_id: 'mtn-p1', name: 'MTN Primary' },
      { id: '', engine_id: 'orphan', name: 'No id' },
      { id: 's2', engine_id: 'mtn-p2', name: '' },
    ]);
    expect(options).toHaveLength(2);
    expect(options[0]).toEqual({
      id: 's1',
      engineId: 'mtn-p1',
      name: 'MTN Primary',
      label: 'MTN Primary (mtn-p1)',
    });
    // A nameless row falls back to its engine id rather than rendering "()".
    expect(options[1].label).toBe('mtn-p2 (mtn-p2)');
    expect(smscLabel('s1', options)).toBe('MTN Primary (mtn-p1)');
    expect(smscLabel('unknown', options)).toBe('unknown');
    expect(smscLabel(null, options)).toBe('none');
  });
});

describe('a connectivity test reports how far it got', () => {
  it('never paints a socket check as proof of credentials', () => {
    // A passed tcp_socket is not a green result: it says a listener exists.
    expect(verificationTone('tcp_socket', true)).toBe('warn');
    expect(verificationTone('smpp_bind', true)).toBe('good');
    expect(verificationTone('smpp_bind', false)).toBe('bad');
    expect(verificationTone(null, true)).toBe('muted');
  });

  it('explains the level in words, and refuses to explain one it does not know', () => {
    expect(verificationWord('smpp_bind')).toContain('credentials are proven');
    expect(verificationWord('tcp_socket')).toContain('never exercised');
    expect(verificationWord('quantum_tunnel')).toContain('cannot explain');
    expect(verificationWord(null)).toContain('no verification level');
  });
});
