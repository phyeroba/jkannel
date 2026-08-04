<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';

type RecordValue = Record<string, unknown>;
type LoadState = 'loading' | 'ok' | 'error';

interface PermissionEntry {
  code: string;
  description: string;
  category: string;
}

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
/** `userCount` is the published name; `user_count` is tolerated for older APIs. */
function userCountOf(role: RecordValue): number {
  const raw = role.userCount ?? role.user_count;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
function isSystemRole(role: RecordValue): boolean {
  return role.isSystem === true || role.is_system === true;
}

const canManageUsers = computed(() => canAccess(session.value, 'users.manage'));
const myPermissions = computed(() => [...(session.value?.permissions ?? new Set<string>())].sort());
const myRoles = computed(() => [...(session.value?.roles ?? [])]);

// --- Roles -------------------------------------------------------------------
const roles = ref<RecordValue[]>([]);
const roleState = ref<LoadState>('loading');
const roleError = ref('');
const roleMissing = ref(false);
const roleNotice = ref('');

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

// --- Permission catalogue ----------------------------------------------------
// GET /users/permissions is the authoritative list a role may draw from, with
// the `category` the picker groups by. An older API without it is reported
// rather than silently replaced with a guess: the picker then falls back to the
// codes the roles themselves advertise, and says so.
const catalogue = ref<PermissionEntry[]>([]);
const catalogueState = ref<LoadState>('loading');
const catalogueError = ref('');
const catalogueMissing = ref(false);

async function loadCatalogue() {
  catalogueState.value = 'loading';
  catalogueMissing.value = false;
  try {
    catalogue.value = asItems(await apiRequest<unknown>('/users/permissions')).map((row) => ({
      code: text(row.code, ''),
      description: text(row.description, ''),
      category: text(row.category, 'other'),
    }));
    catalogueError.value = '';
    catalogueState.value = 'ok';
  } catch (reason) {
    catalogue.value = [];
    catalogueMissing.value = isMissing(reason);
    catalogueError.value = messageFrom(reason, 'The permission catalogue could not be loaded.');
    catalogueState.value = 'error';
  }
}

/** Codes granted by some role but absent from the catalogue response. */
const codesFromRoles = computed(() => {
  const codes = new Set<string>();
  for (const role of roles.value) for (const code of stringsOf(role.permissions)) codes.add(code);
  return codes;
});

/**
 * The picker's source of truth: the catalogue, plus any code a role already
 * grants that the catalogue omitted (so editing a role can never silently drop
 * a grant the operator never saw).
 */
const pickerEntries = computed<PermissionEntry[]>(() => {
  const byCode = new Map<string, PermissionEntry>();
  for (const entry of catalogue.value) if (entry.code) byCode.set(entry.code, entry);
  for (const code of codesFromRoles.value)
    if (!byCode.has(code))
      byCode.set(code, {
        code,
        description: 'Granted by a role but absent from the permission catalogue.',
        category: code.includes('.') ? code.slice(0, code.indexOf('.')) : 'other',
      });
  return [...byCode.values()].sort(
    (left, right) =>
      left.category.localeCompare(right.category) || left.code.localeCompare(right.code),
  );
});

const pickerFilter = ref('');
/** Catalogue grouped by its own `category`, honouring the picker's search box. */
const pickerGroups = computed(() => {
  const needle = pickerFilter.value.trim().toLowerCase();
  const groups = new Map<string, PermissionEntry[]>();
  for (const entry of pickerEntries.value) {
    if (
      needle &&
      !entry.code.toLowerCase().includes(needle) &&
      !entry.description.toLowerCase().includes(needle) &&
      !entry.category.toLowerCase().includes(needle)
    )
      continue;
    groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
  }
  return [...groups.entries()].map(([category, entries]) => ({ category, entries }));
});

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

// --- Create / edit form -------------------------------------------------------
const showForm = ref(false);
const editingId = ref('');
const editingIsSystem = ref(false);
const formName = ref('');
const formDescription = ref('');
const formPermissions = ref<string[]>([]);
const formError = ref('');
const formBusy = ref(false);
const deleteBusyId = ref('');

/** Grants the role held when the form opened, for the "what changes" summary. */
const originalPermissions = ref<string[]>([]);

const addedPermissions = computed(() =>
  formPermissions.value.filter((code) => !originalPermissions.value.includes(code)).sort(),
);
const removedPermissions = computed(() =>
  originalPermissions.value.filter((code) => !formPermissions.value.includes(code)).sort(),
);

/**
 * `users.manage` is the permission that makes role administration possible at
 * all. The API refuses a change that would leave nobody holding it (409); this
 * warns before the operator hits that wall, and never claims more than it can
 * see (the holder count comes from the roles + users grids).
 */
const adminHolderCount = computed(() => {
  const holders = new Set<string>();
  for (const role of roles.value) {
    if (!stringsOf(role.permissions).includes('users.manage')) continue;
    for (const username of holdersOf(role)) holders.add(username);
  }
  return holders.size;
});
const wouldDropAdministration = computed(() => {
  if (!editingId.value) return false;
  const role = roles.value.find((entry) => text(entry.id, '') === editingId.value);
  if (!role) return false;
  const heldBefore = stringsOf(role.permissions).includes('users.manage');
  const heldAfter = formPermissions.value.includes('users.manage');
  if (!heldBefore || heldAfter) return false;
  // Some other role still grants it to somebody -> the API will allow it.
  return !roles.value.some(
    (other) =>
      text(other.id, '') !== editingId.value &&
      stringsOf(other.permissions).includes('users.manage') &&
      holdersOf(other).length > 0,
  );
});

function openForm(role?: RecordValue) {
  if (!canManageUsers.value) return;
  showForm.value = true;
  formError.value = '';
  roleNotice.value = '';
  pickerFilter.value = '';
  editingId.value = role ? text(role.id, '') : '';
  editingIsSystem.value = role ? isSystemRole(role) : false;
  formName.value = role ? text(role.name, '') : '';
  formDescription.value = role ? (role.description == null ? '' : String(role.description)) : '';
  const granted = role ? stringsOf(role.permissions) : [];
  formPermissions.value = [...granted];
  originalPermissions.value = [...granted];
  if (catalogueState.value !== 'ok') void loadCatalogue();
}
function closeForm() {
  showForm.value = false;
  editingId.value = '';
  editingIsSystem.value = false;
  formError.value = '';
}

function toggleGroup(entries: PermissionEntry[]) {
  const codes = entries.map((entry) => entry.code);
  const allSelected = codes.every((code) => formPermissions.value.includes(code));
  formPermissions.value = allSelected
    ? formPermissions.value.filter((code) => !codes.includes(code))
    : [...new Set([...formPermissions.value, ...codes])];
}
function groupSelected(entries: PermissionEntry[]) {
  return entries.filter((entry) => formPermissions.value.includes(entry.code)).length;
}

async function saveRole() {
  if (!canManageUsers.value) return;
  formError.value = '';
  const name = formName.value.trim();
  if (!name) {
    formError.value = 'A role name is required.';
    return;
  }
  formBusy.value = true;
  try {
    const description = formDescription.value.trim();
    if (editingId.value) {
      const body: RecordValue = { description, permissions: formPermissions.value };
      // A system role cannot be renamed (409); do not even send the field.
      if (!editingIsSystem.value) body.name = name;
      await apiRequest(`/users/roles/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      roleNotice.value = `Role “${name}” updated. Permission changes revoke existing sessions for its holders, so they take effect on their next sign-in.`;
    } else {
      await apiRequest('/users/roles', {
        method: 'POST',
        body: JSON.stringify({ name, description, permissions: formPermissions.value }),
      });
      roleNotice.value = `Role “${name}” created with ${formPermissions.value.length} permission(s).`;
    }
    closeForm();
    await Promise.all([loadRoles(), loadUsers()]);
  } catch (reason) {
    // 409s from the API name the exact refusal (system role rename, lost
    // users.manage, duplicate name). Surface that text, never a generic one.
    formError.value = messageFrom(reason, 'The role could not be saved.');
  } finally {
    formBusy.value = false;
  }
}

async function deleteRole(role: RecordValue) {
  if (!canManageUsers.value) return;
  const id = text(role.id, '');
  if (!id) return;
  const name = text(role.name, id);
  if (
    !window.confirm(
      `Delete the role “${name}”?\n\nEvery permission it grants is withdrawn. A role that is still assigned to somebody, and a system role, are both refused by the API.`,
    )
  )
    return;
  deleteBusyId.value = id;
  roleError.value = '';
  roleNotice.value = '';
  try {
    await apiRequest(`/users/roles/${id}`, { method: 'DELETE' });
    roleNotice.value = `Role “${name}” deleted.`;
    await Promise.all([loadRoles(), loadUsers()]);
  } catch (reason) {
    roleError.value = messageFrom(reason, 'The role could not be deleted.');
  } finally {
    deleteBusyId.value = '';
  }
}

/** Why the API would refuse this delete, or '' when it should succeed. */
function deleteBlockedReason(role: RecordValue): string {
  if (isSystemRole(role)) return 'A system role cannot be deleted; edit its permissions instead.';
  if (userCountOf(role) > 0)
    return `Assigned to ${userCountOf(role)} user(s); reassign them before deleting it.`;
  return '';
}

// --- Permission matrix --------------------------------------------------------
const permissionCodes = computed(() => {
  const codes = new Set<string>(codesFromRoles.value);
  for (const entry of catalogue.value) if (entry.code) codes.add(entry.code);
  // Permissions the signed-in principal holds but no role advertises would be
  // invisible otherwise; showing them keeps the matrix honest about coverage.
  for (const code of myPermissions.value) codes.add(code);
  return [...codes].sort();
});
/** Grouped by the catalogue's own category, falling back to the code prefix. */
const categoryByCode = computed(() => {
  const map = new Map<string, string>();
  for (const entry of catalogue.value) map.set(entry.code, entry.category);
  return map;
});
const permissionGroups = computed(() => {
  const groups = new Map<string, string[]>();
  for (const code of permissionCodes.value) {
    const group =
      categoryByCode.value.get(code) ??
      (code.includes('.') ? code.slice(0, code.indexOf('.')) : 'other');
    groups.set(group, [...(groups.get(group) ?? []), code]);
  }
  return [...groups.entries()].map(([name, codes]) => ({ name, codes }));
});
function roleHas(role: RecordValue, code: string): boolean {
  return stringsOf(role.permissions).includes(code);
}
const orphanCodes = computed(() =>
  permissionCodes.value.filter(
    (code) =>
      !roles.value.some((role) => roleHas(role, code)) && myPermissions.value.includes(code),
  ),
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
  void loadCatalogue();
});
</script>

<template>
  <div data-testid="roles-view">
    <p v-if="!canManageUsers" class="source-note" data-testid="roles-readonly">
      You can review every role and the permissions it grants. Creating, editing and deleting roles
      requires the users.manage permission.
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
        <button
          v-if="canManageUsers"
          class="primary-button"
          data-testid="role-create"
          :disabled="formBusy"
          @click="openForm()"
        >
          New role
        </button>
        <button class="secondary-button" data-testid="roles-refresh" @click="loadRoles">
          Refresh
        </button>
      </header>

      <p v-if="roleNotice" class="notice" role="status" data-testid="role-notice">
        {{ roleNotice }}
      </p>

      <!-- Create / edit form ------------------------------------------------- -->
      <div v-if="showForm" class="composer" data-testid="role-form">
        <h3>{{ editingId ? `Edit role “${formName}”` : 'New role' }}</h3>
        <p v-if="editingIsSystem" class="warn-notice" data-testid="role-form-system-note">
          This is a system role. Its name is fixed by the seeded catalogue and the API refuses a
          rename, so the name field is disabled — its description and permission set stay fully
          editable.
        </p>
        <label class="filter-select filter-search">
          <span>Name</span>
          <input
            v-model="formName"
            data-testid="role-name"
            type="text"
            placeholder="noc-operator"
            :disabled="editingIsSystem"
          />
        </label>
        <label class="filter-select filter-search">
          <span>Description</span>
          <input
            v-model="formDescription"
            data-testid="role-description"
            type="text"
            placeholder="What this role is for"
          />
        </label>

        <h4>Permissions</h4>
        <p class="source-note">
          Saving replaces the role's whole grant set with exactly what is ticked here — an unticked
          box is a revocation, not "leave it alone".
          {{ formPermissions.length }} of {{ pickerEntries.length }} selected.
        </p>
        <p
          v-if="catalogueState === 'error'"
          class="warn-notice"
          role="alert"
          data-testid="permission-catalogue-error"
        >
          {{
            catalogueMissing
              ? 'The permission catalogue endpoint (GET /users/permissions) is not available in this deployment,'
              : `${catalogueError} —`
          }}
          so the picker below lists only the codes existing roles already grant. A permission no
          role grants yet cannot be discovered here.
        </p>
        <label class="filter-select filter-search">
          <span>Filter permissions</span>
          <input
            v-model="pickerFilter"
            data-testid="role-permission-filter"
            type="search"
            placeholder="alerts, users.manage, …"
          />
        </label>

        <fieldset
          v-for="group in pickerGroups"
          :key="group.category"
          class="role-checkboxes"
          :data-testid="`role-permission-group-${group.category}`"
        >
          <legend>
            {{ group.category }}
            <span class="chip">{{ groupSelected(group.entries) }}/{{ group.entries.length }}</span>
            <button
              class="secondary-button"
              type="button"
              :data-testid="`role-permission-group-toggle-${group.category}`"
              @click="toggleGroup(group.entries)"
            >
              Toggle all
            </button>
          </legend>
          <label
            v-for="entry in group.entries"
            :key="entry.code"
            class="role-option"
            :data-testid="`role-permission-${entry.code}`"
          >
            <input v-model="formPermissions" type="checkbox" :value="entry.code" />
            <span class="role-text">
              <strong class="mono">{{ entry.code }}</strong>
              <small>{{ entry.description || 'No description in the catalogue.' }}</small>
            </span>
          </label>
        </fieldset>
        <p v-if="!pickerGroups.length" class="source-note" data-testid="role-permission-empty">
          {{
            catalogueState === 'loading'
              ? 'Loading the permission catalogue…'
              : 'No permission codes match this filter.'
          }}
        </p>

        <p
          v-if="editingId && (addedPermissions.length || removedPermissions.length)"
          class="source-note"
          data-testid="role-permission-diff"
        >
          <span v-if="addedPermissions.length">
            Granting: <span class="mono">{{ addedPermissions.join(', ') }}</span
            >.
          </span>
          <span v-if="removedPermissions.length">
            Revoking: <span class="mono">{{ removedPermissions.join(', ') }}</span
            >.
          </span>
        </p>
        <p
          v-if="wouldDropAdministration"
          class="warn-notice"
          role="alert"
          data-testid="role-admin-warning"
        >
          This is the only role granting <span class="mono">users.manage</span> to anybody ({{
            adminHolderCount
          }}
          holder(s)). Removing it here would leave nobody able to administer roles, and the API will
          refuse the change with a 409.
        </p>

        <p v-if="formError" class="form-error" role="alert" data-testid="role-form-error">
          {{ formError }}
        </p>
        <div class="detail-actions">
          <button
            class="primary-button"
            data-testid="role-save"
            :disabled="formBusy"
            @click="saveRole"
          >
            {{ formBusy ? 'Saving…' : editingId ? 'Save role' : 'Create role' }}
          </button>
          <button class="secondary-button" data-testid="role-cancel" @click="closeForm">
            Cancel
          </button>
        </div>
      </div>

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
              <th v-if="canManageUsers" scope="col">Actions</th>
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
                <span
                  v-if="isSystemRole(role)"
                  class="status-badge"
                  :data-testid="`role-system-${text(role.id)}`"
                >
                  system
                </span>
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
              <td class="mono" :data-testid="`role-user-count-${text(role.id)}`">
                {{ userCountOf(role) }}
              </td>
              <td>
                <span v-if="userState === 'error'" class="cell-health">{{ userError }}</span>
                <span v-else-if="userState === 'loading'" class="cell-health">loading…</span>
                <span v-else-if="holdersOf(role).length" class="mono">
                  {{ holdersOf(role).join(', ') }}
                </span>
                <span v-else class="cell-health">nobody holds this role</span>
              </td>
              <td v-if="canManageUsers" class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`role-edit-${text(role.id)}`"
                  @click="openForm(role)"
                >
                  Edit
                </button>
                <button
                  class="secondary-button danger-button"
                  :data-testid="`role-delete-${text(role.id)}`"
                  :disabled="deleteBusyId === text(role.id) || Boolean(deleteBlockedReason(role))"
                  :title="deleteBlockedReason(role) || undefined"
                  @click="deleteRole(role)"
                >
                  Delete
                </button>
                <small
                  v-if="deleteBlockedReason(role)"
                  class="cell-health"
                  :data-testid="`role-delete-blocked-${text(role.id)}`"
                >
                  {{ deleteBlockedReason(role) }}
                </small>
              </td>
            </tr>
            <tr v-if="roleState === 'ok' && !roles.length">
              <td :colspan="canManageUsers ? 6 : 5" class="empty-cell" data-testid="roles-empty">
                No roles are defined. Nobody can be granted anything until a role exists.
              </td>
            </tr>
            <tr v-if="roleState === 'loading'">
              <td :colspan="canManageUsers ? 6 : 5" class="empty-cell">Loading roles…</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="source-note">
        Assigning an existing role to a person is done from
        <RouterLink class="text-link" to="/users">Users &amp; Roles</RouterLink>. Changing a role's
        permissions revokes the live sessions of everyone holding it, so the change is immediate
        rather than waiting for their token to expire.
      </p>
    </section>

    <!-- Permission matrix ------------------------------------------------------ -->
    <section class="panel" data-testid="permission-matrix-panel" aria-label="Permission matrix">
      <header class="panel-header">
        <div>
          <h2>Permission matrix</h2>
          <p>
            Every permission in the catalogue, against the roles that grant it.
            {{
              catalogueState === 'ok'
                ? `${catalogue.length} code(s) in the catalogue.`
                : 'Catalogue unavailable — showing only what roles advertise.'
            }}
          </p>
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
