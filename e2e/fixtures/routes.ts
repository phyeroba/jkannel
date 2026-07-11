/**
 * Every navigable workspace and the stable root `data-testid` that proves it
 * rendered. Kept as a local copy (rather than importing frontend/src) so the
 * e2e project stays self-contained. Mirrors frontend/src/navigation.ts +
 * router/index.ts. `root` is asserted visible in the navigation smoke test.
 *
 * The three ModuleWorkspace "custom render" routes (Sessions has its own view)
 * still render the `module-workspace` wrapper, so the generic marker holds.
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
  { label: 'Notifications', path: '/notifications', root: 'module-workspace' },
  { label: 'Messages', path: '/messages', root: 'module-workspace' },
  { label: 'Queues', path: '/queues', root: 'module-workspace' },
  { label: 'Delivery Reports', path: '/delivery-reports', root: 'module-workspace' },
  { label: 'Bulk Send', path: '/bulk-send', root: 'bulk-send-view' },
  { label: 'SMSC Connections', path: '/smsc', root: 'module-workspace' },
  { label: 'Routing', path: '/routing', root: 'module-workspace' },
  { label: 'Configuration', path: '/configuration', root: 'module-workspace' },
  { label: 'Analytics & Reports', path: '/reports', root: 'analytics-view' },
  { label: 'Customers', path: '/customers', root: 'module-workspace' },
  { label: 'AI Copilot', path: '/copilot', root: 'copilot-view' },
  { label: 'API Gateway', path: '/api-gateway', root: 'module-workspace' },
  { label: 'Runtime Containers', path: '/docker', root: 'module-workspace' },
  { label: 'Logs & Audit', path: '/logs-audit', root: 'module-workspace' },
  { label: 'Plugins', path: '/plugins', root: 'module-workspace' },
  { label: 'Backup & Restore', path: '/backup', root: 'module-workspace' },
  { label: 'Users & Roles', path: '/users', root: 'module-workspace' },
  { label: 'Sessions', path: '/sessions', root: 'sessions-view' },
  { label: 'System Settings', path: '/system', root: 'module-workspace' },
];
