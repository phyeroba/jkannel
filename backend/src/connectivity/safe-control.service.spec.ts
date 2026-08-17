import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SafeControlService } from './safe-control.service';

function makeService(rows: Record<string, unknown>[] = []) {
  const sql: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      sql.push(text);
      if (text.includes('FROM smsc_definitions s') || text.includes('FROM routing_rules'))
        return { rows, rowCount: rows.length };
      if (text.startsWith('UPDATE smsc_definitions')) return { rows, rowCount: rows.length };
      if (text.startsWith('UPDATE route_failovers')) return { rows, rowCount: rows.length };
      if (text.startsWith('INSERT INTO route_failovers'))
        return { rows: [{ id: 'f1', started_at: 'now' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  const events: any = { recordOn: jest.fn(async () => undefined) };
  return { service: new SafeControlService(database, events), sql, client, events };
}

const actor = { tenantId: '1', userId: 'u1' };
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * §1.1 and §16: disruptive actions capture a reason, and it is what makes the
 * action explicable afterwards. Reading an audit trail that says a bind was
 * reconnected at 03:12 without saying why answers the wrong question.
 */
describe('SafeControlService.requireReason', () => {
  it('demands a reason for every disruptive operation', () => {
    for (const operation of ['reconnect', 'disable', 'suspend', 'resume', 'failover'])
      expect(() => SafeControlService.requireReason(operation, '')).toThrow(BadRequestException);
  });

  it('explains WHY the reason is needed rather than just rejecting', () => {
    try {
      SafeControlService.requireReason('suspend', '');
    } catch (error) {
      expect((error as Error).message).toMatch(/audit trail/);
    }
  });

  it('rejects a reason too short to mean anything', () => {
    expect(() => SafeControlService.requireReason('suspend', 'x')).toThrow(BadRequestException);
  });

  it('accepts and trims a real reason', () => {
    expect(SafeControlService.requireReason('suspend', '  carrier maintenance  ')).toBe(
      'carrier maintenance',
    );
  });

  it('does not demand one for a non-disruptive operation', () => {
    expect(() => SafeControlService.requireReason('enable', undefined)).not.toThrow();
  });
});

/**
 * UC-SMSC-01: "Confirmation dialog must show impact, not just 'Are you sure?'".
 * Impact is computed from CURRENT state — "this will drop 412 queued messages"
 * is an argument; "this may be disruptive" is noise an operator clicks through.
 */
describe('SafeControlService.describeImpact', () => {
  const smsc = (overrides: Record<string, unknown> = {}) => [
    {
      engine_id: 'mtn-p1',
      name: 'MTN Primary',
      enabled: true,
      connection_count: 1,
      traffic_suspended_at: null,
      state: 'bound',
      queued_count: 412,
      route_count: 2,
      ...overrides,
    },
  ];

  it('quantifies the queue a reconnect would disturb', async () => {
    const { service } = makeService(smsc());
    const impact = await service.describeImpact(actor, ID, 'reconnect');
    expect(impact.queuedMessages).toBe(412);
    expect(impact.consequences.join(' ')).toMatch(/412 message/);
    expect(impact.consequences.join(' ')).toMatch(/duplicates are possible/);
  });

  it('warns that parallel connections cycle together', async () => {
    // The engine cannot restart one of N sessions sharing an smsc-id.
    const { service } = makeService(smsc({ connection_count: 3 }));
    const impact = await service.describeImpact(actor, ID, 'reconnect');
    expect(impact.consequences.join(' ')).toMatch(/All 3 parallel connections/);
  });

  it('steers an operator from disable towards suspend', async () => {
    // Disable rewrites and redeploys the engine config; suspend does not.
    const { service } = makeService(smsc());
    const impact = await service.describeImpact(actor, ID, 'disable');
    expect(impact.consequences.join(' ')).toMatch(/suspend it instead/);
  });

  it('says suspension holds new submissions only', async () => {
    const { service } = makeService(smsc());
    const impact = await service.describeImpact(actor, ID, 'suspend');
    expect(impact.consequences.join(' ')).toMatch(/NEW submissions only/);
    expect(impact.consequences.join(' ')).toMatch(/bind stays connected/);
  });

  it('blocks a suspend that is already in effect', async () => {
    const { service } = makeService(smsc({ traffic_suspended_at: 'now' }));
    expect((await service.describeImpact(actor, ID, 'suspend')).blockedReason).toMatch(
      /already suspended/,
    );
  });

  it('blocks a resume on something that is not suspended', async () => {
    const { service } = makeService(smsc());
    expect((await service.describeImpact(actor, ID, 'resume')).blockedReason).toMatch(
      /not suspended/,
    );
  });

  it('404s for an unknown SMSC', async () => {
    const { service } = makeService([]);
    await expect(service.describeImpact(actor, ID, 'reconnect')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SafeControlService.setSuspended', () => {
  it('records an audit entry AND an event in the same transaction', async () => {
    const { service, sql, events } = makeService([
      { engine_id: 'mtn-p1', name: 'MTN Primary', traffic_suspended_at: 'now' },
    ]);
    await service.setSuspended(actor, ID, true, 'carrier maintenance window');
    expect(sql.some((text) => text.includes('INSERT INTO audit_log'))).toBe(true);
    expect(events.recordOn).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ kind: 'smsc.suspended', severity: 'warning' }),
    );
  });

  it('carries the reason into the event summary', async () => {
    const { service, events } = makeService([{ engine_id: 'mtn-p1', name: 'MTN Primary' }]);
    await service.setSuspended(actor, ID, false, 'maintenance complete');
    expect(events.recordOn.mock.calls[0][2].summary).toMatch(/maintenance complete/);
  });
});

describe('SafeControlService.failOver', () => {
  const route = { id: 'r1', name: 'Uganda MTN', target_smsc_id: ID };
  const target = {
    id: OTHER,
    engine_id: 'mtn-p2',
    name: 'MTN Secondary',
    traffic_suspended_at: null,
  };

  function failoverService() {
    const sql: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        sql.push(text);
        if (text.includes('FROM routing_rules')) return { rows: [route], rowCount: 1 };
        if (text.includes('FROM smsc_definitions s')) return { rows: [target], rowCount: 1 };
        if (text.startsWith('INSERT INTO route_failovers'))
          return { rows: [{ id: 'f1', started_at: 'now' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const events: any = { recordOn: jest.fn(async () => undefined) };
    return { service: new SafeControlService(database, events), sql, events, client };
  }

  it('closes any existing override before opening a new one', async () => {
    // Two active overrides would make "which target is live" ambiguous.
    const { service, sql } = failoverService();
    await service.failOver(actor, 'r1', OTHER, 'carrier asked us to move traffic');
    const closeIndex = sql.findIndex((text) => text.startsWith('UPDATE route_failovers'));
    const openIndex = sql.findIndex((text) => text.startsWith('INSERT INTO route_failovers'));
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(openIndex);
  });

  it('refuses a failover to the target already in use', async () => {
    const { service } = failoverService();
    await expect(service.failOver(actor, 'r1', ID, 'pointless')).rejects.toThrow(
      /already this route/,
    );
  });

  /** UC-RTE-02: block or strongly warn when the alternate is not usable. */
  it('refuses to move traffic onto a suspended SMSC', async () => {
    const client = {
      query: jest.fn(async (text: string) => {
        if (text.includes('FROM routing_rules')) return { rows: [route], rowCount: 1 };
        if (text.includes('FROM smsc_definitions s'))
          return { rows: [{ ...target, traffic_suspended_at: 'now' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
    const service = new SafeControlService(database, { recordOn: jest.fn() } as never);
    await expect(service.failOver(actor, 'r1', OTHER, 'move it')).rejects.toThrow(/is suspended/);
  });

  it('says the route configuration is unchanged, so the override is not read as a failure', async () => {
    const { service } = failoverService();
    const result = await service.failOver(actor, 'r1', OTHER, 'primary is flapping');
    expect(result.note).toMatch(/configured target is unchanged/);
    expect(result.note).toMatch(/reverted without editing the route/);
  });

  it('emits a warning-level event naming the reason', async () => {
    const { service, events } = failoverService();
    await service.failOver(actor, 'r1', OTHER, 'primary is flapping');
    expect(events.recordOn.mock.calls[0][2]).toMatchObject({
      kind: 'route.failover',
      severity: 'warning',
    });
    expect(events.recordOn.mock.calls[0][2].summary).toMatch(/primary is flapping/);
  });
});

describe('SafeControlService.revertFailover', () => {
  it('404s when there is no active override to revert', async () => {
    const { service } = makeService([]);
    await expect(service.revertFailover(actor, 'r1', 'done')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
