import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionAdminRepository } from './session-admin.repository';
import { AuthenticatedRequest } from './auth.guard';

const request = {
  headers: {},
  principal: {
    tenantId: '7',
    userId: 'user-1',
    sessionId: 's',
    username: 'op',
    roles: [],
    permissions: ['users.sessions'],
  },
} as AuthenticatedRequest;

const UUID = '11111111-1111-4111-8111-111111111111';

describe('SessionsController', () => {
  it('lists sessions with parsed filters and pagination', async () => {
    const repo: any = { listSessions: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
    const controller = new SessionsController(repo);
    await controller.list(request, { userId: UUID, active: 'true', limit: '10', offset: '5' });
    expect(repo.listSessions).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      { userId: UUID, active: true, limit: 10, offset: 5 },
    );
  });
  it('defaults pagination and treats a missing active flag as false', async () => {
    const repo: any = { listSessions: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
    await new SessionsController(repo).list(request, {});
    expect(repo.listSessions).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      { userId: undefined, active: false, limit: 50, offset: 0 },
    );
  });
  it('rejects a non-UUID userId filter', () => {
    const controller = new SessionsController({} as any);
    expect(() => controller.list(request, { userId: 'not-a-uuid' })).toThrow(BadRequestException);
  });
  it('rejects a non-integer limit', () => {
    const controller = new SessionsController({} as any);
    expect(() => controller.list(request, { limit: 'lots' })).toThrow(BadRequestException);
  });
  it('rejects a non-UUID session id on revoke', () => {
    const controller = new SessionsController({} as any);
    expect(() => controller.revoke(request, 'nope')).toThrow(BadRequestException);
  });
  it('delegates a valid revoke', async () => {
    const repo: any = { revokeSession: jest.fn().mockResolvedValue({ id: UUID }) };
    await new SessionsController(repo).revoke(request, UUID);
    expect(repo.revokeSession).toHaveBeenCalledWith({ tenantId: '7', userId: 'user-1' }, UUID);
  });
});

describe('SessionAdminRepository', () => {
  function fakeDatabase(responses: Array<{ rows: any[] }>) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn((sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve(responses.shift() ?? { rows: [] });
      }),
    };
    const database: any = {
      tenantTransaction: jest.fn((_tenantId: string, work: (c: any) => Promise<unknown>) =>
        work(client),
      ),
    };
    return { database, queries };
  }

  it('scopes list queries to the tenant and returns a grid page', async () => {
    const { database, queries } = fakeDatabase([
      { rows: [{ id: 'a', user_id: 'u', username: 'op', __total: '3' }] },
    ]);
    const repo = new SessionAdminRepository(database);
    const page = await repo.listSessions(
      { tenantId: '7', userId: 'user-1' },
      { userId: 'u9', active: true, limit: 20, offset: 0 },
    );
    expect(database.tenantTransaction).toHaveBeenCalledWith('7', expect.any(Function));
    expect(page).toEqual({
      items: [{ id: 'a', user_id: 'u', username: 'op' }],
      total: 3,
      limit: 20,
      offset: 0,
    });
    expect(queries[0].sql).toContain('s.user_id=$1');
    expect(queries[0].sql).toContain('s.revoked_at IS NULL');
    expect(queries[0].params).toEqual(['u9', 20, 0]);
  });

  it('revokes a session and writes an audit row', async () => {
    const { database, queries } = fakeDatabase([
      { rows: [{ id: 's-1', user_id: 'u-1' }] },
      { rows: [{ id: 's-1', revoked_at: new Date() }] },
      { rows: [] },
    ]);
    const repo = new SessionAdminRepository(database);
    const result = await repo.revokeSession({ tenantId: '7', userId: 'admin' }, 's-1');
    expect(result.id).toBe('s-1');
    expect(queries[2].sql).toContain('INSERT INTO audit_log');
    expect(queries[2].params).toEqual(
      expect.arrayContaining(['7', 'admin', 'session.revoked', 'auth_session', 's-1']),
    );
  });

  it('throws when revoking a session that is not visible to the tenant', async () => {
    const { database } = fakeDatabase([{ rows: [] }]);
    const repo = new SessionAdminRepository(database);
    await expect(repo.revokeSession({ tenantId: '7', userId: 'admin' }, 's-x')).rejects.toThrow(
      NotFoundException,
    );
  });
});
