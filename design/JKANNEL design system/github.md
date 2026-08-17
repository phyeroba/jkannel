repo: dmushabe/jkannel
branch: main
path: frontend/, design/design_spec/, docs/, infrastructure/kannel/

## Redesign
The console UI kit was rebuilt to the uploaded **Kamex UI Redesign Functional
Specification** (six-section IA: Overview, Connectivity, Traffic, Routing,
Diagnostics, System). It no longer mirrors the repository's 33-workspace Vue
console, so the screen map below records the design system's own provenance for
tokens and icons only. See ui_kits/console/README.md for the new IA.

## Last sync
date: 2026-08-15T19:37:10Z

### Updated in this project
- Completed every console workspace under Operations and Messaging in the UI kit.
- Adopted DocFlow's --blue-50…900 accent ramp; ported the source stylesheet's responsive grid collapses.
- Compact KPI tiles, tinted table header band, row actions moved out of tables.
- Sidebar nav rebuilt as a compact accordion (one group open at a time).
- Regrounded every Messaging screen in docs/user-guides 02, 03, 05, 07 (columns, filters, actions, copy).
- Built every Platform workspace from guides 03, 10, 11 and the Docker specifications.
- Added a real mobile shell: off-canvas sidebar drawer, compact topbar, scrolling grids.
- Two-column layouts moved onto .split-grid so the source's ≤1050px collapses apply.

## Screen map
| Design-system file | Built from |
|---|---|
| tokens/colors.css, typography.css, spacing.css, layout.css, components.css | frontend/src/style.css, frontend/src/design-authority.css, design/design_spec/HANDOFF.md |
| assets/icons.js, components/core/Icon.jsx | frontend/src/components/AppIcon.vue |
| components/core/MetricCard.jsx | frontend/src/components/MetricCard.vue |
| components/data/MiniChart.jsx | frontend/src/components/MiniChart.vue |
| components/navigation/Tabs.jsx | .range-select segmented control in frontend/src/design-authority.css |
| ui_kits/console/LoginScreen.jsx, login.css | frontend/src/views/LoginView.vue, design-authority.css |
| ui_kits/console/AppShell.jsx | frontend/src/layouts/AppShell.vue, frontend/src/navigation.ts |
| ui_kits/console/DashboardScreen.jsx | frontend/src/views/OperationsOverview.vue |
| ui_kits/console/MonitoringScreen.jsx | /monitoring identity+health shape (OperationsOverview.vue) |
| ui_kits/console/AlertsScreen.jsx, AlertLifecycleScreen.jsx | frontend/src/views/AlertLifecycleView.vue |
| ui_kits/console/AlertResponseScreen.jsx | frontend/src/views/AlertResponseView.vue |
| ui_kits/console/NotificationsScreen.jsx | notification classes in design-authority.css |
| ui_kits/console/LiveQueueScreen.jsx | frontend/src/views/LiveQueueView.vue (panels + controls; columns approximate) |
| ui_kits/console/MessagesScreen.jsx | docs/user-guides/03-sending-messages.md (grid columns, message search filters, composer, trace + Replay/Clone/Requeue, SQLBox retention) |
| ui_kits/console/DeliveryReportsScreen.jsx | docs/user-guides/07-reports-and-exports.md ("Delivery reports as a grid") |
| ui_kits/console/SmscScreen.jsx | docs/user-guides/02-connecting-an-smsc.md (grid columns, Test/Reconnect/Disable/Archive, Create SMSC form) |
| ui_kits/console/RoutingScreen.jsx | docs/user-guides/05-routing.md (simple Routing screen: routes, Validate/Deploy/Rollback, Route simulator) |
| ui_kits/console/ConfigurationScreen.jsx | docs/user-guides/02-connecting-an-smsc.md steps 2 & 4 (versions, compare, drift, templates) |
| ui_kits/console/AnalyticsScreen.jsx | frontend/src/views/AnalyticsView.vue |
| ui_kits/console/ApiGatewayScreen.jsx | docs/user-guides/03-sending-messages.md (API key steps, scopes, gateway enforcement), 07 (client export) |
| ui_kits/console/ContainersScreen.jsx | docs/specifications/platform/DOCKER_ARCHITECTURE.md, DOCKER_DEPLOYMENT_ENGINEERING_SPECIFICATION.md, docs/user-guides/11 |
| ui_kits/console/LogsAuditScreen.jsx | docs/user-guides/11-troubleshooting.md ("Where the logs are"), 10 (hash-chained audit log) |
| ui_kits/console/UsersRolesScreen.jsx | docs/user-guides/10-users-and-roles.md (users grid, roles, permission matrix, sessions, guard rails) |
| ui_kits/console/HelpScreen.jsx | docs/user-guides/README.md index, docs/user-guides/11 FAQ |

## Sync history
- 2026-08-15T17:30Z — initial import: tokens, icon set, primitives, console UI kit, reference screenshots.
