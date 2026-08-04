import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MessageOperationsService } from './message-operations.service';

const actor = { tenantId: '1', userId: 'u1' };

function makeDatabase(audits: any[][], smscIds = ['carrier-a']) {
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('smsc_definitions'))
        return { rows: smscIds.map((engine_id) => ({ engine_id })) };
      if (sql.includes('INSERT INTO audit_log')) {
        audits.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return { tenantTransaction: (_t: string, work: any) => work(client) };
}

/**
 * Stand-in for the real send path. Replay/clone/requeue now submit through
 * {@link MessageSendService} instead of poking SQLBox directly, so the fake
 * forwards to the same `sqlbox.submit` spy these tests already assert on and
 * returns the shape the service consumes.
 */
function makeSend(sqlbox: any, overrides: Record<string, unknown> = {}) {
  return {
    send: jest.fn(async (_actor: any, request: any) => {
      const queued = await sqlbox.submit({
        sender: request.sender,
        receiver: request.receiver,
        text: request.text,
        smscId: request.smscId,
        dlrMask: request.dlrMask,
        dlrUrl: request.dlrUrl,
        foreignId: request.foreignId,
      });
      return {
        ...queued,
        smscId: request.smscId,
        destination: request.receiver,
        routeId: null,
        routeName: null,
        strategy: null,
        fallbackUsed: false,
        outcome: 'explicit',
        reason: 'explicit smscId supplied by the caller (replay)',
        decisionId: 'decision-1',
        customerId: null,
        charged: 0,
        ...overrides,
      };
    }),
  };
}

function traceOf(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    events: [
      {
        id: '42',
        source: 'sent_sms',
        direction: 'MT',
        sender: 'SENDER',
        receiver: '+256700000000',
        text: 'hello world',
        smscId: 'carrier-a',
        dlrMask: 31,
        dlrUrl: null,
        externalRef: 'orig-ref',
        status: 'sent',
        ...overrides,
      },
    ],
    summary: {},
  };
}

describe('MessageOperationsService', () => {
  it('replays an identical message and audits it', async () => {
    const audits: any[][] = [];
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf()),
      submit: jest.fn(async () => ({ sqlId: '999', status: 'queued', source: 'kamex-sqlbox' })),
    };
    const service = new MessageOperationsService(
      makeDatabase(audits) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    const result = await service.replay(actor, '42');

    expect(sqlbox.trace).toHaveBeenCalledWith('42', ['carrier-a']);
    expect(sqlbox.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'SENDER',
        receiver: '+256700000000',
        text: 'hello world',
        smscId: 'carrier-a',
      }),
    );
    expect(result.action).toBe('replayed');
    expect(result.queued.sqlId).toBe('999');
    // audit row: action is message.replayed
    expect(audits).toHaveLength(1);
    expect(audits[0][2]).toBe('message.replayed');
  });

  it('applies overrides on clone', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf()),
      submit: jest.fn(async () => ({ sqlId: '1000', status: 'queued', source: 'kamex-sqlbox' })),
    };
    const service = new MessageOperationsService(
      makeDatabase([]) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    const result = await service.clone(actor, '42', {
      receiver: '+256711111111',
      text: 'new body',
    });

    expect(sqlbox.submit).toHaveBeenCalledWith(
      expect.objectContaining({ receiver: '+256711111111', text: 'new body', sender: 'SENDER' }),
    );
    expect(result.action).toBe('cloned');
  });

  it('records requeue distinctly in the audit trail', async () => {
    const audits: any[][] = [];
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf()),
      submit: jest.fn(async () => ({ sqlId: '2', status: 'queued', source: 'kamex-sqlbox' })),
    };
    const service = new MessageOperationsService(
      makeDatabase(audits) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    await service.requeue(actor, '42');
    expect(audits[0][2]).toBe('message.requeued');
  });

  it('throws 503 when SQLBox is unavailable', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: false, evidence: 'not configured' })),
      trace: jest.fn(),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(
      makeDatabase([]) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('throws 404 when the message is not in the tenant scope', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      // trace returns no events for a message the tenant does not own
      trace: jest.fn(async () => ({ id: '42', events: [], summary: {} })),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(
      makeDatabase([]) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(NotFoundException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('rejects a message whose SMSC the tenant does not own', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf({ smscId: 'carrier-x' })),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(
      makeDatabase([]) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('lets the send path re-route a replay off a dead bind', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf()),
      submit: jest.fn(async () => ({ sqlId: '999', status: 'queued', source: 'kamex-sqlbox' })),
    };
    // The send path reports it moved the message to a healthy bind.
    const send = makeSend(sqlbox, { smscId: 'carrier-b', outcome: 'rerouted' });
    const service = new MessageOperationsService(makeDatabase([]) as any, sqlbox, send as any);
    const result = await service.replay(actor, '42');

    // The request asks for the reroute; the original bind is still offered.
    expect(send.send).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        smscId: 'carrier-a',
        rerouteIfUnavailable: true,
        channel: 'replay',
      }),
    );
    expect(result.submission.smscId).toBe('carrier-b');
  });

  it('rejects a message with no SMSC assigned', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf({ smscId: null })),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(
      makeDatabase([]) as any,
      sqlbox,
      makeSend(sqlbox) as any,
    );
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(BadRequestException);
  });
});
