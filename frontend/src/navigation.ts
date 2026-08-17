/**
 * Sidebar sections, in render order. Six from the specification's information
 * architecture, then the three this product adds.
 */
export const NAVIGATION_GROUPS = [
  'Overview',
  'Connectivity',
  'Traffic',
  'Routing',
  'Diagnostics',
  'System',
  'Messaging',
  'Customers',
  'Platform',
] as const;

export type NavigationGroup = (typeof NAVIGATION_GROUPS)[number];

export interface NavigationItem {
  label: string;
  to: string;
  icon: string;
  /** Absent means every authenticated user may open the workspace. */
  permission?: string;
  /**
   * Section in the sidebar. The first six are the information architecture of
   * the Kamex UI Redesign Functional Specification (§2), built on the
   * operational hierarchy Carrier -> SMSC -> Session -> Route -> Queue ->
   * Message -> DLR.
   *
   * The last three are JKANNEL's own. The specification puts customer
   * provisioning, billing and API credentials explicitly out of scope for a
   * gateway console (§1.3) — but this product ships them and they work, so they
   * sit alongside the operational sections rather than being removed. See
   * docs/redesign/PLAN.md §0.
   */
  group: NavigationGroup;
  badge?: string;
}

/**
 * The operator guides live in the repository (`docs/user-guides/`) as Markdown.
 * The SPA cannot serve those files, so every guide link points at the
 * GitHub-hosted copy and opens in a new tab. The in-app /help workspace is what
 * makes them findable without leaving the console.
 */
export const documentationUrl = 'https://github.com/phyeroba/jkannel/tree/main/docs/user-guides';
const guideUrl = (file: string) =>
  `https://github.com/phyeroba/jkannel/blob/main/docs/user-guides/${file}`;

export interface UserGuide {
  /** Guide number as published in docs/user-guides/README.md. */
  number: number;
  title: string;
  /** "Read it when you want to…", verbatim from the guide index. */
  purpose: string;
  url: string;
  /** Console route the guide is about, when there is exactly one. */
  route?: string;
}

/** Mirrors the table in docs/user-guides/README.md, in the same order. */
export const userGuides: UserGuide[] = [
  {
    number: 1,
    title: 'Getting started and console tour',
    purpose:
      'Sign in for the first time, learn the navigation, and understand the conventions every screen shares.',
    url: guideUrl('01-getting-started.md'),
    route: '/dashboard/operations',
  },
  {
    number: 2,
    title: 'Connecting an SMSC',
    purpose:
      'Add a gateway connection, generate and deploy its configuration, and get a carrier bind up.',
    url: guideUrl('02-connecting-an-smsc.md'),
    route: '/smsc',
  },
  {
    number: 3,
    title: 'Sending messages',
    purpose: 'Send one message, run a bulk campaign, or submit over the REST API with an API key.',
    url: guideUrl('03-sending-messages.md'),
    route: '/bulk-send',
  },
  {
    number: 4,
    title: 'Live Queue: watching traffic and recovering a bad bind',
    purpose: 'A bind has gone bad and traffic is failing. This is the flagship operator workflow.',
    url: guideUrl('04-live-queue-and-recovery.md'),
    route: '/live-queue',
  },
  {
    number: 5,
    title: 'Routing',
    purpose: 'Decide which carrier a message takes, and answer “why did this message go that way?”',
    url: guideUrl('05-routing.md'),
    route: '/routing',
  },
  {
    number: 6,
    title: 'Monitoring and alerts',
    purpose: 'Know when something breaks, and make sure a human actually hears about it.',
    url: guideUrl('06-monitoring-and-alerts.md'),
    route: '/alerts',
  },
  {
    number: 7,
    title: 'Reports and exports',
    purpose: 'Get numbers out — on screen, as CSV/PDF, or on a schedule.',
    url: guideUrl('07-reports-and-exports.md'),
    route: '/reports',
  },
  {
    number: 8,
    title: 'Customers, quotas, credit and sender IDs',
    purpose: 'Control what each account may send, and how much.',
    url: guideUrl('08-customers-and-quotas.md'),
    route: '/customers',
  },
  {
    number: 9,
    title: 'Backup and restore',
    purpose: 'Protect the control plane’s data and prove a backup is usable.',
    url: guideUrl('09-backup-and-restore.md'),
    route: '/backup',
  },
  {
    number: 10,
    title: 'Users, roles and permissions',
    purpose: 'Give people access — and understand what is read-only today.',
    url: guideUrl('10-users-and-roles.md'),
    route: '/users',
  },
  {
    number: 11,
    title: 'Troubleshooting and FAQ',
    purpose: 'Something is wrong and you want the short answer.',
    url: guideUrl('11-troubleshooting.md'),
    route: '/logs-audit',
  },
];

export const navigation: NavigationItem[] = [
  {
    label: 'Operations',
    to: '/dashboard/operations',
    icon: 'home',
    permission: 'dashboard.view',
    group: 'Overview',
  },
  {
    label: 'Monitoring',
    to: '/monitoring',
    icon: 'chart',
    permission: 'monitoring.view',
    group: 'System',
  },
  { label: 'Alerts', to: '/alerts', icon: 'alert', permission: 'alerts.view', group: 'Overview' },
  {
    label: 'Alert Lifecycle',
    to: '/alert-lifecycle',
    icon: 'alert',
    permission: 'alerts.view',
    group: 'Overview',
  },
  {
    label: 'Escalation & Maintenance',
    to: '/alert-response',
    icon: 'bell',
    permission: 'alerts.view',
    group: 'Overview',
  },
  { label: 'Notifications', to: '/notifications', icon: 'bell', group: 'Overview' },
  {
    label: 'Messages',
    to: '/messages',
    icon: 'sms',
    permission: 'messages.view',
    group: 'Messaging',
  },
  // Traffic, in the specification's order (§2): what is moving now, what is
  // waiting, and whether it arrived. Live Queue is JKANNEL's own recovery
  // workflow and sits last, after the three observational screens.
  {
    label: 'Live Traffic',
    to: '/live-traffic',
    icon: 'chart',
    permission: 'messages.view',
    group: 'Traffic',
  },
  {
    label: 'Queues',
    to: '/queues',
    icon: 'queue',
    permission: 'messages.view',
    group: 'Traffic',
  },
  {
    // reports.view, not messages.view: the funnel is computed by the reporting
    // endpoint and that is the permission it enforces. Listing it under a
    // permission the API does not check would put a dead link in the sidebar.
    label: 'DLR Performance',
    to: '/dlr-performance',
    icon: 'check',
    permission: 'reports.view',
    group: 'Traffic',
  },
  {
    label: 'Live Queue',
    to: '/live-queue',
    icon: 'queue',
    permission: 'messages.view',
    group: 'Traffic',
  },
  {
    label: 'Delivery Reports',
    to: '/delivery-reports',
    icon: 'check',
    permission: 'messages.view',
    group: 'Messaging',
  },
  {
    label: 'Bulk Send',
    to: '/bulk-send',
    icon: 'sms',
    permission: 'messages.view',
    group: 'Messaging',
  },
  {
    label: 'Content Filtering',
    to: '/content-rules',
    icon: 'shield',
    permission: 'messages.view',
    group: 'Messaging',
  },
  {
    label: 'Inbound Routing',
    to: '/mo-routing',
    icon: 'route',
    permission: 'messages.view',
    group: 'Messaging',
  },
  // Connectivity, in the specification's own drill-down order: Carrier -> SMSC
  // -> Session (§2, §4, §5).
  {
    label: 'Carriers',
    to: '/carriers',
    icon: 'db',
    permission: 'smsc.view',
    group: 'Connectivity',
  },
  {
    label: 'SMSC Connections',
    to: '/smsc',
    icon: 'server',
    permission: 'smsc.view',
    group: 'Connectivity',
  },
  {
    // "SMPP Sessions", not "Sessions": /sessions is operator login sessions and
    // an operator must never have to guess which of the two a link means.
    label: 'SMPP Sessions',
    to: '/sessions-smpp',
    icon: 'api',
    permission: 'smsc.view',
    group: 'Connectivity',
  },
  {
    label: 'Routing',
    to: '/routing',
    icon: 'route',
    permission: 'routes.view',
    group: 'Routing',
  },
  {
    label: 'Advanced Routing',
    to: '/routing-advanced',
    icon: 'route',
    permission: 'routes.view',
    group: 'Routing',
  },
  {
    label: 'Configuration',
    to: '/configuration',
    icon: 'cog',
    permission: 'configuration.view',
    group: 'Diagnostics',
  },
  {
    label: 'Analytics & Reports',
    to: '/reports',
    icon: 'chart',
    permission: 'reports.view',
    group: 'Customers',
  },
  {
    label: 'Customers',
    to: '/customers',
    icon: 'users',
    permission: 'system.view',
    group: 'Customers',
  },
  {
    label: 'AI Copilot',
    to: '/copilot',
    icon: 'spark',
    permission: 'monitoring.view',
    group: 'Customers',
  },
  {
    label: 'API Gateway',
    to: '/api-gateway',
    icon: 'api',
    permission: 'system.view',
    group: 'Platform',
  },
  // No permission: an API reference is documentation, and the OpenAPI document
  // it renders is served unauthenticated by the backend.
  {
    label: 'API Reference',
    to: '/api-reference',
    icon: 'api',
    group: 'Platform',
  },
  {
    label: 'Runtime Containers',
    to: '/docker',
    icon: 'docker',
    permission: 'system.view',
    group: 'System',
  },
  {
    label: 'Logs & Audit',
    to: '/logs-audit',
    icon: 'terminal',
    permission: 'monitoring.view',
    group: 'System',
  },
  {
    label: 'Log Explorer',
    to: '/log-explorer',
    icon: 'terminal',
    permission: 'system.view',
    group: 'Diagnostics',
  },
  {
    label: 'Plugins',
    to: '/plugins',
    icon: 'plugin',
    permission: 'system.view',
    group: 'Platform',
  },
  {
    label: 'Backup & Restore',
    to: '/backup',
    icon: 'db',
    permission: 'system.view',
    group: 'System',
  },
  {
    label: 'Users & Roles',
    to: '/users',
    icon: 'shield',
    permission: 'users.view',
    group: 'Platform',
  },
  {
    label: 'Roles & Permissions',
    to: '/roles',
    icon: 'shield',
    permission: 'users.view',
    group: 'Platform',
  },
  {
    label: 'Sessions',
    to: '/sessions',
    icon: 'key',
    permission: 'users.sessions',
    group: 'Platform',
  },
  {
    label: 'System Settings',
    to: '/system',
    icon: 'cog',
    permission: 'system.view',
    group: 'Platform',
  },
  // No permission: help is for whoever is lost, whatever their role.
  {
    label: 'Documentation & Help',
    to: '/help',
    icon: 'help',
    group: 'Platform',
  },
];
