import { AlertCorrelationService } from './alert-correlation.service';

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
