import {
  ALERT_DEDUP_ESCALATION_SQL,
  AlertCorrelationService,
  isSeverityEscalation,
  readAlertUpsert,
  severityRank,
} from './alert-correlation.service';

const service = new AlertCorrelationService();

describe('AlertCorrelationService keys', () => {
  it('builds a stable dedup key from rule/smsc/kind', () => {
    expect(service.dedupKey({ ruleId: 'r1', smsc: 'carrier-a', kind: 'dlr_failure' })).toBe(
      'rule:r1:smsc:carrier-a:kind:dlr_failure',
    );
    expect(service.dedupKey({})).toBe('rule:-:smsc:-:kind:-');
  });

  it('derives a correlation group preferring smsc over rule', () => {
    expect(service.correlationGroupFor({ smsc: 'carrier-a', ruleId: 'r1' })).toBe('smsc:carrier-a');
    expect(service.correlationGroupFor({ ruleId: 'r1' })).toBe('rule:r1');
    expect(service.correlationGroupFor({})).toBeNull();
  });
});

describe('AlertCorrelationService.dedupeIfOpen', () => {
  it('increments dedup_count when an open alert with the same key exists', async () => {
    const updates: any[] = [];
    const client: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('SELECT id FROM alert_instances')) return { rows: [{ id: 'a1' }] };
        if (sql.includes('UPDATE alert_instances')) {
          updates.push(params);
          return { rows: [{ dedup_count: 3 }] };
        }
        return { rows: [] };
      }),
    };
    const result = await service.dedupeIfOpen(client, '1', 'rule:-:smsc:carrier-a:kind:x');
    expect(result).toEqual({ deduped: true, alertId: 'a1', dedupCount: 3 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(['1', 'a1']);
  });

  it('reports not deduped when no matching open alert exists', async () => {
    const client: any = { query: jest.fn(async () => ({ rows: [] })) };
    const result = await service.dedupeIfOpen(client, '1', 'rule:-:smsc:carrier-b:kind:x');
    expect(result).toEqual({ deduped: false });
  });
});

describe('alert dedup escalation (item 4)', () => {
  it('ranks severities so a worse observation is recognisable', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('warning'));
    expect(severityRank('warning')).toBeGreaterThan(severityRank('info'));
    expect(severityRank(undefined)).toBe(0);
    // The bind case the gap report calls out: connecting -> disconnected.
    expect(isSeverityEscalation('warning', 'critical')).toBe(true);
    expect(isSeverityEscalation('critical', 'warning')).toBe(false);
    expect(isSeverityEscalation('warning', 'warning')).toBe(false);
  });

  it('re-sharpens summary and severity only when the condition got worse', () => {
    // The upsert updates severity/summary...
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain('severity = EXCLUDED.severity');
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain('summary = EXCLUDED.summary');
    // ...records that it escalated, and keeps the old wording in details...
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain('previous_severity = alert_instances.severity');
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain('escalated_at = now()');
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain('escalatedFrom');
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain('dedup_count = alert_instances.dedup_count + 1');
    // ...but only when the new severity outranks the stored one, so a flapping
    // condition cannot rewrite the incident on every poll.
    expect(ALERT_DEDUP_ESCALATION_SQL).toMatch(/WHERE \(CASE EXCLUDED\.severity/);
  });

  it('opens a new notification cycle so the sharpened alert pages again', () => {
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain(
      'escalation_cycle = alert_instances.escalation_cycle + 1',
    );
    // A lifecycle-suppressed alert keeps its silence; anything else re-pages.
    expect(ALERT_DEDUP_ESCALATION_SQL).toContain("WHEN alert_instances.status = 'suppressed'");
  });

  it('distinguishes a new incident from a sharpened one', () => {
    expect(readAlertUpsert({ rows: [{ inserted: true, id: 'a1' }] })).toEqual({
      opened: true,
      escalated: false,
      alertId: 'a1',
    });
    expect(readAlertUpsert({ rows: [{ inserted: false, id: 'a1' }] })).toEqual({
      opened: false,
      escalated: true,
      alertId: 'a1',
    });
    // No row at all: the duplicate was correctly ignored.
    expect(readAlertUpsert({ rows: [] })).toEqual({ opened: false, escalated: false });
  });
});
