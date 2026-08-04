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

describe('AlertEscalationService.routeToTarget', () => {
  const service = makeService();
  const channel = (over: Partial<any> = {}): any => ({
    id: 'c1',
    name: 'Ops email',
    type: 'email',
    enabled: true,
    severities: [],
    config: { to: 'l1@example.com' },
    ...over,
  });

  it('reports none when the tenant has no channel of that type', () => {
    expect(service.routeToTarget([], steps[0])).toEqual({ resolution: 'none' });
  });

  it('matches the channel whose address equals the step target', () => {
    const l1 = channel();
    const manager = channel({
      id: 'c2',
      name: 'Duty manager',
      config: { to: 'manager@example.com' },
    });
    const routed = service.routeToTarget([l1, manager], {
      afterMinutes: 15,
      channelType: 'email',
      target: 'manager@example.com',
    });
    // Previously every step delivered to the first channel; the later step now
    // reaches the person the policy actually names.
    expect(routed.resolution).toBe('target-match');
    expect(routed.channel?.id).toBe('c2');
  });

  it('matches on channel name and id as well as transport address', () => {
    const l1 = channel();
    expect(service.routeToTarget([l1], { ...steps[0], target: 'Ops email' }).resolution).toBe(
      'target-match',
    );
    expect(service.routeToTarget([l1], { ...steps[0], target: 'c1' }).resolution).toBe(
      'target-match',
    );
  });

  it('overrides the address when a single channel exists and the target names no channel', () => {
    const routed = service.routeToTarget([channel()], {
      afterMinutes: 15,
      channelType: 'email',
      target: 'oncall@example.com',
    });
    expect(routed.resolution).toBe('target-override');
    expect(routed.channel?.config.to).toBe('oncall@example.com');
  });

  it('falls back to the first channel and says so when the target cannot be honoured', () => {
    const routed = service.routeToTarget([channel(), channel({ id: 'c2' })], {
      afterMinutes: 15,
      channelType: 'email',
      target: 'nobody@example.com',
    });
    expect(routed.resolution).toBe('type-default');
    expect(routed.channel?.id).toBe('c1');
  });

  it('uses the first channel when the step names no target at all', () => {
    expect(
      service.routeToTarget([channel()], { afterMinutes: 1, channelType: 'email', target: '' })
        .resolution,
    ).toBe('type-default');
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

  it('delivers step 1 to the channel the step targets, not the first one', async () => {
    const inserts: any[] = [];
    // 12 minutes open: step 0 (5m) already recorded, so step 1 (sms, +100) is due.
    const openedAt = new Date(Date.now() - 12 * 60_000).toISOString();
    const client: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('FROM escalation_policies')) return { rows: [{ id: 'p1', steps }] };
        if (sql.startsWith('SELECT id, opened_at'))
          return { rows: [{ id: 'a1', opened_at: openedAt, details: {}, rule_id: null }] };
        if (sql.includes('FROM maintenance_windows')) return { rows: [] };
        if (sql.includes('max(step_index)')) return { rows: [{ max: 0 }] };
        if (sql.includes('FROM notification_channels'))
          return {
            rows: [
              {
                id: 'c1',
                name: 'Primary SMS',
                type: 'sms',
                enabled: true,
                severities: [],
                config: { msisdn: '+999' },
              },
              {
                id: 'c2',
                name: 'Escalation SMS',
                type: 'sms',
                enabled: true,
                severities: [],
                config: { msisdn: '+100' },
              },
            ],
          };
        if (sql.startsWith('SELECT summary,status,severity'))
          return { rows: [{ summary: 'Bind down', status: 'open', severity: 'critical' }] };
        if (sql.includes('INSERT INTO alert_escalations')) {
          inserts.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const delivered: any[] = [];
    const notifications: any = {
      deliver: jest.fn(async (_alert: any, channel: any) => {
        delivered.push(channel);
        return {
          channelId: channel.id,
          channelType: channel.type,
          status: 'succeeded',
          response: {},
        };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const service = new AlertEscalationService(
      database,
      new MaintenanceWindowService(),
      notifications,
    );
    await service.runForTenant('1', new Date());

    expect(delivered).toHaveLength(1);
    expect(delivered[0].id).toBe('c2');
    const detail = JSON.parse(inserts[0][5]);
    expect(detail.targetResolution).toBe('target-match');
    expect(inserts[0][4]).toBe('notified');
  });
});
