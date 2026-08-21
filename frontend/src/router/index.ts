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
import ContentRulesView from '../views/ContentRulesView.vue';
import MoRoutingView from '../views/MoRoutingView.vue';
import RolesView from '../views/RolesView.vue';
import ApiReferenceView from '../views/ApiReferenceView.vue';
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
  // "Inspect", not "inspect and operate": there is exactly one route behind
  // this screen, GET /docker/containers. The backend has no Docker socket and
  // no start/stop/restart verb, so promising operation was copy describing a
  // capability that does not exist.
  [
    '/docker',
    'Docker',
    'Inspect the declared JKANNEL runtime containers. Read-only — the backend cannot start, stop or restart them.',
    'system.view',
  ],
  [
    '/logs-audit',
    'Logs & Audit',
    // Runtime logs are the separate Log Explorer workspace; this one is the
    // immutable audit trail. The old description promised both here.
    'Search the immutable operator audit trail. Runtime logs live in Log Explorer.',
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
    // No "download": there is no artifact-download route and no control for it.
    'Create, verify, schedule, and restore platform backups.',
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
    // messages.view, matching the read permission on the content-rule
    // controller; mutations additionally need messages.send and the view says so.
    path: '/content-rules',
    name: 'content-rules',
    component: ContentRulesView,
    meta: {
      title: 'Content Filtering',
      description:
        'Block or allow outbound traffic by body, sender or recipient, see which rule decides a message first, and find the rules that can never fire.',
      breadcrumb: ['Messaging', 'Content Filtering'],
      permission: 'messages.view',
    },
  },
  {
    path: '/mo-routing',
    name: 'mo-routing',
    component: MoRoutingView,
    meta: {
      title: 'Inbound Routing',
      description:
        'Fan an inbound message out to webhook, email or SMS destinations, and see which ingest path is actually delivering them.',
      breadcrumb: ['Messaging', 'Inbound Routing'],
      permission: 'messages.view',
    },
  },
  {
    // Carrier → SMSC → bind is the operational hierarchy the specification is
    // built around (§4). All four routes read `smsc.view`; the carrier object
    // is an organisational label over SMSCs and carries nothing an operator
    // could not already reach through them, so it does not introduce a
    // permission an existing SMSC administrator would not already hold.
    path: '/carriers',
    name: 'carriers',
    component: () => import('../views/CarriersView.vue'),
    meta: {
      title: 'Carriers',
      description:
        'Every network the gateway connects to, its rolled-up bind health, and the SMSC connections not yet filed under one.',
      breadcrumb: ['Carriers'],
      permission: 'smsc.view',
    },
  },
  {
    path: '/carriers/:id',
    name: 'carrier-detail',
    component: () => import('../views/CarrierDetailView.vue'),
    meta: {
      // The static crumb is a placeholder: the view publishes the real trail
      // (Carriers / MTN Uganda) once the carrier's name is known.
      title: 'Carrier',
      description: 'One carrier, its health roll-up, and the SMSC connections filed under it.',
      breadcrumb: ['Carriers', 'Carrier'],
      permission: 'smsc.view',
    },
  },
  {
    // The audit trail carries a tamper-evidence chain and nothing in the
    // console could verify it. An audit trail nobody can check is a record you
    // are asked to take on trust, which is the opposite of what it is for.
    path: '/data-integrity',
    name: 'data-integrity',
    component: () => import('../views/DataIntegrityView.vue'),
    meta: {
      title: 'Data Integrity',
      description:
        'Verify the audit trail’s tamper-evidence chain, see what retention is archiving and pruning per table, and exercise the platform’s optimistic-locking conventions.',
      breadcrumb: ['System', 'Data Integrity'],
      permission: 'system.view',
    },
  },
  {
    // Held sends could be created and then neither seen, cancelled nor moved
    // from the console — the only way to stop one was to call the API by hand,
    // against a deadline.
    path: '/scheduled-sends',
    name: 'scheduled-sends',
    component: () => import('../views/ScheduledSendsView.vue'),
    meta: {
      title: 'Scheduled Sends',
      description:
        'Messages held for a future instant, soonest first, with the two things you can still do to one — cancel it or move it — offered only while it can actually be stopped.',
      breadcrumb: ['Messaging', 'Scheduled Sends'],
      permission: 'messages.view',
    },
  },
  {
    // The blacklist / whitelist / DND lists the send path has consulted since
    // migration 032, with no screen anywhere that could say a number was on
    // one. A blocked destination produces no receipt and no trace, so its
    // symptom is "the message vanished" — which is a poor thing to have no
    // answer for.
    path: '/recipient-policy',
    name: 'recipient-policy',
    component: () => import('../views/RecipientPolicyView.vue'),
    meta: {
      title: 'Recipient Policy',
      description:
        'The blacklist, whitelist and DND lists the send path evaluates before choosing a route, and a check that answers whether one destination would be accepted right now.',
      breadcrumb: ['Messaging', 'Recipient Policy'],
      permission: 'messages.view',
    },
  },
  {
    // Nine delivery-retry operations with no surface: retrying could be switched
    // on, tuned and swept only by calling the API, so nobody using the console
    // could see whether it was on or what it had done. Retrying spends a
    // customer's credit, which makes that a poor thing to leave invisible.
    path: '/delivery-retries',
    name: 'delivery-retries',
    component: () => import('../views/DeliveryRetriesView.vue'),
    meta: {
      title: 'Delivery Retries',
      description:
        'Which failed messages were re-sent, each attempt and the bind it used, and the policy that decides whether a failure is retried at all.',
      breadcrumb: ['Traffic', 'Delivery Retries'],
      permission: 'messages.view',
    },
  },
  {
    // The fifteen customer-account operations — quota, credit ledger, sender-id
    // approval and route bindings — had no console surface at all before this.
    // A detail route rather than more panels on the register: they are things
    // you do TO one account, and the register is for finding it.
    path: '/customers/:id',
    name: 'customer-detail',
    component: () => import('../views/CustomerDetailView.vue'),
    meta: {
      title: 'Customer',
      description:
        'One customer account: its message quota per period, its credit ledger, the sender IDs it may use, and the routes its traffic is bound to.',
      breadcrumb: ['Customers', 'Customer'],
      permission: 'system.view',
    },
  },
  {
    path: '/smsc/:engineId',
    name: 'smsc-detail',
    component: () => import('../views/SmscDetailView.vue'),
    meta: {
      title: 'SMSC Connection',
      description:
        'Bind state, capacity against observed throughput, queue and counters, and the bind transition history for one connection.',
      breadcrumb: ['SMSC Connections', 'Connection'],
      permission: 'smsc.view',
    },
  },
  {
    // NOT /sessions — that is operator login sessions and stays that way.
    path: '/sessions-smpp',
    name: 'sessions-smpp',
    component: () => import('../views/SmppSessionsView.vue'),
    meta: {
      title: 'SMPP Sessions',
      description:
        'Every configured bind across the estate, with an explicit statement of the per-session detail this engine cannot report.',
      breadcrumb: ['SMPP Sessions'],
      permission: 'smsc.view',
    },
  },
  {
    // §14. Separate from /docker, which lists declared Compose services; this
    // is the component register with dependency attribution, and it says which
    // components nothing is watching.
    path: '/services',
    name: 'services',
    component: () => import('../views/ServicesView.vue'),
    meta: {
      title: 'Services',
      description:
        'Every component the gateway depends on, its observed state, and which dependency explains a failure — plus the components nothing watches.',
      breadcrumb: ['Services'],
      permission: 'system.view',
    },
  },
  {
    path: '/nodes',
    name: 'nodes',
    component: () => import('../views/NodesView.vue'),
    meta: {
      title: 'Nodes',
      description:
        'Resource pressure on the one node JKANNEL can measure, with an explicit statement of the host figures it cannot.',
      breadcrumb: ['Nodes'],
      permission: 'system.view',
    },
  },
  {
    // Traffic, in the specification's own order: what is moving now, what is
    // waiting, and whether it arrived (§6, §7, §8). Queues is not here because
    // it is the existing /queues workspace with the §7 rates panel added to it.
    path: '/live-traffic',
    name: 'live-traffic',
    component: () => import('../views/LiveTrafficView.vue'),
    meta: {
      title: 'Live Traffic',
      description:
        'MT and MO throughput per bind, updating in place without reordering, with an explicit statement of the receipt rate the engine does not report.',
      breadcrumb: ['Traffic', 'Live Traffic'],
      permission: 'messages.view',
    },
  },
  {
    path: '/dlr-performance',
    name: 'dlr-performance',
    component: () => import('../views/DlrPerformanceView.vue'),
    meta: {
      title: 'DLR Performance',
      description:
        'The delivery funnel and both delivery rates over the shared time range, per bind on identical windows, with a prominent warning when the window is too recent to conclude from.',
      breadcrumb: ['Traffic', 'DLR Performance'],
      permission: 'reports.view',
    },
  },
  {
    // Gateway-side performance (§14, §18). A System screen and not a Traffic
    // one: it answers "can this gateway carry more", which is a capacity
    // question about the platform, whereas DLR Performance answers "is the
    // carrier delivering", which is a question about someone else's network.
    path: '/performance',
    name: 'performance',
    component: () => import('../views/PerformanceView.vue'),
    meta: {
      title: 'Performance',
      description:
        'Gateway throughput against the sum of declared carrier ceilings, at the poller’s measured sampling interval, with the latencies this engine cannot report named rather than left blank.',
      breadcrumb: ['System', 'Performance'],
      permission: 'smsc.view',
    },
  },
  {
    // Safe control (§9, §16). Failover is a Routing screen and not an SMSC one:
    // the thing being moved is a route's traffic, and the override lives on the
    // route rather than on either connection.
    path: '/failover',
    name: 'failover',
    component: () => import('../views/FailoverView.vue'),
    meta: {
      title: 'Failover',
      description:
        'Every manual override in effect, the path each route is actually on, and a health and capacity comparison before traffic is moved.',
      breadcrumb: ['Routing', 'Failover'],
      permission: 'routes.view',
    },
  },
  {
    path: '/route-simulator',
    name: 'route-simulator',
    component: () => import('../views/RouteSimulatorView.vue'),
    meta: {
      title: 'Route Simulator',
      // The description is the first place the non-transmitting promise is made;
      // the screen itself repeats it above the form (UC-RTE-01).
      description:
        'Resolve a destination against the live routing rules and read the full decision trace. Nothing is transmitted.',
      breadcrumb: ['Routing', 'Route Simulator'],
      permission: 'routes.view',
    },
  },
  {
    // Diagnostics, in the specification's own order (§10, §11, §12): one
    // message, then the protocol vocabulary, then everything the system saw.
    path: '/message-trace',
    name: 'message-trace',
    component: () => import('../views/MessageTraceView.vue'),
    meta: {
      title: 'Message Trace',
      description:
        'One message end to end — routing decision, spool, submission, retries and receipt — with the time each stage took and the first abnormal stage called out above the timeline.',
      // A placeholder trail: the view publishes Message Trace / <id> once an id
      // has actually been traced.
      breadcrumb: ['Diagnostics', 'Message Trace'],
      permission: 'messages.view',
    },
  },
  {
    path: '/smpp-errors',
    name: 'smpp-errors',
    component: () => import('../views/SmppErrorsView.vue'),
    meta: {
      title: 'SMPP Errors',
      description:
        'Every SMPP command status this build can decode, with a plain explanation and a suggested check labelled as guidance rather than a diagnosis, plus a lookup that takes decimal or hex.',
      breadcrumb: ['Diagnostics', 'SMPP Errors'],
      permission: 'smsc.view',
    },
  },
  {
    path: '/events',
    name: 'events',
    component: () => import('../views/EventsView.vue'),
    meta: {
      title: 'Events',
      description:
        'What the system observed, over the shared time range, with a correlation drill-down that puts events, alerts, audit entries and logs on one screen — and states why the logs may be missing.',
      breadcrumb: ['Diagnostics', 'Events'],
      permission: 'monitoring.view',
    },
  },
  {
    // routes.view, matching the number/prefix lookup — the one tool here whose
    // endpoint is the reason to open the screen. The connectivity test and the
    // tagged-send register are additionally gated inside the view, because they
    // read smsc.manage and messages.view respectively and a panel an operator
    // cannot use must say so rather than 403 on click.
    path: '/test-tools',
    name: 'test-tools',
    component: () => import('../views/TestToolsView.vue'),
    meta: {
      title: 'Test Tools',
      description:
        'Number and prefix lookup, encoding and segment analysis, an SMPP connectivity test that reports how far it actually got, and the register of tagged test traffic.',
      breadcrumb: ['Diagnostics', 'Test Tools'],
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
    // No `permission`: this is documentation, and the document it renders is
    // itself served unauthenticated by the backend (OpenApiController carries no
    // guard). Gating the reader behind system.view would restrict the reference
    // more tightly than the thing it describes. Same reasoning as /help.
    path: '/api-reference',
    name: 'api-reference',
    component: ApiReferenceView,
    meta: {
      title: 'API Reference',
      description:
        'Every REST operation this deployment actually exposes, with the permission it requires — rendered live from the auto-generated OpenAPI document.',
      breadcrumb: ['API Reference'],
    },
  },
  {
    path: '/help',
    name: 'help',
    component: () => import('../views/HelpView.vue'),
    meta: {
      title: 'Documentation & Help',
      description: 'The operator guides, and the order to read them in.',
      breadcrumb: ['Help'],
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
