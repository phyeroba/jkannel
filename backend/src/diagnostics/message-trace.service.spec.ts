import { MessageTraceService } from './message-trace.service';

function makeService(options: { engineIds?: string[]; sqlboxAvailable?: boolean } = {}) {
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT engine_id FROM smsc_definitions'))
        return { rows: (options.engineIds ?? ['mtn-p1']).map((engine_id) => ({ engine_id })) };
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  const traceCalls: Array<{ id: string; allowed: string[] | undefined }> = [];
  const sqlbox: any = {
    probe: jest.fn(async () => ({ available: options.sqlboxAvailable ?? true, evidence: 'ok' })),
    trace: jest.fn(async (id: string, allowed?: string[]) => {
      traceCalls.push({ id, allowed });
      return { events: [] };
    }),
  };
  return { service: new MessageTraceService(database, sqlbox), traceCalls, sqlbox };
}

const actor = { tenantId: '1', userId: 'u1' };

/**
 * The first cut of this service took `allowedSmscIds` as an optional parameter
 * and the controller did not pass one — so a tenant restricted to a subset of
 * SMSCs could read the engine trace of a message on ANY SMSC. An optional
 * security parameter is one that will eventually be omitted, so the service now
 * resolves its own scope and there is no argument to forget.
 */
describe('MessageTraceService — tenant scoping', () => {
  it('always filters the engine trace to the tenant’s own SMSCs', async () => {
    const { service, traceCalls } = makeService({ engineIds: ['mtn-p1', 'mtn-p2'] });
    await service.trace(actor, 'msg-1');
    expect(traceCalls).toHaveLength(1);
    expect(traceCalls[0].allowed).toEqual(['mtn-p1', 'mtn-p2']);
  });

  it('passes an empty scope rather than undefined for a tenant owning nothing', async () => {
    // undefined means "no filter" to the repository, so an empty tenant must
    // send [] — the difference between seeing nothing and seeing everything.
    const { service, traceCalls } = makeService({ engineIds: [] });
    await service.trace(actor, 'msg-1');
    expect(traceCalls[0].allowed).toEqual([]);
  });

  it('takes no caller-supplied scope argument at all', () => {
    // Guards the shape, not just this call: re-adding an optional override
    // would reintroduce the way the bypass happened.
    expect(MessageTraceService.prototype.trace.length).toBe(2);
  });

  it('still returns an assembled result when SQLBox is unavailable', async () => {
    const { service } = makeService({ sqlboxAvailable: false });
    const result = await service.trace(actor, 'msg-1');
    expect(result.available).toBe(false);
    expect(result.lifecycle.stages).toEqual([]);
  });
});
