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

const stubApi = () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/users/roles'))
      return apiResponse([
        {
          id: 'r1',
          name: 'administrator',
          description: 'Full platform access',
          user_count: 2,
          permissions: ['users.view', 'users.manage', 'smsc.view'],
        },
        {
          id: 'r2',
          name: 'auditor',
          description: 'Read-only audit access',
          user_count: 0,
          permissions: ['users.view'],
        },
      ]);
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

  it('states plainly that role definitions cannot be edited through the API', async () => {
    stubApi();
    const wrapper = await mountRoles();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="role-row-r1"]').exists()).toBe(true));
    const note = wrapper.get('[data-testid="roles-readonly-note"]').text();
    expect(note).toContain('GET /users/roles');
    expect(note).toContain('no endpoint to create a role');
    // No create/edit/delete affordance is offered anywhere on the screen.
    expect(wrapper.html()).not.toContain('data-testid="role-create"');
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
