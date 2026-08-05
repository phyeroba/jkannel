export interface NavigationItem {
  label: string;
  to: string;
  icon: string;
  /** Absent means every authenticated user may open the workspace. */
  permission?: string;
  group: 'Operations' | 'Messaging' | 'Insights' | 'Platform';
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
    group: 'Operations',
  },
  {
    label: 'Monitoring',
    to: '/monitoring',
    icon: 'chart',
    permission: 'monitoring.view',
    group: 'Operations',
  },
  { label: 'Alerts', to: '/alerts', icon: 'alert', permission: 'alerts.view', group: 'Operations' },
  {
    label: 'Alert Lifecycle',
    to: '/alert-lifecycle',
    icon: 'alert',
    permission: 'alerts.view',
    group: 'Operations',
  },
  {
    label: 'Escalation & Maintenance',
    to: '/alert-response',
    icon: 'bell',
    permission: 'alerts.view',
    group: 'Operations',
  },
  { label: 'Notifications', to: '/notifications', icon: 'bell', group: 'Operations' },
  {
    label: 'Messages',
    to: '/messages',
    icon: 'sms',
    permission: 'messages.view',
    group: 'Messaging',
  },
  {
    label: 'Live Queue',
    to: '/live-queue',
    icon: 'queue',
    permission: 'messages.view',
    group: 'Messaging',
  },
  {
    label: 'Queues',
    to: '/queues',
    icon: 'queue',
    permission: 'messages.view',
    group: 'Messaging',
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
    label: 'SMSC Connections',
    to: '/smsc',
    icon: 'server',
    permission: 'smsc.view',
    group: 'Messaging',
  },
  {
    label: 'Routing',
    to: '/routing',
    icon: 'route',
    permission: 'routes.view',
    group: 'Messaging',
  },
  {
    label: 'Advanced Routing',
    to: '/routing-advanced',
    icon: 'route',
    permission: 'routes.view',
    group: 'Messaging',
  },
  {
    label: 'Configuration',
    to: '/configuration',
    icon: 'cog',
    permission: 'configuration.view',
    group: 'Messaging',
  },
  {
    label: 'Analytics & Reports',
    to: '/reports',
    icon: 'chart',
    permission: 'reports.view',
    group: 'Insights',
  },
  {
    label: 'Customers',
    to: '/customers',
    icon: 'users',
    permission: 'system.view',
    group: 'Insights',
  },
  {
    label: 'AI Copilot',
    to: '/copilot',
    icon: 'spark',
    permission: 'monitoring.view',
    group: 'Insights',
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
    group: 'Platform',
  },
  {
    label: 'Logs & Audit',
    to: '/logs-audit',
    icon: 'terminal',
    permission: 'monitoring.view',
    group: 'Platform',
  },
  {
    label: 'Log Explorer',
    to: '/log-explorer',
    icon: 'terminal',
    permission: 'system.view',
    group: 'Platform',
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
    group: 'Platform',
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
