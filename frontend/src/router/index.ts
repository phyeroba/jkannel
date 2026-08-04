import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import OperationsOverview from '../views/OperationsOverview.vue';
import ModuleWorkspace from '../views/ModuleWorkspace.vue';
import CopilotView from '../views/CopilotView.vue';
import SessionsView from '../views/SessionsView.vue';
import AnalyticsView from '../views/AnalyticsView.vue';
import BulkSendView from '../views/BulkSendView.vue';
import LiveQueueView from '../views/LiveQueueView.vue';
import AlertResponseView from '../views/AlertResponseView.vue';
import AlertLifecycleView from '../views/AlertLifecycleView.vue';
import LogExplorerView from '../views/LogExplorerView.vue';
import RoutingDepthView from '../views/RoutingDepthView.vue';
import RolesView from '../views/RolesView.vue';
import { canAccess, session } from '../stores/session';
import { initializeSession, isAuthenticated } from '../stores/session';
import LoginView from '../views/LoginView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    title: string;
    description?: string;
    breadcrumb?: string[];
    permission?: string;
    publicLayout?: boolean;
  }
}

const modules = [
  ['/messages', 'Messages', 'Trace message flow, retries, and delivery outcomes.', 'messages.view'],
  [
    '/queues',
    'Queues',
    'Inspect queue depth, throughput, retries, and blocked messages.',
    'messages.view',
  ],
  [
    '/delivery-reports',
    'Delivery Reports',
    'Search and inspect delivery receipts and status transitions.',
    'messages.view',
  ],
  ['/smsc', 'SMSC Manager', 'Manage connections, health, and provider capacity.', 'smsc.view'],
  ['/routing', 'Routing', 'Understand and validate message routing decisions.', 'routes.view'],
  [
    '/configuration',
    'Configuration',
    'Review, validate, and deploy engine configuration.',
    'configuration.view',
  ],
  ['/monitoring', 'Monitoring', 'Inspect platform metrics and service health.', 'monitoring.view'],
  ['/alerts', 'Alerts', 'Triage active operational conditions.', 'alerts.view'],
  [
    '/notifications',
    'Notifications',
    'Review report deliveries and platform notices for your account.',
    '',
  ],
  [
    '/customers',
    'Customers',
    'Manage customer accounts, status, limits, and traffic.',
    'system.view',
  ],
  [
    '/api-gateway',
    'API Gateway',
    'Manage API clients, traffic, authentication, and rate limits.',
    'system.view',
  ],
  ['/docker', 'Docker', 'Inspect and operate JKANNEL runtime containers.', 'system.view'],
  [
    '/logs-audit',
    'Logs & Audit',
    'Search runtime logs and immutable operator audit events.',
    'monitoring.view',
  ],
  [
    '/plugins',
    'Plugins',
    'Install, configure, enable, and inspect platform extensions.',
    'system.view',
  ],
  [
    '/backup',
    'Backup & Restore',
    'Create, verify, download, and restore platform backups.',
    'system.view',
  ],
  ['/users', 'Users & Roles', 'Administer identities and access policies.', 'users.view'],
  [
    '/system',
    'System Settings',
    'Manage platform-level preferences and integrations.',
    'system.view',
  ],
] as const;

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { title: 'Sign in', description: '', breadcrumb: [], publicLayout: true },
  },
  {
    path: '/accept-invitation',
    name: 'accept-invitation',
    component: () => import('../views/AcceptInvitationView.vue'),
    meta: { title: 'Accept invitation', description: '', breadcrumb: [], publicLayout: true },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('../views/PasswordResetView.vue'),
    meta: { title: 'Reset password', description: '', breadcrumb: [], publicLayout: true },
  },
  {
    path: '/',
    redirect: '/dashboard/operations',
    meta: { title: 'Home', description: '', breadcrumb: [] },
  },
  {
    path: '/dashboard/operations',
    name: 'operations',
    component: OperationsOverview,
    meta: {
      title: 'Operations Dashboard',
      description: 'Live situational awareness across the messaging platform.',
      breadcrumb: ['Dashboard', 'Operations'],
      permission: 'dashboard.view',
    },
  },
  ...modules.map(([path, title, description, permission]) => ({
    path,
    name: path.slice(1),
    component: ModuleWorkspace,
    meta: { title, description, breadcrumb: [title], permission },
  })),
  {
    path: '/copilot',
    name: 'copilot',
    component: CopilotView,
    meta: {
      title: 'AI Operations Copilot',
      description: 'Ask read-only, advisory questions about platform telemetry.',
      breadcrumb: ['AI Copilot'],
      permission: 'monitoring.view',
    },
  },
  {
    path: '/reports',
    name: 'reports',
    component: AnalyticsView,
    meta: {
      title: 'Reports',
      description: 'Build and export operational reports.',
      breadcrumb: ['Reports'],
      permission: 'reports.view',
    },
  },
  {
    path: '/bulk-send',
    name: 'bulk-send',
    component: BulkSendView,
    meta: {
      title: 'Bulk Send',
      description: 'Queue a message to many recipients and track campaign delivery.',
      breadcrumb: ['Bulk Send'],
      permission: 'messages.view',
    },
  },
  {
    path: '/live-queue',
    name: 'live-queue',
    component: LiveQueueView,
    meta: {
      title: 'Live Queue',
      description:
        'Watch the live queue and per-bind engine state, and move traffic to another bind without restarting the engine.',
      breadcrumb: ['Live Queue'],
      permission: 'messages.view',
    },
  },
  {
    path: '/alert-response',
    name: 'alert-response',
    component: AlertResponseView,
    meta: {
      title: 'Escalation & Maintenance',
      description:
        'Define who an unacknowledged alert escalates to, and suppress alerting during planned work.',
      breadcrumb: ['Alerts', 'Escalation & Maintenance'],
      permission: 'alerts.view',
    },
  },
  {
    path: '/alert-lifecycle',
    name: 'alert-lifecycle',
    component: AlertLifecycleView,
    meta: {
      title: 'Alert Lifecycle',
      description:
        'Acknowledge, resolve, assign, suppress, reopen and close an alert, and keep the incident thread on the alert itself.',
      breadcrumb: ['Alerts', 'Lifecycle'],
      permission: 'alerts.view',
    },
  },
  {
    path: '/log-explorer',
    name: 'log-explorer',
    component: LogExplorerView,
    meta: {
      title: 'Log Explorer',
      description:
        'Search this API process’s in-memory log buffer by correlation id, level, route and time window. Not durable storage.',
      breadcrumb: ['Log Explorer'],
      permission: 'system.view',
    },
  },
  {
    path: '/routing-advanced',
    name: 'routing-advanced',
    component: RoutingDepthView,
    meta: {
      title: 'Advanced Routing',
      description:
        'Prefix, country, operator and weighted routes, selection strategies, version history, and a resolve preview.',
      breadcrumb: ['Routing', 'Advanced'],
      permission: 'routes.view',
    },
  },
  {
    path: '/roles',
    name: 'roles',
    component: RolesView,
    meta: {
      title: 'Roles & Permissions',
      description: 'Review every role, the permissions it grants, and who holds it.',
      breadcrumb: ['Roles & Permissions'],
      permission: 'users.view',
    },
  },
  {
    path: '/sessions',
    name: 'sessions',
    component: SessionsView,
    meta: {
      title: 'Sessions',
      description: 'Review and revoke active operator sessions.',
      breadcrumb: ['Sessions'],
      permission: 'users.sessions',
    },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: ModuleWorkspace,
    meta: {
      title: 'Access restricted',
      description: 'Your current role does not permit this workspace.',
      breadcrumb: ['Access restricted'],
    },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: {
      title: 'Page not found',
      description: 'The requested JKANNEL workspace does not exist.',
      breadcrumb: ['Not found'],
      publicLayout: true,
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach((to) => {
  return initializeSession().then(() => {
    if (to.meta.publicLayout && isAuthenticated.value) return { name: 'operations' };
    if (!to.meta.publicLayout && !isAuthenticated.value) return { name: 'login' };
    const required = to.meta.permission;
    if (required && !canAccess(session.value, required)) return { name: 'forbidden' };
  });
});

router.afterEach((to) => {
  document.title = `${to.meta.title} · JKANNEL`;
});

export default router;
