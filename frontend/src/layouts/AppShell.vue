<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navigation, type NavigationItem } from '../navigation';
import AppIcon from '../components/AppIcon.vue';
import { canAccess, logout, session } from '../stores/session';
import { clearBreadcrumbTrail, resolveBreadcrumbs } from '../stores/breadcrumbs';
import { RANGE_PRESETS, selectedRange, setRangePreset } from '../stores/time-range';
import { apiRequest } from '../api';

interface NotificationRecord {
  id: string;
  category: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
  data?: Record<string, unknown> | null;
}

const route = useRoute();
const router = useRouter();
const navOpen = ref(false);
const searchOpen = ref(false);
const notificationsOpen = ref(false);
const searchQuery = ref('');
const apiOnline = ref(false);
const theme = ref<'light' | 'dark'>(
  localStorage.getItem('jkannel-console-theme') === 'dark' ? 'dark' : 'light',
);
const visibleNavigation = computed(() =>
  navigation.filter((item) => canAccess(session.value, item.permission)),
);
const navigationGroups = computed(() =>
  ['Operations', 'Messaging', 'Insights', 'Platform']
    .map((group) => ({
      group,
      items: visibleNavigation.value.filter((item) => item.group === group),
    }))
    .filter((section) => section.items.length),
);

/**
 * Collapsed navigation groups, persisted so the sidebar keeps its shape across
 * reloads (same convention as the theme preference above).
 *
 * A first visit starts with only Operations open — 28 links expanded at once is
 * a wall. The catch is that the old representation (a bare array of collapsed
 * group names) cannot tell "never chose anything" apart from "deliberately
 * expanded everything": both are `[]`. The stored value is therefore now an
 * object, `{ version: 2, collapsed: [...] }`, so:
 *
 *   - no key at all      -> no preference -> DEFAULT_COLLAPSED applies;
 *   - a bare array       -> a pre-v2 user's deliberate state -> honoured as-is
 *                           (including an empty one, i.e. "everything open");
 *   - a v2 object        -> honoured as-is.
 *
 * Writes always use the v2 shape, so a legacy value migrates on first toggle.
 */
const NAV_STORAGE_KEY = 'jkannel-console-nav-collapsed';
const DEFAULT_COLLAPSED = ['Messaging', 'Insights', 'Platform'];

function readCollapsedPreference(): string[] {
  const raw = localStorage.getItem(NAV_STORAGE_KEY);
  if (raw === null) return [...DEFAULT_COLLAPSED];
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return strings(parsed);
    if (parsed && typeof parsed === 'object')
      return strings((parsed as { collapsed?: unknown }).collapsed);
    return [...DEFAULT_COLLAPSED];
  } catch {
    // A corrupt value is not a preference.
    return [...DEFAULT_COLLAPSED];
  }
}

const collapsedGroups = ref<string[]>(readCollapsedPreference());
function persistCollapsed() {
  localStorage.setItem(
    NAV_STORAGE_KEY,
    JSON.stringify({ version: 2, collapsed: collapsedGroups.value }),
  );
}
const isCollapsed = (group: string) => collapsedGroups.value.includes(group);
function toggleGroup(group: string) {
  collapsedGroups.value = isCollapsed(group)
    ? collapsedGroups.value.filter((g) => g !== group)
    : [...collapsedGroups.value, group];
  persistCollapsed();
}

/** The group owning the current route, by longest matching workspace path. */
const activeGroup = computed(() => {
  let best: NavigationItem | undefined;
  for (const item of navigation) {
    if (route.path === item.to || route.path.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best?.group ?? '';
});
/**
 * Navigating into a collapsed group opens it: the page you are looking at must
 * never be the one link you cannot see. This runs on navigation rather than at
 * render time so the group header stays a working control afterwards.
 */
function expandActiveGroup() {
  const group = activeGroup.value;
  if (!group || !isCollapsed(group)) return;
  collapsedGroups.value = collapsedGroups.value.filter((g) => g !== group);
  persistCollapsed();
}
watch(activeGroup, expandActiveGroup, { immediate: true });

/**
 * Breadcrumbs (spec §2.1). A view publishes its hierarchy once its entity has
 * loaded; until then the route's static crumbs show.
 *
 * The trail is cleared on every navigation rather than left for the next screen
 * to overwrite. A stale `MTN Uganda / MTN-P1` sitting above an unrelated page is
 * worse than no breadcrumb at all — it is a wrong answer to "where am I".
 */
const breadcrumbs = computed(() => resolveBreadcrumbs(route));
watch(
  () => route.path,
  () => clearBreadcrumbTrail(),
);
const groupId = (group: string) => `nav-group-${group.toLowerCase()}`;
const searchResults = computed(() =>
  visibleNavigation.value.filter((item) =>
    item.label.toLowerCase().includes(searchQuery.value.toLowerCase()),
  ),
);
const initials = computed(() =>
  (session.value?.displayName ?? 'Operator')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2),
);
function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem('jkannel-console-theme', theme.value);
}
function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchOpen.value = true;
  }
  if (event.key === 'Escape') {
    searchOpen.value = false;
    notificationsOpen.value = false;
  }
}
async function checkApi() {
  try {
    // 127.0.0.1, not localhost: browsers resolve localhost to IPv6 first but
    // Docker publishes ports on IPv4, which fails as "Failed to fetch".
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api'}/v1/health`,
    );
    apiOnline.value = response.ok;
  } catch {
    apiOnline.value = false;
  }
}
/**
 * Deployment identity and telemetry freshness (spec §2.1).
 *
 * Both chips previously lied. The environment read the literal string
 * "Development" regardless of where it was running — so the production
 * deployment announced itself as Development — and the state chip reported
 * whether OUR OWN API answered, which says nothing about whether the engine
 * data on screen is current.
 */
interface TelemetryFreshness {
  state: 'live' | 'delayed' | 'disconnected' | 'unknown';
  ageSeconds: number | null;
  detail: string;
  pollingSuppressed: boolean;
  cause: string | null;
}
interface SystemInfo {
  environmentLabel: string;
  environmentTone: 'critical' | 'warning' | 'neutral';
  environmentDeclared: boolean;
  version: string;
  build: string | null;
  gatewayTimezone: string;
  telemetry: TelemetryFreshness;
}
const systemInfo = ref<SystemInfo | null>(null);
const telemetry = ref<TelemetryFreshness | null>(null);
let telemetryTimer: ReturnType<typeof setInterval> | undefined;

/** Until the first successful read, show nothing rather than a guess. */
const environmentLabel = computed(() => systemInfo.value?.environmentLabel ?? null);
const environmentTitle = computed(() => {
  const info = systemInfo.value;
  if (!info) return '';
  const identity = `JKANNEL ${info.version}${info.build ? ` (${info.build})` : ''}`;
  const declared = info.environmentDeclared
    ? 'Designation is configured.'
    : 'Designation was INFERRED from NODE_ENV, which cannot tell a DR site from production. ' +
      'Set JKANNEL_ENVIRONMENT to declare it.';
  return `${identity} · engine timezone ${info.gatewayTimezone} · ${declared}`;
});
const telemetryDotClass = computed(() => {
  switch (telemetry.value?.state) {
    case 'live':
      return 'good';
    case 'delayed':
      return 'warn';
    case 'disconnected':
      return 'bad';
    default:
      return 'unknown';
  }
});
/** Text as well as colour — §17.1 forbids encoding health by colour alone. */
const telemetryLabel = computed(() => {
  switch (telemetry.value?.state) {
    case 'live':
      return 'Live';
    case 'delayed':
      return 'Delayed';
    case 'disconnected':
      return telemetry.value?.pollingSuppressed ? 'Suppressed' : 'Disconnected';
    case 'unknown':
      return 'Unknown';
    default:
      return 'Checking';
  }
});
async function refreshSystemInfo() {
  try {
    const info = await apiRequest<SystemInfo>('/system/info');
    systemInfo.value = info;
    telemetry.value = info.telemetry;
  } catch {
    /* Leave the chip blank rather than asserting an environment we cannot read. */
  }
}
async function refreshTelemetry() {
  try {
    telemetry.value = await apiRequest<TelemetryFreshness>('/system/telemetry');
  } catch {
    /* Keep the previous reading; the poll retries. */
  }
}

const unreadCount = ref(0);
const notifications = ref<NotificationRecord[]>([]);
const notificationsError = ref('');
let unreadTimer: ReturnType<typeof setInterval> | undefined;
async function refreshUnreadCount() {
  try {
    const result = await apiRequest<{ unread?: number }>('/notifications/unread-count');
    unreadCount.value = typeof result.unread === 'number' ? result.unread : 0;
  } catch {
    /* Keep the last known count; the poll retries every minute. */
  }
}
async function loadNotifications() {
  notificationsError.value = '';
  try {
    const page = await apiRequest<NotificationRecord[] | { items?: NotificationRecord[] }>(
      '/notifications?sort=-createdAt&limit=10&offset=0',
    );
    notifications.value = Array.isArray(page) ? page : (page.items ?? []);
  } catch {
    notifications.value = [];
    notificationsError.value = 'Notifications could not be loaded.';
  }
}
function toggleNotifications() {
  notificationsOpen.value = !notificationsOpen.value;
  if (notificationsOpen.value) {
    void loadNotifications();
    void refreshUnreadCount();
  }
}
async function markNotificationRead(notification: NotificationRecord) {
  try {
    await apiRequest(`/notifications/${notification.id}/read`, { method: 'POST', body: '{}' });
    await Promise.all([loadNotifications(), refreshUnreadCount()]);
  } catch {
    notificationsError.value = 'The notification could not be updated.';
  }
}
const selectedNotification = ref<NotificationRecord | null>(null);
/** Opening a notification loads its full detail and marks it read. */
async function openNotification(notification: NotificationRecord) {
  try {
    const detail = await apiRequest<NotificationRecord>(`/notifications/${notification.id}`);
    selectedNotification.value = detail;
    // The GET marks it read server-side; refresh list + badge to reflect that.
    await Promise.all([loadNotifications(), refreshUnreadCount()]);
  } catch {
    // Fall back to the row data we already have so the detail still opens.
    selectedNotification.value = notification;
    notificationsError.value = 'The full notification could not be loaded.';
  }
}
function closeNotificationDetail() {
  selectedNotification.value = null;
}
/** Human-readable rows from a notification's structured data payload. */
const selectedDataRows = computed(() => {
  const data = selectedNotification.value?.data;
  if (!data || typeof data !== 'object') return [] as Array<{ label: string; value: string }>;
  return Object.entries(data).map(([key, value]) => ({
    label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    value: value === null || value === undefined ? '—' : String(value),
  }));
});
async function markAllNotificationsRead() {
  try {
    await apiRequest('/notifications/read-all', { method: 'POST', body: '{}' });
    await Promise.all([loadNotifications(), refreshUnreadCount()]);
  } catch {
    notificationsError.value = 'The notifications could not be updated.';
  }
}
async function signOut() {
  await logout();
  await router.push('/login');
}
onMounted(() => {
  document.documentElement.dataset.theme = theme.value;
  window.addEventListener('keydown', onKeydown);
  void checkApi();
  void refreshUnreadCount();
  unreadTimer = setInterval(() => void refreshUnreadCount(), 60_000);
  void refreshSystemInfo();
  // 20s, comfortably under the 75s 'delayed' threshold, so the chip changes
  // state within one interval of the condition rather than after it.
  telemetryTimer = setInterval(() => void refreshTelemetry(), 20_000);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (unreadTimer) clearInterval(unreadTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
});
</script>
<template>
  <a class="skip-link" href="#workspace">Skip to workspace</a>
  <div class="app-frame">
    <aside
      id="primary-navigation"
      class="sidebar"
      :class="{ open: navOpen }"
      aria-label="Primary navigation"
    >
      <div class="brand">
        <span class="brand-mark"><AppIcon name="sms" :size="21" /></span>
        <div><strong>JKANNEL</strong><small>Kamex control plane</small></div>
      </div>
      <nav>
        <section v-for="section in navigationGroups" :key="section.group" class="nav-group">
          <button
            type="button"
            class="nav-label"
            :class="{ collapsed: isCollapsed(section.group) }"
            :aria-expanded="!isCollapsed(section.group)"
            :aria-controls="isCollapsed(section.group) ? undefined : groupId(section.group)"
            :data-testid="`nav-group-toggle-${section.group.toLowerCase()}`"
            @click="toggleGroup(section.group)"
          >
            <span>{{ section.group }}</span>
            <AppIcon class="nav-chevron" name="chevron" :size="14" />
          </button>
          <!--
            v-if, not v-show: a hidden-but-present grid track is exactly the kind
            of thing that keeps contributing height, and a collapsed group must
            be no taller than its header.
          -->
          <div v-if="!isCollapsed(section.group)" :id="groupId(section.group)" class="nav-items">
            <RouterLink
              v-for="item in section.items"
              :key="item.to"
              :to="item.to"
              @click="navOpen = false"
              ><span class="nav-icon"><AppIcon :name="item.icon" /></span
              ><span>{{ item.label }}</span
              ><span v-if="item.badge" class="nav-badge">{{ item.badge }}</span></RouterLink
            >
          </div>
        </section>
      </nav>
      <div class="sidebar-footer">
        <span class="status-dot good"></span>
        <div><strong>Kamex 1.8.3</strong><small>Messaging engine connected</small></div>
      </div>
    </aside>
    <div class="shell">
      <header class="topbar">
        <button
          class="icon-button menu-button"
          aria-label="Open navigation"
          aria-controls="primary-navigation"
          :aria-expanded="navOpen"
          @click="navOpen = !navOpen"
        >
          <AppIcon name="menu" /></button
        ><button class="search-trigger" data-testid="global-search" @click="searchOpen = true">
          <AppIcon name="search" /><span>Search JKANNEL</span><kbd>Ctrl K</kbd>
        </button>
        <div class="top-actions">
          <label class="range-control">
            <span class="sr-only">Time range for analytical screens</span>
            <select
              :value="selectedRange.id"
              data-testid="global-time-range"
              @change="setRangePreset(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="preset in RANGE_PRESETS" :key="preset.id" :value="preset.id">
                {{ preset.label }}
              </option>
            </select> </label
          ><span
            v-if="environmentLabel"
            class="environment"
            :class="`tone-${systemInfo?.environmentTone}`"
            :title="environmentTitle"
            data-testid="environment-chip"
            >{{ environmentLabel
            }}<span v-if="systemInfo && !systemInfo.environmentDeclared" aria-hidden="true">?</span>
            <span v-if="systemInfo && !systemInfo.environmentDeclared" class="sr-only">
              (inferred, not configured)
            </span></span
          ><span
            class="engine-state"
            :title="telemetry?.detail ?? ''"
            data-testid="telemetry-indicator"
            ><span class="status-dot" :class="telemetryDotClass"></span>{{ telemetryLabel
            }}<span
              v-if="telemetry?.ageSeconds !== null && telemetry?.ageSeconds !== undefined"
              class="telemetry-age"
            >
              {{ telemetry.ageSeconds }}s</span
            ></span
          ><RouterLink
            class="icon-button"
            to="/help"
            aria-label="Open documentation and help"
            title="Documentation & Help"
            data-testid="topbar-help"
          >
            <AppIcon name="help" /></RouterLink
          ><button class="icon-button" aria-label="Toggle theme" @click="toggleTheme">
            <AppIcon :name="theme === 'light' ? 'moon' : 'sun'" /></button
          ><button
            class="icon-button notification"
            aria-label="Open notifications"
            aria-controls="notifications-panel"
            :aria-expanded="notificationsOpen"
            data-testid="notifications-bell"
            @click="toggleNotifications"
          >
            <AppIcon name="bell" /><span
              v-if="unreadCount"
              class="unread-count"
              data-testid="unread-count"
              >{{ unreadCount > 99 ? '99+' : unreadCount }}</span
            >
          </button>
          <div class="profile">
            <span class="avatar">{{ initials }}</span
            ><span
              ><strong>{{ session?.displayName ?? 'Operator' }}</strong
              ><small>{{ session?.roleLabel ?? 'Authenticated' }}</small></span
            ><button
              class="icon-button"
              data-testid="logout"
              aria-label="Sign out"
              @click="signOut"
            >
              <AppIcon name="logout" />
            </button>
          </div>
        </div>
      </header>
      <aside
        v-if="notificationsOpen"
        id="notifications-panel"
        class="notification-panel"
        aria-label="Notifications"
      >
        <header>
          <h2>Notifications</h2>
          <button class="text-button" @click="notificationsOpen = false">Close</button>
        </header>
        <div class="notification-actions">
          <button
            class="text-button"
            data-testid="mark-all-read"
            :disabled="!unreadCount"
            @click="markAllNotificationsRead"
          >
            Mark all read
          </button>
          <RouterLink class="text-link" to="/notifications" @click="notificationsOpen = false"
            >View all</RouterLink
          >
        </div>
        <p v-if="notificationsError" role="alert">
          <strong>Notifications unavailable</strong><small>{{ notificationsError }}</small>
        </p>
        <p v-else-if="!notifications.length">
          <strong>No notifications yet</strong
          ><small>Report deliveries and platform notices appear here.</small>
        </p>
        <button
          v-for="item in notifications"
          :key="item.id"
          type="button"
          class="notification-item notification-item-button"
          :class="{ unread: !item.read_at }"
          :data-testid="`notification-${item.id}`"
          @click="openNotification(item)"
        >
          <strong>{{ item.title }}</strong
          ><small>{{ item.body }}</small
          ><small class="notification-meta"
            >{{ item.category }} · {{ item.created_at }}
            <span v-if="!item.read_at" class="notification-unread-tag">unread</span></small
          >
        </button>
      </aside>
      <div
        v-if="selectedNotification"
        class="dialog-backdrop"
        data-testid="notification-detail"
        @click.self="closeNotificationDetail"
      >
        <section
          class="command-dialog notification-detail-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notification-detail-title"
        >
          <header>
            <h2 id="notification-detail-title">{{ selectedNotification.title }}</h2>
            <button
              class="text-button"
              data-testid="notification-detail-close"
              @click="closeNotificationDetail"
            >
              Close
            </button>
          </header>
          <p class="notification-detail-meta">
            <span class="status-badge">{{ selectedNotification.category }}</span>
            <span>{{ selectedNotification.created_at }}</span>
            <span class="status-badge muted">read</span>
          </p>
          <p class="notification-detail-body">{{ selectedNotification.body }}</p>
          <dl v-if="selectedDataRows.length" class="notification-detail-data">
            <template v-for="row in selectedDataRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </template>
          </dl>
          <footer class="notification-detail-footer">
            <RouterLink
              class="secondary-button"
              to="/notifications"
              @click="
                closeNotificationDetail();
                notificationsOpen = false;
              "
              >Open notification centre</RouterLink
            >
            <RouterLink
              v-if="selectedNotification.category === 'report'"
              class="primary-button"
              to="/reports"
              @click="
                closeNotificationDetail();
                notificationsOpen = false;
              "
              >View reports</RouterLink
            >
          </footer>
        </section>
      </div>
      <main id="workspace" class="workspace" tabindex="-1">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <RouterLink to="/dashboard/operations">Home</RouterLink
          ><template v-for="(crumb, index) in breadcrumbs" :key="`${crumb.label}-${index}`"
            ><span aria-hidden="true">/</span
            ><RouterLink v-if="crumb.to" :to="crumb.to">{{ crumb.label }}</RouterLink
            ><span v-else :aria-current="index === breadcrumbs.length - 1 ? 'page' : undefined">{{
              crumb.label
            }}</span></template
          >
        </nav>
        <div class="page-heading">
          <div>
            <h1>{{ route.meta.title }}</h1>
            <p>{{ route.meta.description }}</p>
          </div>
        </div>
        <RouterView />
      </main>
      <footer class="statusbar">
        <button class="status-button" @click="checkApi">
          <span class="status-dot" :class="apiOnline ? 'good' : 'bad'"></span>API
          {{ apiOnline ? 'connected' : 'unavailable' }} - retry</button
        ><span>Kamex 1.8.3</span><span>JKANNEL 0.1.0</span>
      </footer>
    </div>
  </div>
  <div v-if="searchOpen" class="dialog-backdrop" @click.self="searchOpen = false">
    <section class="command-dialog" role="dialog" aria-modal="true" aria-labelledby="search-title">
      <header>
        <h2 id="search-title">Go to workspace</h2>
        <button class="text-button" @click="searchOpen = false">Close</button>
      </header>
      <input
        v-model="searchQuery"
        autofocus
        placeholder="Search platform modules"
        data-testid="global-search-input"
      />
      <nav class="search-results">
        <RouterLink
          v-for="item in searchResults"
          :key="item.to"
          :to="item.to"
          @click="
            searchOpen = false;
            searchQuery = '';
          "
          >{{ item.label }}<span>{{ item.to }}</span></RouterLink
        >
        <p v-if="!searchResults.length">No matching workspace.</p>
      </nav>
    </section>
  </div>
</template>
