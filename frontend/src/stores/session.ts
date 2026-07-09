import { computed, readonly, ref } from 'vue';
import { apiRequest, clearTokens, currentRefreshToken, setTokens } from '../api';
export interface Session {
  tenantId: string;
  userId: string;
  sessionId: string;
  username: string;
  displayName: string;
  roleLabel: string;
  roles: ReadonlyArray<string>;
  permissions: ReadonlySet<string>;
}
interface Principal {
  tenantId: string;
  userId: string;
  sessionId: string;
  username: string;
  roles: string[];
  permissions: string[];
}
const identity = ref<Session | null>(null);
const initialized = ref(false);
function map(value: Principal): Session {
  return {
    ...value,
    displayName: value.username,
    roleLabel: value.roles.join(', ') || 'Operator',
    permissions: new Set(value.permissions),
  };
}
export async function initializeSession() {
  if (initialized.value) return;
  try {
    identity.value = map(await apiRequest<Principal>('/auth/me'));
  } catch {
    clearTokens();
    identity.value = null;
  } finally {
    initialized.value = true;
  }
}
export async function login(tenant: string, username: string, password: string) {
  const tokens = await apiRequest<{ accessToken: string; refreshToken: string }>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ tenant, username, password }) },
    false,
  );
  setTokens(tokens.accessToken, tokens.refreshToken);
  identity.value = map(await apiRequest<Principal>('/auth/me'));
  initialized.value = true;
}
export async function logout() {
  const token = currentRefreshToken();
  try {
    if (token)
      await apiRequest(
        '/auth/logout',
        { method: 'POST', body: JSON.stringify({ refreshToken: token }) },
        false,
      );
  } finally {
    clearTokens();
    identity.value = null;
  }
}
export const session = readonly(identity);
export const sessionReady = readonly(initialized);
export const isAuthenticated = computed(() => identity.value !== null);
export const canAccess = (value: Session | null, permission?: string) =>
  !permission || Boolean(value?.permissions.has(permission));
