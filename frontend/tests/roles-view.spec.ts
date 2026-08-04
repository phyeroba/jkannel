import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roles: ['administrator'],
    permissions: new Set(['users.view', 'users.manage', 'messages.send']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import RolesView from '../src/views/RolesView.vue';

const apiResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const mountRoles = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/roles', name: 'roles', component: RolesView, meta: { title: 'Roles' } },
      { path: '/users', name: 'users', component: RolesView, meta: { title: 'Users' } },
    ],
  });
  await router.push('/roles');
  await router.isReady();
  return mount(RolesView, { global: { plugins: [router] } });
};

const ROLES = [
  {
    id: 'r1',
    name: 'administrator',
    description: 'Full platform access',
    isSystem: true,
    userCount: 2,
    permissions: ['users.view', 'users.manage', 'smsc.view'],
  },
  {
    id: 'r2',
    name: 'auditor',
    description: 'Read-only audit access',
    isSystem: false,
    userCount: 0,
    permissions: ['users.view'],
  },
];

const CATALOGUE = [
  { code: 'users.view', description: 'Read users and roles', category: 'users' },
  { code: 'users.manage', description: 'Create and edit users and roles', category: 'users' },
  { code: 'smsc.view', description: 'Read SMSC connections', category: 'smsc' },
  { code: 'smsc.manage', description: 'Change SMSC connections', category: 'smsc' },
];

const stubApi = (overrides: (url: string, init?: RequestInit) => unknown = () => undefined) => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const override = overrides(url, init);
    if (override !== undefined) return override;
    if (url.includes('/users/permissions')) return apiResponse(CATALOGUE);
    if (url.includes('/users/roles')) return apiResponse(ROLES);
    if (url.includes('/users'))
      return apiResponse({
        items: [
          { id: 'u1', username: 'amina', status: 'active', roles: ['administrator'] },
          { id: 'u2', username: 'joel', status: 'active', roles: ['administrator'] },
        ],
        total: 2,
      });
    return apiResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const conflict = (message: string) =>
  Promise.resolve(new Response(JSON.stringify({ success: false, message }), { status: 409 }));

describe('Roles & permissions view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists roles with their grants and the users who actually hold them', async () => {
    stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    const admin = wrapper.get('[data-testid="role-row-r1"]').text();
    expect(admin).toContain('administrator');
    expect(admin).toContain('3 granted');
    expect(admin).toContain('users.manage');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="role-row-r1"]').text()).toContain('amina, joel'),
    );
    expect(wrapper.get('[data-testid="role-row-r2"]').text()).toContain('nobody holds this role');
    wrapper.unmount();
  });

  it('builds a grouped permission matrix and filters it', async () => {
    stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="permission-row-smsc.view"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="permission-group-users"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="permission-group-smsc"]').exists()).toBe(true);
    // administrator grants users.manage; auditor does not.
    expect(
      wrapper.get('[data-testid="permission-cell-administrator-users.manage"]').text(),
    ).toContain('granted');
    expect(wrapper.get('[data-testid="permission-cell-auditor-users.manage"]').text()).toBe('—');

    await wrapper.get('[data-testid="permission-filter"]').setValue('smsc');
    expect(wrapper.find('[data-testid="permission-row-users.manage"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="permission-row-smsc.view"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('flags a held permission that no role in the catalogue grants', async () => {
    stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="permission-row-smsc.view"]').exists()).toBe(true),
    );
    // messages.send is on the session but on no role — exactly the seeding gap.
    expect(wrapper.get('[data-testid="permission-orphans"]').text()).toContain('messages.send');
    wrapper.unmount();
  });

  it('shows isSystem and userCount, and blocks the deletes the API would refuse', async () => {
    stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    // administrator: system role, 2 holders -> delete disabled twice over.
    expect(wrapper.find('[data-testid="role-system-r1"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="role-user-count-r1"]').text()).toBe('2');
    expect(wrapper.get('[data-testid="role-delete-r1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="role-delete-blocked-r1"]').text()).toContain(
      'system role cannot be deleted',
    );
    // auditor: ordinary role with nobody holding it -> deletable.
    expect(wrapper.find('[data-testid="role-system-r2"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="role-delete-r2"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="role-delete-blocked-r2"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('creates a role with permissions picked from the catalogue, grouped by category', async () => {
    const fetchMock = stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));

    await wrapper.get('[data-testid="role-create"]').trigger('click');
    // Grouping comes from the catalogue's own `category`, not the code prefix.
    expect(wrapper.find('[data-testid="role-permission-group-users"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="role-permission-group-smsc"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="role-permission-smsc.manage"]').text()).toContain(
      'Change SMSC connections',
    );

    await wrapper.get('[data-testid="role-name"]').setValue('noc-operator');
    await wrapper.get('[data-testid="role-description"]').setValue('Day shift');
    await wrapper.get('[data-testid="role-permission-smsc.view"] input').setValue(true);
    await wrapper.get('[data-testid="role-save"]').trigger('click');

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (entry) =>
          String(entry[0]).includes('/users/roles') &&
          (entry[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      expect(body).toEqual({
        name: 'noc-operator',
        description: 'Day shift',
        permissions: ['smsc.view'],
      });
    });
    wrapper.unmount();
  });

  it('edits a system role without sending a rename, and sends the whole replacement set', async () => {
    const fetchMock = stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));

    await wrapper.get('[data-testid="role-edit-r1"]').trigger('click');
    expect(wrapper.get('[data-testid="role-form-system-note"]').text()).toContain(
      'refuses a rename',
    );
    expect(wrapper.get('[data-testid="role-name"]').attributes('disabled')).toBeDefined();
    // Untick smsc.view: PATCH replaces the whole set, so it must be absent.
    await wrapper.get('[data-testid="role-permission-smsc.view"] input').setValue(false);
    expect(wrapper.get('[data-testid="role-permission-diff"]').text()).toContain('smsc.view');
    await wrapper.get('[data-testid="role-save"]').trigger('click');

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (entry) => (entry[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      expect(body.name).toBeUndefined();
      expect(body.permissions).toEqual(['users.view', 'users.manage']);
    });
    wrapper.unmount();
  });

  it('warns before a change that would leave nobody holding users.manage', async () => {
    stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    await wrapper.get('[data-testid="role-edit-r1"]').trigger('click');
    expect(wrapper.find('[data-testid="role-admin-warning"]').exists()).toBe(false);
    await wrapper.get('[data-testid="role-permission-users.manage"] input').setValue(false);
    expect(wrapper.get('[data-testid="role-admin-warning"]').text()).toContain('users.manage');
    wrapper.unmount();
  });

  it('surfaces the API 409 verbatim instead of a generic save failure', async () => {
    stubApi((url, init) =>
      init?.method === 'PATCH'
        ? conflict(
            'That change would leave no user holding users.manage; role administration would become impossible',
          )
        : undefined,
    );
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    await wrapper.get('[data-testid="role-edit-r1"]').trigger('click');
    await wrapper.get('[data-testid="role-save"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="role-form-error"]').text()).toContain(
        'no user holding users.manage',
      ),
    );
    wrapper.unmount();
  });

  it('says so when the permission catalogue endpoint is absent, rather than inventing one', async () => {
    stubApi((url) =>
      url.includes('/users/permissions')
        ? Promise.resolve(
            new Response(JSON.stringify({ success: false, message: 'Not found' }), { status: 404 }),
          )
        : undefined,
    );
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    await wrapper.get('[data-testid="role-create"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="permission-catalogue-error"]').text()).toContain(
        'GET /users/permissions',
      ),
    );
    // It falls back to the codes roles advertise, and never claims more.
    expect(wrapper.find('[data-testid="role-permission-smsc.view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="role-permission-smsc.manage"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('hides every mutation control from an operator without users.manage', async () => {
    stubApi();
    // The shared session mock holds users.manage; strip it for this case only.
    const store = await import('../src/stores/session');
    const original = store.session.value;
    (store.session as { value: unknown }).value = {
      displayName: 'Read Only',
      roles: ['auditor'],
      permissions: new Set(['users.view']),
    };
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="role-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="role-edit-r1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="role-delete-r1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="roles-readonly"]').text()).toContain('users.manage');
    (store.session as { value: unknown }).value = original;
    wrapper.unmount();
  });

  it('reports an absent roles endpoint instead of an empty catalogue', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ success: false, message: 'Not found' }), { status: 404 }),
          ),
        ),
    );
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="roles-error"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="roles-error"]').text()).toContain('not available');
    wrapper.unmount();
  });
});
