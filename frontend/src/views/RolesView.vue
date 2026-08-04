<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'ok' | 'error';

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
function isMissing(reason: unknown) {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map(String).filter(Boolean) : [];
}

const canManageUsers = computed(() => canAccess(session.value, 'users.manage'));
const myPermissions = computed(() => [...(session.value?.permissions ?? new Set<string>())].sort());
const myRoles = computed(() => [...(session.value?.roles ?? [])]);

// --- Roles -------------------------------------------------------------------
const roles = ref<RecordValue[]>([]);
const roleState = ref<LoadState>('loading');
const roleError = ref('');
const roleMissing = ref(false);

async function loadRoles() {
  roleState.value = 'loading';
  roleMissing.value = false;
  try {
    roles.value = asItems(await apiRequest<unknown>('/users/roles'));
    roleError.value = '';
    roleState.value = 'ok';
  } catch (reason) {
    roles.value = [];
    roleMissing.value = isMissing(reason);
    roleError.value = messageFrom(reason, 'Roles could not be loaded.');
    roleState.value = 'error';
  }
}

// --- Users, so each role shows who actually holds it -------------------------
const users = ref<RecordValue[]>([]);
const userState = ref<LoadState>('loading');
const userError = ref('');

async function loadUsers() {
  userState.value = 'loading';
  try {
    users.value = asItems(await apiRequest<unknown>('/users?limit=500&offset=0'));
    userError.value = '';
    userState.value = 'ok';
  } catch (reason) {
    users.value = [];
    userError.value = messageFrom(reason, 'Users could not be loaded.');
    userState.value = 'error';
  }
}

/** role name (lower-cased) -> usernames holding it, from the users grid. */
const holdersByRole = computed(() => {
  const holders = new Map<string, string[]>();
  for (const user of users.value) {
    const username = text(user.username, text(user.id, ''));
    for (const role of stringsOf(user.roles)) {
      const key = role.toLowerCase();
      holders.set(key, [...(holders.get(key) ?? []), username]);
    }
  }
  return holders;
});
function holdersOf(role: RecordValue): string[] {
  return holdersByRole.value.get(text(role.name, '').toLowerCase()) ?? [];
}

// --- Permission matrix --------------------------------------------------------
const permissionCodes = computed(() => {
  const codes = new Set<string>();
  for (const role of roles.value) for (const code of stringsOf(role.permissions)) codes.add(code);
  // Permissions the signed-in principal holds but no role advertises would be
  // invisible otherwise; showing them keeps the matrix honest about coverage.
  for (const code of myPermissions.value) codes.add(code);
  return [...codes].sort();
});
/** Grouped by the part before the dot ("smsc.view" -> "smsc"), as the API names them. */
const permissionGroups = computed(() => {
  const groups = new Map<string, string[]>();
  for (const code of permissionCodes.value) {
    const group = code.includes('.') ? code.slice(0, code.indexOf('.')) : 'other';
    groups.set(group, [...(groups.get(group) ?? []), code]);
  }
  return [...groups.entries()].map(([name, codes]) => ({ name, codes }));
});
function roleHas(role: RecordValue, code: string): boolean {
  return stringsOf(role.permissions).includes(code);
}
const orphanCodes = computed(() =>
  permissionCodes.value.filter((code) => !roles.value.some((role) => roleHas(role, code))),
);

const filter = ref('');
const filteredGroups = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return permissionGroups.value;
  return permissionGroups.value
    .map((group) => ({
      name: group.name,
      codes: group.codes.filter((code) => code.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.codes.length);
});

onMounted(() => {
  void loadRoles();
  void loadUsers();
});
</script>

<template>
  <div data-testid="roles-view">
    <!--
      Honesty note, not a placeholder: GET /users/roles is the only roles
      endpoint the API exposes. There is no POST/PATCH/DELETE for roles and no
      role_permissions mutation route, so this screen deliberately shows the
      real grants read-only rather than offering controls that would 404.
    -->
    <p class="warn-notice" data-testid="roles-readonly-note">
      Role definitions are read-only in this deployment. The API exposes
      <span class="mono">GET /users/roles</span> only — there is no endpoint to create a role,
      rename one, or change which permissions it grants, so no editing controls are offered here.
      Assigning an <em>existing</em> role to a person is supported and is done from
      <RouterLink class="text-link" to="/users">Users &amp; Roles</RouterLink>.
    </p>

    <!-- Roles ----------------------------------------------------------------- -->
    <section class="panel" data-testid="roles-panel" aria-label="Roles">
      <header class="panel-header">
        <div>
          <h2>Roles</h2>
          <p aria-live="polite">
            {{ roleState === 'loading' ? 'Loading roles…' : `${roles.length} role(s) defined` }}
          </p>
        </div>
        <button class="secondary-button" data-testid="roles-refresh" @click="loadRoles">
          Refresh
        </button>
      </header>
      <p v-if="roleState === 'error'" class="chart-empty" role="alert" data-testid="roles-error">
        {{ roleMissing ? 'The roles API is not available in this deployment.' : roleError }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Description</th>
              <th scope="col">Permissions</th>
              <th scope="col">Users</th>
              <th scope="col">Members</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="role in roles"
              :key="text(role.id)"
              :data-testid="`role-row-${text(role.id)}`"
            >
              <td>
                <strong>{{ text(role.name) }}</strong>
                <small class="row-id mono">{{ text(role.id) }}</small>
              </td>
              <td>{{ text(role.description) }}</td>
              <td>
                <span class="status-badge">{{ stringsOf(role.permissions).length }} granted</span>
                <div class="chip-list">
                  <span v-for="code in stringsOf(role.permissions)" :key="code" class="chip mono">
                    {{ code }}
                  </span>
                  <span v-if="!stringsOf(role.permissions).length" class="chip muted">
                    no permissions granted
                  </span>
                </div>
              </td>
              <td class="mono">{{ text(role.user_count ?? role.userCount, '0') }}</td>
              <td>
                <span v-if="userState === 'error'" class="cell-health">{{ userError }}</span>
                <span v-else-if="userState === 'loading'" class="cell-health">loading…</span>
                <span v-else-if="holdersOf(role).length" class="mono">
                  {{ holdersOf(role).join(', ') }}
                </span>
                <span v-else class="cell-health">nobody holds this role</span>
              </td>
            </tr>
            <tr v-if="roleState === 'ok' && !roles.length">
              <td colspan="5" class="empty-cell" data-testid="roles-empty">
                No roles are defined. Nobody can be granted anything until a role exists.
              </td>
            </tr>
            <tr v-if="roleState === 'loading'">
              <td colspan="5" class="empty-cell">Loading roles…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="canManageUsers" class="source-note">
        You hold users.manage, so you can assign these roles to a person from the Users &amp; Roles
        workspace.
      </p>
    </section>

    <!-- Permission matrix ------------------------------------------------------ -->
    <section class="panel" data-testid="permission-matrix-panel" aria-label="Permission matrix">
      <header class="panel-header">
        <div>
          <h2>Permission matrix</h2>
          <p>Every permission code any role grants, against the roles that grant it.</p>
        </div>
      </header>
      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Filter permissions</span>
          <input
            v-model="filter"
            data-testid="permission-filter"
            type="search"
            placeholder="smsc, messages.send, …"
          />
        </label>
      </div>
      <p
        v-if="orphanCodes.length"
        class="warn-notice"
        role="status"
        data-testid="permission-orphans"
      >
        {{ orphanCodes.length }} permission(s) you currently hold are granted by no role in this
        list: <span class="mono">{{ orphanCodes.join(', ') }}</span
        >. They were granted outside the role catalogue, or the catalogue is incomplete.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              <th v-for="role in roles" :key="text(role.id)" scope="col">{{ text(role.name) }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="group in filteredGroups" :key="group.name">
              <tr :data-testid="`permission-group-${group.name}`">
                <th :colspan="roles.length + 1" scope="colgroup">{{ group.name }}</th>
              </tr>
              <tr v-for="code in group.codes" :key="code" :data-testid="`permission-row-${code}`">
                <td class="mono">{{ code }}</td>
                <td
                  v-for="role in roles"
                  :key="`${text(role.id)}-${code}`"
                  :data-testid="`permission-cell-${text(role.name)}-${code}`"
                >
                  <span v-if="roleHas(role, code)" class="status-badge good">granted</span>
                  <span v-else class="cell-health">—</span>
                </td>
              </tr>
            </template>
            <tr v-if="!filteredGroups.length">
              <td :colspan="roles.length + 1" class="empty-cell" data-testid="permission-empty">
                {{
                  roleState === 'loading'
                    ? 'Loading permissions…'
                    : 'No permission codes match this filter.'
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Effective access for the signed-in operator ---------------------------- -->
    <section class="panel" data-testid="my-access-panel" aria-label="Your effective access">
      <header class="panel-header">
        <div>
          <h2>Your effective access</h2>
          <p>What this session is actually allowed to do, as the API resolved it at sign-in.</p>
        </div>
      </header>
      <div class="chip-list" data-testid="my-roles">
        <span v-for="role in myRoles" :key="role" class="chip">{{ role }}</span>
        <span v-if="!myRoles.length" class="chip muted">no roles</span>
      </div>
      <div class="chip-list" data-testid="my-permissions">
        <span v-for="code in myPermissions" :key="code" class="chip mono">{{ code }}</span>
        <span v-if="!myPermissions.length" class="chip muted">no permissions</span>
      </div>
      <p class="source-note">
        Permissions are resolved when the access token is issued. A role change made now becomes
        effective on your next sign-in.
      </p>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>
