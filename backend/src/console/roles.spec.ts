import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ConsoleRepository } from './console.repository';
import { UsersController } from './console.controllers';

/**
 * Role and permission administration — the surface that did not exist before
 * (gap G11): `GET /users/roles` was the only role endpoint and it was read-only,
 * so an operator could never create a role or change what one grants.
 *
 * The repository half is exercised against a scripted PoolClient rather than a
 * jest.fn repository, because the invariants worth pinning here are in the SQL
 * flow itself: which statements run, in what order, inside one transaction.
 */
const ADMIN_HOLDERS = 1;

interface Script {
  roles: Array<{
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    userCount: number;
    permissions: string[];
  }>;
  catalogue: Array<{ id: string; code: string }>;
  /** How many users hold users.manage; consulted before and after a mutation. */
  administrators: number[];
}

class FakeClient {
  statements: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly script: Script) {}
  private nextAdministrators(): number {
    return this.script.administrators.length > 1
      ? this.script.administrators.shift()!
      : this.script.administrators[0];
  }
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    this.statements.push({ sql, params });
    if (sql.startsWith('SELECT set_config') || sql === 'BEGIN' || sql === 'COMMIT')
      return { rows: [], rowCount: 0 };
    if (sql.includes('FROM permissions WHERE code = ANY')) {
      const wanted = params[0] as string[];
      return {
        rows: this.script.catalogue.filter((row) => wanted.includes(row.code)),
        rowCount: 0,
      };
    }
    if (sql.includes('count(DISTINCT ur.user_id)'))
      return { rows: [{ count: this.nextAdministrators() }], rowCount: 1 };
    if (sql.includes('FROM roles r')) {
      const id = params[0] as string | undefined;
      const rows = id ? this.script.roles.filter((role) => role.id === id) : this.script.roles;
      return { rows: rows.map((role) => ({ ...role })), rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO roles')) {
      const name = params[1] as string;
      if (this.script.roles.some((role) => role.name === name)) {
        const error = new Error('duplicate key') as Error & { code?: string };
        error.code = '23505';
        throw error;
      }
      const created = {
        id: 'role-new',
        name,
        description: (params[2] as string | null) ?? null,
        isSystem: false,
        userCount: 0,
        permissions: [] as string[],
      };
      this.script.roles.push(created);
      return { rows: [{ id: created.id }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE roles SET name=')) {
      const role = this.script.roles.find((entry) => entry.id === params[0]);
      if (role) {
        if (params[1]) role.name = params[1] as string;
        if (params[2]) role.description = params[2] as string;
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM role_permissions')) {
      const role = this.script.roles.find((entry) => entry.id === params[0]);
      if (role) role.permissions = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('INSERT INTO role_permissions')) {
      const role = this.script.roles.find((entry) => entry.id === params[1]);
      const code = this.script.catalogue.find((entry) => entry.id === params[2])?.code;
      if (role && code) role.permissions = [...role.permissions, code].sort();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM roles')) {
      this.script.roles = this.script.roles.filter((role) => role.id !== params[0]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const actor = { tenantId: '7', userId: 'user-1' };

function build(overrides: Partial<Script> = {}) {
  const script: Script = {
    roles: [
      {
        id: 'role-sys',
        name: 'Read Only',
        description: 'seeded',
        isSystem: true,
        userCount: 0,
        permissions: ['dashboard.view'],
      },
      {
        id: 'role-custom',
        name: 'Night Shift',
        description: null,
        isSystem: false,
        userCount: 0,
        permissions: ['dashboard.view'],
      },
      {
        id: 'role-busy',
        name: 'In Use',
        description: null,
        isSystem: false,
        userCount: 3,
        permissions: [],
      },
    ],
    catalogue: [
      { id: 'p1', code: 'dashboard.view' },
      { id: 'p2', code: 'messages.view' },
      { id: 'p3', code: 'users.manage' },
    ],
    administrators: [ADMIN_HOLDERS],
    ...overrides,
  };
  const client = new FakeClient(script);
  const database: any = {
    tenantTransaction: (_tenantId: string, work: (c: PoolClient) => Promise<unknown>) =>
      work(client as unknown as PoolClient),
  };
  return { repository: new ConsoleRepository(database), script, client };
}

describe('role administration repository', () => {
  it('creates a role with its permission set and audits the creation', async () => {
    const { repository, client } = build();
    const created = await repository.createRole(actor, {
      name: 'Night Owl',
      description: 'after hours',
      permissions: ['dashboard.view', 'messages.view'],
    });
    expect(created).toMatchObject({ name: 'Night Owl', isSystem: false });
    expect(created.permissions).toEqual(['dashboard.view', 'messages.view']);
    const audit = client.statements.find((s) => s.sql.includes('INSERT INTO audit_log'));
    expect(audit?.params[2]).toBe('role.created');
  });

  it('rejects a duplicate role name with 409', async () => {
    const { repository } = build();
    await expect(
      repository.createRole(actor, { name: 'Night Shift', permissions: [] }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects unknown permission codes with a 400 that names them', async () => {
    const { repository, client } = build();
    await expect(
      repository.createRole(actor, {
        name: 'Bogus',
        permissions: ['dashboard.view', 'nope.invented', 'also.fake'],
      }),
    ).rejects.toThrow(
      new BadRequestException('Unknown permission code(s): also.fake, nope.invented'),
    );
    // Nothing was written: the catalogue check runs before the INSERT.
    expect(client.statements.some((s) => s.sql.startsWith('INSERT INTO roles'))).toBe(false);
  });

  it('replaces the whole permission set on PATCH and revokes affected sessions', async () => {
    const { repository, client } = build();
    const updated = await repository.updateRole(actor, 'role-custom', {
      permissions: ['messages.view'],
    });
    expect(updated.permissions).toEqual(['messages.view']);
    expect(client.statements.some((s) => s.sql.startsWith('DELETE FROM role_permissions'))).toBe(
      true,
    );
    expect(
      client.statements.some((s) => s.sql.includes('UPDATE auth_sessions SET revoked_at')),
    ).toBe(true);
  });

  it('lets a system role be re-permissioned but not renamed', async () => {
    const { repository } = build();
    await expect(
      repository.updateRole(actor, 'role-sys', { permissions: ['messages.view'] }),
    ).resolves.toMatchObject({ permissions: ['messages.view'] });
    await expect(repository.updateRole(actor, 'role-sys', { name: 'Renamed' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuses to delete a system role', async () => {
    const { repository } = build();
    await expect(repository.deleteRole(actor, 'role-sys')).rejects.toThrow(ConflictException);
  });

  it('refuses to delete a role that is still assigned to users', async () => {
    const { repository } = build();
    await expect(repository.deleteRole(actor, 'role-busy')).rejects.toThrow(
      /assigned to 3 user\(s\)/,
    );
  });

  it('deletes an unused custom role', async () => {
    const { repository, script, client } = build();
    await expect(repository.deleteRole(actor, 'role-custom')).resolves.toEqual({
      id: 'role-custom',
      deleted: true,
    });
    expect(script.roles.map((role) => role.id)).toEqual(['role-sys', 'role-busy']);
    const audit = client.statements.find(
      (s) => s.sql.includes('INSERT INTO audit_log') && s.params[2] === 'role.deleted',
    );
    expect(audit).toBeDefined();
  });

  it('404s on an unknown role', async () => {
    const { repository } = build();
    await expect(repository.getRole(actor, 'role-ghost')).rejects.toThrow(NotFoundException);
  });

  // Fail closed: a permission edit must never be able to strip the last account
  // that can administer roles, because there would then be no way back.
  it('refuses a change that would leave nobody holding users.manage', async () => {
    const { repository } = build({ administrators: [1, 0] });
    await expect(
      repository.updateRole(actor, 'role-custom', { permissions: ['dashboard.view'] }),
    ).rejects.toThrow(/users\.manage/);
  });

  it('allows the same change in a tenant that never had an administrator', async () => {
    const { repository } = build({ administrators: [0, 0] });
    await expect(
      repository.updateRole(actor, 'role-custom', { permissions: ['dashboard.view'] }),
    ).resolves.toBeDefined();
  });
});

describe('role administration controller', () => {
  const repository: any = {
    listRoles: jest.fn(),
    listPermissions: jest.fn(),
    getRole: jest.fn(),
    createRole: jest.fn(),
    updateRole: jest.fn(),
    deleteRole: jest.fn(),
  };
  const request: any = { principal: { tenantId: '7', userId: 'user-1' } };
  const validUuid = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => jest.clearAllMocks());

  it('passes a validated create through to the repository', () => {
    void new UsersController(repository).createRole(request, {
      name: 'Night Owl',
      description: 'after hours',
      permissions: ['dashboard.view'],
    });
    expect(repository.createRole).toHaveBeenCalledWith(actor, {
      name: 'Night Owl',
      description: 'after hours',
      permissions: ['dashboard.view'],
    });
  });

  it('requires a name', () => {
    expect(() => new UsersController(repository).createRole(request, { permissions: [] })).toThrow(
      BadRequestException,
    );
  });

  it('requires permissions to be an array on create', () => {
    expect(() => new UsersController(repository).createRole(request, { name: 'X Team' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a malformed permission code before it reaches the database', () => {
    expect(() =>
      new UsersController(repository).createRole(request, {
        name: 'X Team',
        permissions: ['NotAPermission'],
      }),
    ).toThrow(BadRequestException);
    expect(repository.createRole).not.toHaveBeenCalled();
  });

  it('rejects a role name with unusable characters', () => {
    expect(() =>
      new UsersController(repository).createRole(request, {
        name: '<script>alert(1)</script>',
        permissions: [],
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects an empty PATCH', () => {
    expect(() => new UsersController(repository).updateRole(request, validUuid, {})).toThrow(
      BadRequestException,
    );
  });

  it('forwards a permission replacement on PATCH', () => {
    void new UsersController(repository).updateRole(request, validUuid, {
      permissions: ['dashboard.view', 'messages.view'],
      reason: 'least privilege',
    });
    expect(repository.updateRole).toHaveBeenCalledWith(actor, validUuid, {
      permissions: ['dashboard.view', 'messages.view'],
      reason: 'least privilege',
    });
  });

  it('accepts an empty permission array as "revoke everything"', () => {
    void new UsersController(repository).updateRole(request, validUuid, { permissions: [] });
    expect(repository.updateRole).toHaveBeenCalledWith(actor, validUuid, {
      permissions: [],
      reason: undefined,
    });
  });

  it('rejects a non-UUID role id', () => {
    expect(() => new UsersController(repository).deleteRole(request, 'not-a-uuid')).toThrow(
      BadRequestException,
    );
  });

  it('exposes the permission catalogue', () => {
    void new UsersController(repository).permissions(request);
    expect(repository.listPermissions).toHaveBeenCalledWith(actor);
  });
});
