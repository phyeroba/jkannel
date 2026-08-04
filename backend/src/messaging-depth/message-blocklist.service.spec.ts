import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MessageBlocklistService } from './message-blocklist.service';

const actor = { tenantId: '1', userId: 'u1' };

type Entry = { list_type: string; msisdn: string; reason?: string | null };

function makeService(entries: Entry[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM messaging_blocklist')) {
        const destination = params[0] as string;
        // Mirrors the service's own predicate: the destination's own entries,
        // plus every whitelist entry in scope.
        return {
          rows: entries
            .filter((e) => e.msisdn === destination || e.list_type === 'whitelist')
            .map((e) => ({ ...e, reason: e.reason ?? null })),
        };
      }
      if (sql.includes('FROM customers')) return { rows: [{ id: 'cust-1' }] };
      if (sql.startsWith('INSERT INTO messaging_blocklist'))
        return { rows: [{ id: 'entry-1', msisdn: params[3], list_type: params[2] }] };
      if (sql.startsWith('DELETE FROM messaging_blocklist'))
        return { rows: [{ id: 'entry-1', msisdn: '256700000000', list_type: 'blacklist' }] };
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return { service: new MessageBlocklistService(database), client, calls };
}

describe('MessageBlocklistService', () => {
  it('allows a destination that is on no list', async () => {
    const { service } = makeService([]);
    expect(await service.evaluate(actor, '+256700000000')).toMatchObject({
      allowed: true,
      listType: null,
    });
  });

  it('refuses a blacklisted destination and reports the recorded reason', async () => {
    const { service } = makeService([
      { list_type: 'blacklist', msisdn: '256700000000', reason: 'fraud complaint' },
    ]);
    expect(await service.evaluate(actor, '+256700000000')).toMatchObject({
      allowed: false,
      listType: 'blacklist',
      reason: 'fraud complaint',
    });
  });

  it('matches a blacklist entry however the caller formatted the number', async () => {
    for (const form of ['+256700000000', '00256700000000', '256 700 000 000']) {
      const { service } = makeService([{ list_type: 'blacklist', msisdn: '256700000000' }]);
      expect((await service.evaluate(actor, form)).allowed).toBe(false);
    }
  });

  it('refuses a DND registration ahead of anything else', async () => {
    const { service } = makeService([
      { list_type: 'dnd', msisdn: '256700000000' },
      { list_type: 'blacklist', msisdn: '256700000000' },
    ]);
    expect((await service.evaluate(actor, '+256700000000')).listType).toBe('dnd');
  });

  it('closes the list when any whitelist entry is in scope', async () => {
    const { service } = makeService([{ list_type: 'whitelist', msisdn: '256711111111' }]);
    const blocked = await service.evaluate(actor, '+256700000000');
    expect(blocked.allowed).toBe(false);
    expect(blocked.listType).toBe('whitelist');

    const { service: permitted } = makeService([
      { list_type: 'whitelist', msisdn: '256711111111' },
    ]);
    expect((await permitted.evaluate(actor, '+256711111111')).allowed).toBe(true);
  });

  it('throws a Forbidden (a policy refusal, never a 500) from the send-path assert', async () => {
    const { service, client } = makeService([{ list_type: 'blacklist', msisdn: '256700000000' }]);
    await expect(
      service.assertAllowedInClient(client as never, '256700000000', null),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unusable address rather than storing it', async () => {
    const { service } = makeService([]);
    await expect(
      service.add(actor, { listType: 'blacklist', msisdn: 'not-a-number' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalises the address before storing it and audits the addition', async () => {
    const { service, calls } = makeService([]);
    await service.add(actor, { listType: 'blacklist', msisdn: '+256 700-000 000', reason: 'spam' });
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO messaging_blocklist'))!;
    expect(insert.params[3]).toBe('256700000000');
    expect(calls.some((c) => c.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });
});
