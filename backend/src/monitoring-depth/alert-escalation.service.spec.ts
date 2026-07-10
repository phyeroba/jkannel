import { AlertEscalationService } from './alert-escalation.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { EscalationStep } from './monitoring-depth.repository';

function makeService(): AlertEscalationService {
  return new AlertEscalationService({} as any, new MaintenanceWindowService());
}

const steps: EscalationStep[] = [
  { afterMinutes: 5, channelType: 'email', target: 'l1@example.com' },
  { afterMinutes: 10, channelType: 'sms', target: '+100' },
  { afterMinutes: 15, channelType: 'webhook', target: 'https://hook' },
];

describe('AlertEscalationService.nextDueStep', () => {
  const service = makeService();
  const opened = new Date('2026-07-10T00:00:00Z');

  it('returns no step before the first threshold elapses', () => {
    const now = new Date('2026-07-10T00:03:00Z'); // 3 min
    expect(service.nextDueStep(steps, opened, now, null)).toBeNull();
  });

  it('advances to step 0 once afterMinutes elapses', () => {
    const now = new Date('2026-07-10T00:06:00Z'); // 6 min
    expect(service.nextDueStep(steps, opened, now, null)).toEqual({
      stepIndex: 0,
      step: steps[0],
    });
  });

  it('advances one step at a time', () => {
    const now = new Date('2026-07-10T00:20:00Z'); // 20 min, all thresholds passed
    // With step 0 already recorded, the next due is step 1 (not the last one).
    expect(service.nextDueStep(steps, opened, now, 0)).toEqual({ stepIndex: 1, step: steps[1] });
    // With step 1 recorded, step 2 is due.
    expect(service.nextDueStep(steps, opened, now, 1)).toEqual({ stepIndex: 2, step: steps[2] });
  });

  it('does not advance when the next step is not yet due', () => {
    const now = new Date('2026-07-10T00:08:00Z'); // 8 min: step 1 (10m) not yet due
    expect(service.nextDueStep(steps, opened, now, 0)).toBeNull();
  });

  it('returns null when the chain is exhausted', () => {
    const now = new Date('2026-07-10T01:00:00Z');
    expect(service.nextDueStep(steps, opened, now, 2)).toBeNull();
  });
});

describe('AlertEscalationService.runForTenant', () => {
  it('records the due step and skips the advisory lock when unavailable', async () => {
    const inserts: any[] = [];
    const openedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const client: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('FROM escalation_policies')) return { rows: [{ id: 'p1', steps }] };
        if (sql.startsWith('SELECT id, opened_at'))
          return { rows: [{ id: 'a1', opened_at: openedAt, details: {}, rule_id: null }] };
        if (sql.includes('FROM maintenance_windows')) return { rows: [] };
        if (sql.includes('max(step_index)')) return { rows: [{ max: null }] };
        if (sql.includes('INSERT INTO alert_escalations')) {
          inserts.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const service = new AlertEscalationService(database, new MaintenanceWindowService());
    const recorded = await service.runForTenant('1', new Date());
    expect(recorded).toBe(1);
    expect(inserts).toHaveLength(1);
    // params: tenantId, alertId, policyId, stepIndex, status, detail
    expect(inserts[0][3]).toBe(0);
    expect(inserts[0][4]).toBe('escalated');
  });

  it('records suppressed when an active maintenance window covers the smsc', async () => {
    const inserts: any[] = [];
    const openedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const now = new Date();
    const client: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('FROM escalation_policies')) return { rows: [{ id: 'p1', steps }] };
        if (sql.startsWith('SELECT id, opened_at'))
          return {
            rows: [
              { id: 'a1', opened_at: openedAt, details: { smsc: 'carrier-a' }, rule_id: null },
            ],
          };
        if (sql.includes('FROM maintenance_windows'))
          return {
            rows: [
              {
                id: 'w1',
                name: 'planned',
                starts_at: new Date(now.getTime() - 3600_000).toISOString(),
                ends_at: new Date(now.getTime() + 3600_000).toISOString(),
                scope: { smscs: ['carrier-a'] },
              },
            ],
          };
        if (sql.includes('max(step_index)')) return { rows: [{ max: null }] };
        if (sql.includes('INSERT INTO alert_escalations')) {
          inserts.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const service = new AlertEscalationService(database, new MaintenanceWindowService());
    await service.runForTenant('1', now);
    expect(inserts[0][4]).toBe('suppressed');
  });
});
