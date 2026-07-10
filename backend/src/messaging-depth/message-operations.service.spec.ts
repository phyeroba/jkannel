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
    const service = new MessageOperationsService(makeDatabase(audits) as any, sqlbox);
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
    const service = new MessageOperationsService(makeDatabase([]) as any, sqlbox);
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
    const service = new MessageOperationsService(makeDatabase(audits) as any, sqlbox);
    await service.requeue(actor, '42');
    expect(audits[0][2]).toBe('message.requeued');
  });

  it('throws 503 when SQLBox is unavailable', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: false, evidence: 'not configured' })),
      trace: jest.fn(),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(makeDatabase([]) as any, sqlbox);
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
    const service = new MessageOperationsService(makeDatabase([]) as any, sqlbox);
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(NotFoundException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('rejects a message whose SMSC the tenant does not own', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf({ smscId: 'carrier-x' })),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(makeDatabase([]) as any, sqlbox);
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });

  it('rejects a message with no SMSC assigned', async () => {
    const sqlbox: any = {
      probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
      trace: jest.fn(async () => traceOf({ smscId: null })),
      submit: jest.fn(),
    };
    const service = new MessageOperationsService(makeDatabase([]) as any, sqlbox);
    await expect(service.replay(actor, '42')).rejects.toBeInstanceOf(BadRequestException);
  });
});
