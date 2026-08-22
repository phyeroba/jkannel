import { describe, expect, it } from 'vitest';
import {
  bindFactTarget,
  buildDiagnosticSummary,
  deliveryTone,
  factLabel,
  formatFinal,
  formatLatency,
  formatMilliseconds,
  formatSmppCode,
  formatSmppCodeBoth,
  formatStageMoment,
  isCorrelationId,
  isUndecodedStatus,
  isVendorSpecific,
  matchesStatusQuery,
  parseSmppCodeInput,
  retryTone,
  retryWord,
  severityTone,
  severityWord,
  stageTone,
  stageWord,
  subjectLabel,
  type MessageTrace,
  type SmppStatus,
} from '../src/utils/diagnostics';

const traceOf = (overrides: Partial<MessageTrace> = {}): MessageTrace => ({
  id: '91021',
  available: true,
  detail: 'Read from the engine message store.',
  events: [],
  lifecycle: { stages: [], totalMs: null, firstProblem: null, inFlight: false },
  ...overrides,
});

describe('the message search grid', () => {
  it('calls an absent receipt "awaiting receipt", not a dash', () => {
    // A dash on this screen means "we looked and there is nothing". A message
    // with no receipt yet is not that — it is unfinished.
    expect(formatFinal(null)).toBe('awaiting receipt');
    expect(formatFinal(undefined)).toBe('awaiting receipt');
    expect(formatFinal('not a date')).toBe('not a date');
  });

  it('refuses to paint a pending message as a warning', () => {
    expect(deliveryTone('pending')).toBe('muted');
    expect(deliveryTone('delivered')).toBe('good');
    expect(deliveryTone('failed')).toBe('bad');
    expect(deliveryTone('rejected')).toBe('bad');
    expect(deliveryTone(null)).toBe('muted');
  });
});

describe('the diagnostic summary', () => {
  it('omits every fact that was not recorded rather than printing a placeholder', () => {
    const text = buildDiagnosticSummary(traceOf());
    expect(text).toContain('Message 91021');
    expect(text).toContain('All recorded stages completed normally.');
    // Nothing was selected, so there is no destination, sender or reference to
    // quote — and inventing dashes for them would put "Destination: —" into a
    // carrier ticket.
    expect(text).not.toContain('Destination');
    expect(text).not.toContain('Carrier message ID');
    expect(text).not.toContain('—');
  });

  it('quotes the selected row and names the first abnormal stage', () => {
    const text = buildDiagnosticSummary(
      traceOf({
        lifecycle: {
          stages: [],
          totalMs: 420,
          firstProblem: {
            kind: 'receipt',
            label: 'Delivery receipt',
            detail: 'Carrier reported failed.',
          },
          inFlight: false,
        },
      }),
      {
        id: '91021',
        externalRef: '448210-mtn',
        sender: 'JKANNEL',
        receiver: '+256772000118',
        smscId: 'mtn-p1',
        deliveryStatus: 'failed',
        timestamp: '2026-08-17T09:00:00.000Z',
        dlrAt: null,
      },
      'MTN Uganda',
    );
    expect(text).toContain('Carrier message ID: 448210-mtn');
    expect(text).toContain('Destination: +256772000118 (MTN Uganda)');
    expect(text).toContain('SMSC: mtn-p1');
    expect(text).toContain('Outcome: failed');
    expect(text).toContain('First abnormal stage: Delivery receipt — Carrier reported failed.');
    // No receipt arrived, so there is no "Final" line at all.
    expect(text).not.toMatch(/^Final:/m);
  });

  it('marks a summary assembled while the engine store was unreadable', () => {
    const text = buildDiagnosticSummary(
      traceOf({ available: false, detail: 'SQLBox is not reachable.' }),
    );
    expect(text).toContain('NOTE: the engine message store could not be read');
  });
});

describe('latency is never a zero nobody measured', () => {
  it('renders a missing latency as the em dash, not 0ms', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(undefined)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
  });

  it('renders a measured zero as 0ms, because that IS a measurement', () => {
    expect(formatLatency(0)).toBe('0ms');
  });

  it('refuses to present any figure as fact in an untrustworthy state', () => {
    // §17: loading, error and permission-denied must not show numbers.
    expect(formatLatency(1200, 'loading')).toBe('—');
    expect(formatLatency(1200, 'error')).toBe('—');
    expect(formatLatency(1200, 'permission-denied')).toBe('—');
    // stale and partial have a real measurement behind them.
    expect(formatLatency(1200, 'stale')).toBe('1.2s');
  });

  it('scales from milliseconds through to days', () => {
    expect(formatMilliseconds(37)).toBe('37ms');
    expect(formatMilliseconds(999)).toBe('999ms');
    expect(formatMilliseconds(1500)).toBe('1.5s');
    expect(formatMilliseconds(90_000)).toBe('1m 30s');
    expect(formatMilliseconds(7_200_000)).toBe('2h 0m');
  });
});

describe('a pending stage is not a failure', () => {
  it('gives pending a neutral tone, never a warning or danger one', () => {
    expect(stageTone('pending')).toBe('muted');
    expect(stageTone('ok')).toBe('good');
    expect(stageTone('warning')).toBe('warn');
    expect(stageTone('failed')).toBe('bad');
  });

  it('describes pending as waiting rather than as broken', () => {
    expect(stageWord('pending')).toBe('still waiting');
    expect(stageWord('failed')).toBe('failed');
    expect(stageWord('ok')).toBe('completed');
  });

  it('says "not yet" for a stage that has not happened, not "never"', () => {
    expect(formatStageMoment(null, 'pending')).toBe('not yet');
    expect(formatStageMoment(null, 'ok')).toBe('not recorded');
    expect(formatStageMoment('nonsense', 'ok')).toBe('nonsense');
  });
});

describe('stage facts', () => {
  it('turns camelCase keys into readable labels', () => {
    expect(factLabel('chosenBind')).toBe('Chosen bind');
    expect(factLabel('candidatesConsidered')).toBe('Candidates considered');
    expect(factLabel('route')).toBe('Route');
  });

  it('links only the facts that name an SMSC, and only when they have a value', () => {
    expect(bindFactTarget('bind', 'mtn-p1')).toBe('/smsc/mtn-p1');
    expect(bindFactTarget('chosenBind', 'mtn-p1')).toBe('/smsc/mtn-p1');
    expect(bindFactTarget('bind', null)).toBe('');
    expect(bindFactTarget('route', 'mtn-p1')).toBe('');
  });
});

describe('SMPP command statuses', () => {
  const throttled: SmppStatus = {
    code: 0x58,
    name: 'ESME_RTHROTTLED',
    meaning: 'Messages are being sent faster than this account is allowed to send them.',
    guidance: 'Compare observed throughput against the contracted rate.',
    retryable: true,
  };

  it('shows both notations, because carrier docs and logs disagree', () => {
    expect(formatSmppCode(0x58)).toBe('0x00000058');
    expect(formatSmppCodeBoth(0x58)).toBe('0x00000058 · 88');
  });

  it('detects the undecoded case from the contract, not from a guess', () => {
    // The decoder returns the hex string AS the name when it has nothing to say.
    expect(isUndecodedStatus({ code: 0x401, name: '0x00000401' })).toBe(true);
    expect(isUndecodedStatus(throttled)).toBe(false);
  });

  it('knows the vendor range the specification reserves', () => {
    expect(isVendorSpecific(0x400)).toBe(true);
    expect(isVendorSpecific(0x4ff)).toBe(true);
    expect(isVendorSpecific(0x500)).toBe(false);
    expect(isVendorSpecific(0x58)).toBe(false);
  });

  it('says in words whether a retry could help', () => {
    expect(retryWord(true)).toBe('retry may succeed');
    expect(retryWord(false)).toBe('retrying will not help');
    expect(retryTone(true)).toBe('warn');
    expect(retryTone(false)).toBe('muted');
  });

  it('accepts decimal and hex and explains what it rejected', () => {
    expect(parseSmppCodeInput('88')).toEqual({ code: 88, error: '' });
    expect(parseSmppCodeInput('0x58')).toEqual({ code: 88, error: '' });
    expect(parseSmppCodeInput(' 0X00000058 ')).toEqual({ code: 88, error: '' });
    expect(parseSmppCodeInput('ESME_RTHROTTLED').code).toBeNull();
    expect(parseSmppCodeInput('ESME_RTHROTTLED').error).toContain('88 in decimal');
    expect(parseSmppCodeInput('').error).toContain('Enter a command status');
    expect(parseSmppCodeInput('99999999999').error).toContain('32-bit');
  });

  it('searches the reference by name, meaning and either notation', () => {
    expect(matchesStatusQuery(throttled, '')).toBe(true);
    expect(matchesStatusQuery(throttled, 'throttl')).toBe(true);
    expect(matchesStatusQuery(throttled, 'faster than')).toBe(true);
    expect(matchesStatusQuery(throttled, '88')).toBe(true);
    expect(matchesStatusQuery(throttled, '0x58')).toBe(true);
    expect(matchesStatusQuery(throttled, 'password')).toBe(false);
  });
});

describe('events', () => {
  it('never calls an unrecorded severity "info"', () => {
    expect(severityWord(null)).toBe('unrecorded');
    expect(severityWord('  ')).toBe('unrecorded');
    expect(severityWord('critical')).toBe('critical');
    expect(severityTone('critical')).toBe('bad');
    expect(severityTone('warning')).toBe('warn');
    expect(severityTone(null)).toBe('muted');
  });

  it('labels the subject, including the platform-wide case', () => {
    expect(subjectLabel({ subject_type: 'smsc', subject_id: 'mtn-p1' })).toBe('smsc mtn-p1');
    expect(subjectLabel({ subject_type: null, subject_id: null })).toBe('the platform');
  });

  it('accepts exactly what the controller accepts as a correlation id', () => {
    expect(isCorrelationId('0e3b1f2a-1111-2222-3333-444455556666')).toBe(true);
    expect(isCorrelationId('0e3b1f2a')).toBe(false);
    expect(isCorrelationId('')).toBe(false);
    expect(isCorrelationId(null)).toBe(false);
  });
});
