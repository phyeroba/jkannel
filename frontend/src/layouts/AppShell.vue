<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navigation } from '../navigation';
import AppIcon from '../components/AppIcon.vue';
import { canAccess, logout, session } from '../stores/session';
import { apiRequest } from '../api';

interface NotificationRecord {
  id: string;
  category: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
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
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api'}/v1/health`,
    );
    apiOnline.value = response.ok;
  } catch {
    apiOnline.value = false;
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
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (unreadTimer) clearInterval(unreadTimer);
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
          <p class="nav-label">{{ section.group }}</p>
          <RouterLink
            v-for="item in section.items"
            :key="item.to"
            :to="item.to"
            @click="navOpen = false"
            ><span class="nav-icon"><AppIcon :name="item.icon" /></span><span>{{ item.label }}</span
            ><span v-if="item.badge" class="nav-badge">{{ item.badge }}</span></RouterLink
          >
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
          <span class="environment">Development</span
          ><span class="engine-state"
            ><span class="status-dot" :class="apiOnline ? 'good' : 'warn'"></span
            >{{ apiOnline ? 'Connected' : 'Checking' }}</span
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
        <p
          v-for="item in notifications"
          :key="item.id"
          class="notification-item"
          :class="{ unread: !item.read_at }"
          :data-testid="`notification-${item.id}`"
        >
          <strong>{{ item.title }}</strong
          ><small>{{ item.body }}</small
          ><small class="notification-meta"
            >{{ item.category }} · {{ item.created_at }}
            <button
              v-if="!item.read_at"
              class="text-button"
              :data-testid="`shell-mark-read-${item.id}`"
              @click="markNotificationRead(item)"
            >
              Mark read
            </button></small
          >
        </p>
      </aside>
      <main id="workspace" class="workspace" tabindex="-1">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <RouterLink to="/dashboard/operations">Home</RouterLink
          ><template v-for="crumb in route.meta.breadcrumb" :key="crumb"
            ><span>/</span><span>{{ crumb }}</span></template
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
