import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

/**
 * The pre-retry duplicate check (CPaaS integration item 11).
 *
 * A caller that did not get a response to a submit cannot tell whether the
 * message was accepted, and retrying blind is how a recipient gets the same
 * SMS twice. CPaaS asked for this on `GET /gateway/messages` and sends its
 * own id as `foreignId`.
 *
 * What is guarded here is the part that is easy to get wrong: the filter must
 * be an EXACT match on `foreign_id`, it must be parameterised, and it must
 * still be subject to the tenant's SMSC scope — otherwise an unknown id would
 * confirm that somebody else had sent it.
 */
describe('GET /gateway/messages?foreignId=', () => {
  function captureSql() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const repository = new KamexSqlboxRepository();
    (repository as any).pool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    };
    return { repository, calls };
  }

  it('filters on foreign_id exactly, as a bound parameter', async () => {
    const { repository, calls } = captureSql();
    await repository.list({ foreignId: 'msg_01M48KWNE350HA79V3FDV5X25X', limit: 10 });
    const { sql, params } = calls[0];
    expect(sql).toContain('foreign_id = $');
    // Never a LIKE: this answers "did my message get in", and a prefix match
    // could answer it with a different message.
    expect(sql).not.toMatch(/foreign_id\s+LIKE/i);
    expect(params).toContain('msg_01M48KWNE350HA79V3FDV5X25X');
  });

  it('does not filter when no foreignId is given', async () => {
    const { repository, calls } = captureSql();
    await repository.list({ limit: 10 });
    expect(calls[0].sql).not.toContain('foreign_id = $');
  });

  it('keeps the tenant SMSC scope alongside it', async () => {
    const { repository, calls } = captureSql();
    await repository.list({ foreignId: 'msg_x', allowedSmscIds: ['kololo'], limit: 10 });
    const { sql } = calls[0];
    expect(sql).toContain('smsc_id = ANY($');
    expect(sql).toContain('foreign_id = $');
  });
});
