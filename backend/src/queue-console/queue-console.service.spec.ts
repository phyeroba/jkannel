import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueueConsoleService } from './queue-console.service';

const actor = { tenantId: '1', userId: 'u1' };

/** Both binds below are registered to tenant 1 on the live test bed. */
const TENANT_SMSCS = [
  { id: 'smsc-uuid-a', engine_id: 'local-fake', name: 'Fake A' },
  { id: 'smsc-uuid-b', engine_id: 'local-fake-b', name: 'Fake B' },
];

function makeDatabase(audits: any[][] = [], smscs = TENANT_SMSCS) {
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('smsc_definitions')) return { rows: smscs };
      if (sql.includes('INSERT INTO audit_log')) {
        audits.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return { tenantTransaction: (_t: string, work: any) => work(client) };
}

const availableSqlbox = (overrides: Record<string, any> = {}) => ({
  probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
  queueSummary: jest.fn(async () => ({ queued: 0, oldestEpoch: null })),
  spoolBySmsc: jest.fn(async () => []),
  listQueue: jest.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
  list: jest.fn(async () => ({ items: [], nextCursor: null })),
  deliveryStatusCounts: jest.fn(async () => ({})),
  rerouteSpool: jest.fn(async () => ({ rerouted: 0, sqlIds: [] })),
  cancelSpool: jest.fn(async () => ({ cancelled: 0, sqlIds: [] })),
  findSentForResend: jest.fn(async () => []),
  submit: jest.fn(async () => ({ sqlId: '900', status: 'queued', source: 'kamex-sqlbox' })),
  ...overrides,
});

const snapshotOf = (overrides: Record<string, any> = {}) => ({
  observedAt: '2026-08-04T00:00:00.000Z',
  engine: {
    status: 'running',
    version: '1.8.3',
    uptimeSeconds: 197,
    smsQueuedOut: 0,
    smsQueuedIn: 0,
    dlrQueued: 0,
    storeSize: null,
  },
  binds: [],
  source: { status: 'ok', detail: 'Parsed from Kamex bearerbox /status.json' },
  ...overrides,
});

const bindOf = (engineId: string) => ({
  engineId,
  name: `FAKE:${engineId}`,
  status: 'connecting',
  queued: 3,
  failed: 0,
  sent: 1,
  received: 0,
  outboundRate: [0, 0, 0],
  inboundRate: [0, 0, 0],
});

const historyRow = (overrides: Record<string, any> = {}) => ({
  id: '42',
  source: 'sent_sms',
  externalRef: 'ref-42',
  direction: 'MT',
  sender: 'SENDER',
  receiver: '+256700000000',
  text: 'hello world',
  smscId: 'local-fake',
  dlrMask: 31,
  dlrUrl: null,
  status: 'sent',
  deliveryStatus: 'failed',
  ...overrides,
});

function makeService(sqlbox: any, kamex: any = {}, engines: any = {}, audits: any[][] = []) {
  return new QueueConsoleService(
    makeDatabase(audits) as any,
    sqlbox as any,
    { queueSnapshot: jest.fn(async () => snapshotOf()), ...kamex } as any,
    engines as any,
  );
}

describe('QueueConsoleService.live', () => {
  it('omits engine-reported binds the tenant does not own', async () => {
    const kamex = {
      queueSnapshot: jest.fn(async () =>
        snapshotOf({
          binds: [bindOf('local-fake'), bindOf('someone-elses-bind'), bindOf('local-fake-b')],
        }),
      ),
    };
    const live = await makeService(availableSqlbox(), kamex).live(actor);

    expect(live.binds.map((bind) => bind.engineId)).toEqual(['local-fake', 'local-fake-b']);
    expect(live.binds.every((bind) => bind.known)).toBe(true);
    expect(live.binds[0].smscId).toBe('smsc-uuid-a');
    expect(live.binds[0].smscName).toBe('Fake A');
    expect(live.binds[1].smscId).toBe('smsc-uuid-b');
  });

  it('scopes the spool counts to the tenant engine ids', async () => {
    const sqlbox = availableSqlbox({
      queueSummary: jest.fn(async () => ({ queued: 4, oldestEpoch: 1_754_000_000 })),
      spoolBySmsc: jest.fn(async () => [{ smscId: 'local-fake', count: 4 }]),
    });
    const live = await makeService(sqlbox).live(actor);

    expect(sqlbox.queueSummary).toHaveBeenCalledWith(['local-fake', 'local-fake-b']);
    expect(sqlbox.spoolBySmsc).toHaveBeenCalledWith(['local-fake', 'local-fake-b']);
    expect(live.spool).toEqual({
      queued: 4,
      oldestEpoch: 1_754_000_000,
      bySmsc: [{ smscId: 'local-fake', count: 4 }],
    });
  });

  it('reports an unreachable engine through source instead of throwing, keeping spool data', async () => {
    const kamex = {
      queueSnapshot: jest.fn(async () =>
        snapshotOf({
          engine: { status: 'unknown', version: null, uptimeSeconds: null, storeSize: null },
          source: { status: 'unavailable', detail: 'Kamex status unavailable: ECONNREFUSED' },
        }),
      ),
    };
    const sqlbox = availableSqlbox({
      queueSummary: jest.fn(async () => ({ queued: 7, oldestEpoch: 1 })),
    });
    const live = await makeService(sqlbox, kamex).live(actor);

    expect(live.source.status).toBe('unavailable');
    expect(live.source.detail).toContain('ECONNREFUSED');
    expect(live.binds).toEqual([]);
    // Database-sourced figures survive an engine outage.
    expect(live.spool.queued).toBe(7);
  });

  it('degrades rather than fails when SQLBox is down but the engine is healthy', async () => {
    const sqlbox = availableSqlbox({
      probe: jest.fn(async () => ({ available: false, evidence: 'tables missing' })),
    });
    const kamex = {
      queueSnapshot: jest.fn(async () => snapshotOf({ binds: [bindOf('local-fake')] })),
    };
    const live = await makeService(sqlbox, kamex).live(actor);

    expect(live.source.status).toBe('degraded');
    expect(live.source.detail).toContain('tables missing');
    expect(live.spool).toEqual({ queued: 0, oldestEpoch: null, bySmsc: [] });
    expect(live.binds).toHaveLength(1);
  });
});

describe('QueueConsoleService.reroute', () => {
  it('passes the tenant scope predicate and reports partial matches as skipped', async () => {
    const sqlbox = availableSqlbox({
      rerouteSpool: jest.fn(async () => ({ rerouted: 2, sqlIds: [1, 3] })),
    });
    const audits: any[][] = [];
    const service = makeService(sqlbox, {}, {}, audits);
    const result = await service.reroute(actor, {
      sqlIds: [1, 2, 3],
      targetSmscId: 'local-fake-b',
    });

    expect(sqlbox.rerouteSpool).toHaveBeenCalledWith([1, 2, 3], 'local-fake-b', [
      'local-fake',
      'local-fake-b',
    ]);
    expect(result).toMatchObject({
      requested: 3,
      rerouted: 2,
      skipped: 1,
      targetSmscId: 'local-fake-b',
    });
    // The drained row is reported per-id with a machine-readable code.
    expect(result.results).toEqual([
      { sqlId: 1, rerouted: true },
      expect.objectContaining({ sqlId: 2, rerouted: false, code: 'SPOOL_ALREADY_DRAINED' }),
      { sqlId: 3, rerouted: true },
    ]);
    expect(audits[0][2]).toBe('queue.rerouted');
  });

  it('treats a fully drained batch as a normal result, not an error', async () => {
    const service = makeService(availableSqlbox());
    const result = await service.reroute(actor, { sqlIds: [9], targetSmscId: 'local-fake' });
    expect(result).toMatchObject({ requested: 1, rerouted: 0, skipped: 1 });
    expect(result.results[0]).toMatchObject({ code: 'SPOOL_ALREADY_DRAINED' });
  });

  it('rejects a target bind the tenant does not own', async () => {
    const sqlbox = availableSqlbox();
    const service = makeService(sqlbox);
    await expect(
      service.reroute(actor, { sqlIds: [1], targetSmscId: 'someone-elses-bind' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.rerouteSpool).not.toHaveBeenCalled();
  });

  it('fails cleanly when SQLBox is unavailable', async () => {
    const sqlbox = availableSqlbox({
      probe: jest.fn(async () => ({ available: false, evidence: 'not configured' })),
    });
    await expect(
      makeService(sqlbox).reroute(actor, { sqlIds: [1], targetSmscId: 'local-fake' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sqlbox.rerouteSpool).not.toHaveBeenCalled();
  });
});

describe('QueueConsoleService.cancel', () => {
  it('deletes within the tenant scope and reports the drain race per id', async () => {
    const sqlbox = availableSqlbox({
      cancelSpool: jest.fn(async () => ({ cancelled: 1, sqlIds: [5] })),
    });
    const audits: any[][] = [];
    const result = await makeService(sqlbox, {}, {}, audits).cancel(actor, [5, 6]);

    expect(sqlbox.cancelSpool).toHaveBeenCalledWith([5, 6], ['local-fake', 'local-fake-b']);
    expect(result).toMatchObject({ requested: 2, cancelled: 1, skipped: 1 });
    expect(result.results[1]).toMatchObject({ sqlId: 6, cancelled: false });
    expect(audits[0][2]).toBe('queue.cancelled');
  });
});

describe('QueueConsoleService.resend', () => {
  it('submits a new spool row against the target bind and audits it', async () => {
    const sqlbox = availableSqlbox({
      findSentForResend: jest.fn(async () => [historyRow()]),
    });
    const audits: any[][] = [];
    const result = await makeService(sqlbox, {}, {}, audits).resend(actor, {
      ids: ['42'],
      targetSmscId: 'local-fake-b',
    });

    expect(sqlbox.findSentForResend).toHaveBeenCalledWith(['42'], ['local-fake', 'local-fake-b']);
    expect(sqlbox.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'SENDER',
        receiver: '+256700000000',
        text: 'hello world',
        // resent onto the healthy bind, not the original one
        smscId: 'local-fake-b',
        dlrMask: 31,
      }),
    );
    // A fresh correlation id, so DLRs do not collide with the original.
    expect((sqlbox.submit.mock.calls[0] as any[])[0].foreignId).not.toBe('ref-42');
    expect(result).toMatchObject({ requested: 1, resent: 1, skipped: 0 });
    expect(result.results[0]).toMatchObject({ id: '42', sqlId: '900', originalStatus: 'failed' });
    expect(audits[0][2]).toBe('queue.resent');
  });

  it('writes the requested priority onto every new spool row, and null by default', async () => {
    // The value only matters under backlog — it orders bearerbox's per-SMSC
    // queue — but a replay is precisely how a backlog gets created, so an
    // operator needs to be able to put one behind (0) or ahead of (3) live
    // traffic.
    const withPriority = availableSqlbox({
      findSentForResend: jest.fn(async () => [historyRow()]),
    });
    const prioritised = await makeService(withPriority).resend(actor, {
      ids: ['42'],
      targetSmscId: 'local-fake-b',
      priority: 3,
    });
    expect(withPriority.submit).toHaveBeenCalledWith(expect.objectContaining({ priority: 3 }));
    expect(prioritised).toMatchObject({ priority: 3 });

    const plain = availableSqlbox({ findSentForResend: jest.fn(async () => [historyRow()]) });
    const unchanged = await makeService(plain).resend(actor, {
      ids: ['42'],
      targetSmscId: 'local-fake-b',
    });
    // Unset must behave exactly as it did before the field existed: NULL, which
    // the engine decodes as MSG_PARAM_UNDEFINED.
    expect(plain.submit).toHaveBeenCalledWith(expect.objectContaining({ priority: null }));
    expect(unchanged).toMatchObject({ priority: null });
  });

  it('refuses an out-of-range priority without spooling anything', async () => {
    const sqlbox = availableSqlbox({ findSentForResend: jest.fn(async () => [historyRow()]) });
    await expect(
      makeService(sqlbox).resend(actor, {
        ids: ['42'],
        targetSmscId: 'local-fake-b',
        priority: 9,
      }),
    ).rejects.toThrow(/between 0 and 3/);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('skips delivery reports with a reason instead of resending a receipt', async () => {
    const sqlbox = availableSqlbox({
      findSentForResend: jest.fn(async () => [
        historyRow({ id: '77', direction: 'DLR', externalRef: null, text: 'ACK/', dlrMask: 1 }),
      ]),
    });
    const result = await makeService(sqlbox).resend(actor, {
      ids: ['77'],
      targetSmscId: 'local-fake-b',
    });

    expect(sqlbox.submit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requested: 1, resent: 0, skipped: 1 });
    expect(result.results[0]).toMatchObject({ code: 'DELIVERY_REPORT_NOT_RESENDABLE' });
  });

  it('prefers the original message over its DLR when both share a foreign_id', async () => {
    const sqlbox = availableSqlbox({
      findSentForResend: jest.fn(async () => [
        historyRow({ id: '43', direction: 'DLR', externalRef: 'ref-42', text: 'ACK/' }),
        historyRow({ id: '42', externalRef: 'ref-42' }),
      ]),
    });
    await makeService(sqlbox).resend(actor, {
      ids: ['ref-42'],
      targetSmscId: 'local-fake-b',
    });
    expect(sqlbox.submit).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world' }));
  });

  it('reports ids outside the tenant scope as skipped without failing the batch', async () => {
    const sqlbox = availableSqlbox({
      findSentForResend: jest.fn(async () => [historyRow()]),
    });
    const result = await makeService(sqlbox).resend(actor, {
      ids: ['42', 'other-tenant-message'],
      targetSmscId: 'local-fake-b',
    });

    expect(result).toMatchObject({ requested: 2, resent: 1, skipped: 1 });
    expect(result.results[1]).toMatchObject({
      id: 'other-tenant-message',
      code: 'NOT_FOUND_OR_NOT_OWNED',
    });
  });

  it('keeps going when one submit fails', async () => {
    const submit = jest
      .fn()
      .mockRejectedValueOnce(new Error('spool insert failed'))
      .mockResolvedValueOnce({ sqlId: '901' });
    const sqlbox = availableSqlbox({
      findSentForResend: jest.fn(async () => [historyRow({ id: '1' }), historyRow({ id: '2' })]),
      submit,
    });
    const result = await makeService(sqlbox).resend(actor, {
      ids: ['1', '2'],
      targetSmscId: 'local-fake-b',
    });

    expect(result).toMatchObject({ requested: 2, resent: 1, skipped: 1 });
    expect(result.results[0]).toMatchObject({ code: 'SUBMIT_FAILED' });
    expect(result.results[1]).toMatchObject({ sqlId: '901' });
  });

  it('resends a filtered set, defaulting to the resendable failures', async () => {
    const sqlbox = availableSqlbox({
      list: jest.fn(async () => ({
        items: [historyRow({ id: '10' }), historyRow({ id: '11', deliveryStatus: 'rejected' })],
        nextCursor: null,
      })),
    });
    const result = await makeService(sqlbox).resend(actor, { targetSmscId: 'local-fake-b' });

    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resendable',
        excludeDlr: true,
        allowedSmscIds: ['local-fake', 'local-fake-b'],
      }),
    );
    expect(result).toMatchObject({ requested: 2, resent: 2, skipped: 0 });
    expect(result.appliedFilter).toMatchObject({ status: 'resendable' });
    expect(sqlbox.submit).toHaveBeenCalledTimes(2);
  });

  it('honours an explicit status filter and scopes it to the tenant', async () => {
    const sqlbox = availableSqlbox({
      list: jest.fn(async () => ({ items: [], nextCursor: null })),
    });
    const result = await makeService(sqlbox).resend(actor, {
      filter: { status: 'pending', smscId: 'local-fake' },
      targetSmscId: 'local-fake-b',
    });

    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        smscId: 'local-fake',
        allowedSmscIds: ['local-fake', 'local-fake-b'],
      }),
    );
    expect(result).toMatchObject({ requested: 0, resent: 0, skipped: 0 });
  });

  it('rejects a resend target the tenant does not own', async () => {
    const sqlbox = availableSqlbox();
    await expect(
      makeService(sqlbox).resend(actor, { ids: ['42'], targetSmscId: 'someone-elses-bind' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.findSentForResend).not.toHaveBeenCalled();
  });
});

describe('QueueConsoleService.history', () => {
  it('returns the classified log with counts, scoped to the tenant', async () => {
    const sqlbox = availableSqlbox({
      list: jest.fn(async () => ({ items: [historyRow()], nextCursor: 41 })),
      deliveryStatusCounts: jest.fn(async () => ({ failed: 2, rejected: 1, resendable: 3 })),
    });
    const history = await makeService(sqlbox).history(actor, { status: 'resendable' });

    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resendable',
        excludeDlr: true,
        allowedSmscIds: ['local-fake', 'local-fake-b'],
      }),
    );
    expect(sqlbox.deliveryStatusCounts).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSmscIds: ['local-fake', 'local-fake-b'] }),
    );
    expect(history).toMatchObject({
      total: 1,
      nextCursor: 41,
      counts: { resendable: 3 },
      appliedStatus: 'resendable',
    });
    expect(history.items[0].deliveryStatus).toBe('failed');
  });
});

describe('QueueConsoleService.spool and controlBind', () => {
  it('lists the spool restricted to the tenant engine ids', async () => {
    const sqlbox = availableSqlbox();
    await makeService(sqlbox).spool(actor, { limit: 25, smscId: 'local-fake' });
    expect(sqlbox.listQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        smscId: 'local-fake',
        allowedSmscIds: ['local-fake', 'local-fake-b'],
      }),
    );
  });

  it('disables a bind through the engine adapter and audits it', async () => {
    const controlSmsc = jest.fn(async () => ({
      operation: 'disable',
      engineId: 'local-fake',
      accepted: true,
      detail: "SMSC `local-fake' shut down",
      observedAt: '2026-08-04T00:00:00.000Z',
    }));
    const audits: any[][] = [];
    const engines = { smscControl: jest.fn(() => ({ controlSmsc })) };
    const result = await makeService(availableSqlbox(), {}, engines, audits).controlBind(
      actor,
      'local-fake',
      'disable',
    );

    expect(controlSmsc).toHaveBeenCalledWith('disable', 'local-fake');
    expect(result.detail).toContain('shut down');
    expect(audits[0][2]).toBe('queue.bind.disable');
  });

  it('refuses to control a bind the tenant does not own', async () => {
    const controlSmsc = jest.fn();
    const engines = { smscControl: jest.fn(() => ({ controlSmsc })) };
    await expect(
      makeService(availableSqlbox(), {}, engines).controlBind(
        actor,
        'someone-elses-bind',
        'disable',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(controlSmsc).not.toHaveBeenCalled();
  });
});
