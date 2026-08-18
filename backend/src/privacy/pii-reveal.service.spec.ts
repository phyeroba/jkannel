import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PiiRevealService } from './pii-reveal.service';

/**
 * A fake client that records every statement, so the tests can assert on what
 * was actually sent to PostgreSQL rather than on a mock's return value.
 */
class FakeClient {
  readonly statements: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly responder: (sql: string) => any = () => ({ rows: [], rowCount: 0 })) {}
  query(sql: string, params: unknown[] = []) {
    this.statements.push({ sql, params });
    return Promise.resolve(this.responder(sql));
  }
  find(fragment: string) {
    return this.statements.filter((s) => s.sql.includes(fragment));
  }
}

const database = (client: FakeClient) => ({
  tenantTransaction: (_tenantId: string, work: (c: any) => Promise<any>) => work(client),
});

const GRANT_ROW = {
  id: 'g-1',
  reason: 'ticket 4412: customer says the OTP never arrived',
  scope_message_ref: null,
  granted_at: '2026-08-18T09:00:00.000Z',
  expires_at: '2026-08-18T09:15:00.000Z',
  reveal_count: 0,
};

const ACTOR = { tenantId: '1', userId: 'u-1' };

describe('PiiRevealService.grant', () => {
  it('refuses a grant with no usable reason', async () => {
    const client = new FakeClient();
    const service = new PiiRevealService(database(client) as any);
    await expect(service.grant(ACTOR, { reason: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.grant(ACTOR, { reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    // Nothing reached the database: a rejected request must not leave a grant.
    expect(client.statements).toHaveLength(0);
  });

  it('records the reason on the grant AND in the audit log', async () => {
    const client = new FakeClient(() => ({ rows: [GRANT_ROW], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    const grant = await service.grant(ACTOR, { reason: GRANT_ROW.reason });

    expect(grant.id).toBe('g-1');
    const insert = client.find('INSERT INTO pii_reveal_grants')[0];
    expect(insert.params).toContain(GRANT_ROW.reason);
    const audit = client.find("'pii.reveal.granted'")[0];
    expect(audit).toBeDefined();
    expect(audit.params).toContain(GRANT_ROW.reason);
  });

  it('caps the window, so a typo cannot buy a day of access', async () => {
    const client = new FakeClient(() => ({ rows: [GRANT_ROW], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    await service.grant(ACTOR, { reason: 'investigating', minutes: 100000 });
    const insert = client.find('INSERT INTO pii_reveal_grants')[0];
    expect(insert.params[4]).toBe('60');
  });

  it('floors a fractional window rather than passing it to the interval cast', async () => {
    const client = new FakeClient(() => ({ rows: [GRANT_ROW], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    await service.grant(ACTOR, { reason: 'investigating', minutes: 7.9 });
    expect(client.find('INSERT INTO pii_reveal_grants')[0].params[4]).toBe('7');
  });

  it('defaults to fifteen minutes', async () => {
    const client = new FakeClient(() => ({ rows: [GRANT_ROW], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    await service.grant(ACTOR, { reason: 'investigating' });
    expect(client.find('INSERT INTO pii_reveal_grants')[0].params[4]).toBe('15');
  });
});

describe('PiiRevealService.activeGrant', () => {
  it('asks the database to exclude revoked and expired grants', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const service = new PiiRevealService(database(client) as any);
    await service.activeGrant(ACTOR);
    const sql = client.statements[0].sql;
    // Expiry is evaluated by PostgreSQL's clock, not the backend's: two servers
    // whose clocks disagree must not disagree about whether a window is open.
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).toContain('expires_at > now()');
  });

  it('returns null when nothing is live, without throwing', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const service = new PiiRevealService(database(client) as any);
    await expect(service.activeGrant(ACTOR)).resolves.toBeNull();
  });
});

describe('PiiRevealService.resolve', () => {
  const permissions = new Set(['messages.view', 'messages.reveal']);

  it('does not touch the database when the caller did not ask to reveal', async () => {
    const client = new FakeClient();
    const service = new PiiRevealService(database(client) as any);
    const result = await service.resolve(ACTOR, permissions, false);
    expect(result).toEqual({ permitted: false, grant: null, refusal: null });
    expect(client.statements).toHaveLength(0);
  });

  it('refuses a caller without the permission', async () => {
    const service = new PiiRevealService(database(new FakeClient()) as any);
    await expect(
      service.resolve(ACTOR, new Set(['messages.view']), true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a caller who holds the permission but has no live window', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const service = new PiiRevealService(database(client) as any);
    const result = await service.resolve(ACTOR, permissions, true);
    // The permission alone is deliberately not enough. If it were, the time
    // limit would be decorative and the audit would have nothing to attach to.
    expect(result.permitted).toBe(false);
    expect(result.refusal).toContain('POST /privacy/reveal');
  });

  it('permits only when both the permission and a live grant are present', async () => {
    const client = new FakeClient(() => ({ rows: [GRANT_ROW], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    const result = await service.resolve(ACTOR, permissions, true);
    expect(result.permitted).toBe(true);
    expect(result.grant?.id).toBe('g-1');
  });

  it('honours a grant narrowed to one message only for that message', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const service = new PiiRevealService(database(client) as any);
    await service.resolve(ACTOR, permissions, true, 'msg-77');
    const select = client.statements[0];
    expect(select.sql).toContain('scope_message_ref IS NULL OR scope_message_ref = $2');
    expect(select.params[1]).toBe('msg-77');
  });
});

describe('PiiRevealService.recordUse', () => {
  it('counts the use and writes an audit row carrying the row count', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    await service.recordUse(ACTOR, 'g-1', 4000, 'messages.export');

    expect(client.find('reveal_count = reveal_count + 1')).toHaveLength(1);
    const audit = client.find("'pii.revealed'")[0];
    // Four thousand numbers leaving in a spreadsheet and one number read on
    // screen are different events; the count is what tells them apart.
    expect(JSON.parse(String(audit.params[3]))).toEqual({
      rowCount: 4000,
      context: 'messages.export',
    });
  });
});

describe('PiiRevealService.revoke', () => {
  it('audits a revocation that actually changed a row', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    await expect(service.revoke(ACTOR, 'g-1')).resolves.toEqual({ revoked: true });
    expect(client.find("'pii.reveal.revoked'")).toHaveLength(1);
  });

  it('does not audit a revocation of something already revoked', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const service = new PiiRevealService(database(client) as any);
    await expect(service.revoke(ACTOR, 'g-1')).resolves.toEqual({ revoked: false });
    expect(client.find("'pii.reveal.revoked'")).toHaveLength(0);
  });

  it('sets revoked_at instead of deleting, so the trail survives', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 1 }));
    const service = new PiiRevealService(database(client) as any);
    await service.revoke(ACTOR, 'g-1');
    const update = client.statements[0].sql;
    expect(update).toContain('SET revoked_at = now()');
    expect(update).not.toMatch(/DELETE/i);
  });

  it('will not let one operator revoke another operator’s grant', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const service = new PiiRevealService(database(client) as any);
    await service.revoke(ACTOR, 'g-1');
    expect(client.statements[0].sql).toContain('user_id = $2');
    expect(client.statements[0].params[1]).toBe('u-1');
  });
});
