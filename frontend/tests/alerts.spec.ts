import { describe, expect, it } from 'vitest';
import {
  alertAcknowledgement,
  alertCategory,
  alertDuration,
  alertDurationSeconds,
  alertObject,
  alertOccurrences,
  alertSeverityTone,
} from '../src/utils/alerts';

/**
 * Category is a translation of `details.kind`, which four different emitters
 * write. The tests use the kinds those emitters actually produce, so a rename
 * on the backend breaks here rather than silently filing real alerts under a
 * heading nobody watches.
 */
describe('alertCategory', () => {
  it('translates the kinds the poller and the anomaly detector emit', () => {
    expect(alertCategory({ details: { kind: 'engine_unreachable' } })).toBe('Availability');
    expect(alertCategory({ details: { kind: 'bind_state' } })).toBe('Connectivity quality');
    expect(alertCategory({ details: { kind: 'volume_drop' } })).toBe('Traffic anomaly');
    expect(alertCategory({ details: { kind: 'dlr_failure' } })).toBe('Delivery quality');
  });

  it('derives a rule alert’s category from the metric it watches', () => {
    // The rule's own name is user-authored and says nothing reliable.
    const of = (metric: string) =>
      alertCategory({ details: { kind: 'rule_threshold', metric } });
    expect(of('smsc.queued')).toBe('Capacity');
    expect(of('smsc.throughput.outbound')).toBe('Capacity');
    expect(of('smsc.bind.up')).toBe('Availability');
    expect(of('smsc.failed')).toBe('Delivery quality');
  });

  it('shows an unmapped kind verbatim rather than bucketing it', () => {
    // The fallback is the whole point: an unfamiliar word in the Category
    // column prompts someone to map it. A default bucket hides it instead.
    expect(alertCategory({ details: { kind: 'something_new' } })).toBe('something_new');
    expect(alertCategory({ details: { kind: 'rule_threshold', metric: 'custom.metric' } })).toBe(
      'custom.metric',
    );
    expect(alertCategory({})).toBe('uncategorised');
  });

  it('reads the backup namespace off the dedup key', () => {
    expect(alertCategory({ dedup_key: 'backup:failed:nightly' })).toBe('Infrastructure');
  });
});

describe('alertObject', () => {
  it('prefers details.smsc, which is the key the backend itself scopes on', () => {
    expect(alertObject({ details: { smsc: 'mtn-p1' }, dedup_key: 'rule:abc:smsc=other' })).toBe(
      'mtn-p1',
    );
  });

  it('takes the subject from the tail of every dedup namespace', () => {
    expect(alertObject({ dedup_key: 'engine:bind:local-fake-b' })).toBe('local-fake-b');
    expect(alertObject({ dedup_key: 'engine:bind-failures:local-fake' })).toBe('local-fake');
    expect(alertObject({ dedup_key: 'anomaly:volume_drop:mtn-p1' })).toBe('mtn-p1');
    expect(alertObject({ dedup_key: 'backup:degraded:nightly' })).toBe('nightly');
  });

  it('names the engine for the engine-wide alert, and the platform for none', () => {
    expect(alertObject({ dedup_key: 'engine:unreachable' })).toBe('the SMS engine');
    expect(alertObject({})).toBe('the platform');
  });
});

describe('alertDuration', () => {
  const opened = '2026-08-21T09:00:00.000Z';

  it('measures an open alert to now, so the column ages with the incident', () => {
    const now = Date.parse('2026-08-21T09:40:00.000Z');
    expect(alertDurationSeconds({ opened_at: opened }, now)).toBe(2400);
    expect(alertDuration({ opened_at: opened }, now)).toContain('40');
  });

  it('stops a resolved alert at its resolution, not at now', () => {
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    expect(
      alertDurationSeconds({ opened_at: opened, resolved_at: '2026-08-21T09:05:00.000Z' }, now),
    ).toBe(300);
  });

  it('is unknown, never 0s, when there is no opening timestamp', () => {
    // 0s would read as an incident that resolved instantly.
    expect(alertDurationSeconds({})).toBeNull();
    expect(alertDuration({})).toBe('unknown');
  });
});

describe('alertAcknowledgement', () => {
  it('says unacknowledged in words rather than leaving the cell blank', () => {
    // A blank cell on a grid where every other row has text reads as a bug.
    expect(alertAcknowledgement({})).toBe('unacknowledged');
  });

  it('carries who, when and the note', () => {
    const text = alertAcknowledgement({
      acknowledged_by: 'amina',
      acknowledged_at: '2026-08-21T09:02:00.000Z',
      acknowledgement_note: 'Carrier NOC engaged, ref INC-4471',
    });
    expect(text).toContain('amina');
    expect(text).toContain('Carrier NOC engaged, ref INC-4471');
  });
});

describe('occurrences and severity', () => {
  it('treats a first sighting as one occurrence, never zero', () => {
    expect(alertOccurrences({})).toBe(1);
    expect(alertOccurrences({ dedup_count: 0 })).toBe(1);
    expect(alertOccurrences({ dedup_count: 7 })).toBe(7);
  });

  it('does not quietly give an unrecognised severity an info tone', () => {
    expect(alertSeverityTone('critical')).toBe('bad');
    expect(alertSeverityTone('warning')).toBe('warn');
    expect(alertSeverityTone('info')).toBe('good');
    expect(alertSeverityTone('page-the-ceo')).toBe('muted');
  });
});
