/**
 * Every navigable workspace and the stable root `data-testid` that proves it
 * rendered. Kept as a local copy (rather than importing frontend/src) so the
 * e2e project stays self-contained. Mirrors frontend/src/navigation.ts +
 * router/index.ts. `root` is asserted visible in the navigation smoke test.
 *
 * The three ModuleWorkspace "custom render" routes (Sessions has its own view)
 * still render the `module-workspace` wrapper, so the generic marker holds.
 *
 * The parameterised detail routes (`/carriers/:id`, `/smsc/:engineId`) are not
 * listed: they are not navigable workspaces and cannot be opened without an
 * entity that exists in the deployment under test.
 */
export interface WorkspaceRoute {
  label: string;
  path: string;
  /** A data-testid that is present once the workspace has rendered. */
  root: string;
}

export const workspaceRoutes: WorkspaceRoute[] = [
  { label: 'Operations', path: '/dashboard/operations', root: 'refresh-dashboard' },
  { label: 'Monitoring', path: '/monitoring', root: 'module-workspace' },
  { label: 'Alerts', path: '/alerts', root: 'module-workspace' },
  { label: 'Escalation & Maintenance', path: '/alert-response', root: 'alert-response-view' },
  { label: 'Alert Lifecycle', path: '/alert-lifecycle', root: 'alert-lifecycle-view' },
  { label: 'Notifications', path: '/notifications', root: 'module-workspace' },
  { label: 'Messages', path: '/messages', root: 'module-workspace' },
  { label: 'Live Queue', path: '/live-queue', root: 'live-queue-view' },
  { label: 'Queues', path: '/queues', root: 'module-workspace' },
  { label: 'Delivery Reports', path: '/delivery-reports', root: 'module-workspace' },
  { label: 'Bulk Send', path: '/bulk-send', root: 'bulk-send-view' },
  { label: 'Content Filtering', path: '/content-rules', root: 'content-rules-view' },
  { label: 'Inbound Routing', path: '/mo-routing', root: 'mo-routing-view' },
  { label: 'Carriers', path: '/carriers', root: 'carriers-view' },
  { label: 'SMSC Connections', path: '/smsc', root: 'module-workspace' },
  { label: 'SMPP Sessions', path: '/sessions-smpp', root: 'smpp-sessions-view' },
  { label: 'Routing', path: '/routing', root: 'module-workspace' },
  { label: 'Advanced Routing', path: '/routing-advanced', root: 'routing-depth-view' },
  { label: 'Configuration', path: '/configuration', root: 'module-workspace' },
  { label: 'Analytics & Reports', path: '/reports', root: 'analytics-view' },
  { label: 'Customers', path: '/customers', root: 'module-workspace' },
  { label: 'AI Copilot', path: '/copilot', root: 'copilot-view' },
  { label: 'API Gateway', path: '/api-gateway', root: 'module-workspace' },
  { label: 'API Reference', path: '/api-reference', root: 'api-reference-view' },
  { label: 'Runtime Containers', path: '/docker', root: 'module-workspace' },
  { label: 'Logs & Audit', path: '/logs-audit', root: 'module-workspace' },
  { label: 'Log Explorer', path: '/log-explorer', root: 'log-explorer-view' },
  { label: 'Plugins', path: '/plugins', root: 'module-workspace' },
  { label: 'Backup & Restore', path: '/backup', root: 'module-workspace' },
  { label: 'Users & Roles', path: '/users', root: 'module-workspace' },
  { label: 'Roles & Permissions', path: '/roles', root: 'roles-view' },
  { label: 'Sessions', path: '/sessions', root: 'sessions-view' },
  { label: 'System Settings', path: '/system', root: 'module-workspace' },
  { label: 'Documentation & Help', path: '/help', root: 'help-view' },
];
