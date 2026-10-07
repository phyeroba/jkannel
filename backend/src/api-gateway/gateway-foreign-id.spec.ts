import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

/**
 * The pre-retry duplicate check (CPaaS integration item 11).
 *
 * THE FIRST VERSION OF THIS FILTERED `foreign_id` AND COULD NEVER MATCH.
 * `sqlbox_pgsql` stamps that column itself — the originating
 * `send_sms.sql_id` on an MT row, the SMSC's own message id on a DLR row —
 * so a caller's id is never in it. Verified on production: zero rows out of
 * the whole table contained one, including rows for messages that had
 * definitely been accepted.
 *
 * The caller's id is resolved to engine ids first, from
 * `message_route_decisions`. What is guarded here is the restriction that
 * survives: the page must be limited to the resolved engine ids, as a bound
 * parameter, and still inside the tenant's SMSC scope.
 */
describe('GET /gateway/messages — the engine-id restriction', () => {
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

  it('restricts to the resolved engine ids, as a bound parameter', async () => {
    const { repository, calls } = captureSql();
    await repository.list({ sqlIds: ['44', '45'], limit: 10 });
    const { sql, params } = calls[0];
    expect(sql).toContain('foreign_id = ANY($');
    // Never a LIKE: this answers "did my message get in", and a prefix match
    // could answer it with a different message.
    expect(sql).not.toMatch(/foreign_id\s+LIKE/i);
    expect(params).toContainEqual(['44', '45']);
  });

  it('does not restrict when no id was asked for', async () => {
    const { repository, calls } = captureSql();
    await repository.list({ limit: 10 });
    expect(calls[0].sql).not.toContain('foreign_id = ANY($');
  });

  it('an id that resolved to nothing returns nothing, not everything', async () => {
    // The distinction that matters: `undefined` means "no filter" and `[]`
    // means "asked, and nothing matched". Collapsing them would answer
    // "never submitted" with the whole register.
    const { repository, calls } = captureSql();
    await repository.list({ sqlIds: [], limit: 10 });
    expect(calls[0].sql).toContain('foreign_id = ANY($');
    expect(calls[0].params).toContainEqual([]);
  });

  it('keeps the tenant SMSC scope alongside it', async () => {
    const { repository, calls } = captureSql();
    await repository.list({ sqlIds: ['44'], allowedSmscIds: ['kololo'], limit: 10 });
    const { sql } = calls[0];
    expect(sql).toContain('smsc_id = ANY($');
    expect(sql).toContain('foreign_id = ANY($');
  });
});
