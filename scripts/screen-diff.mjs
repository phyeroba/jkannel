// Compares each screen in the handed-over UI kit against the Vue view that
// implements it.
//
// `design-diff.mjs` proves the STYLE layer matches. That is necessary and not
// sufficient: a screen can be built entirely from correct components and still
// be missing half its columns, its filters, or a whole panel. This compares
// CONTENT — the panel titles the design names, the table columns it specifies,
// and the interaction primitives it uses.
//
// Matching is deliberately loose (case-insensitive, punctuation-stripped,
// substring). The goal is to find what is ABSENT, not to police wording; a
// false "present" is safer here than a false alarm that trains people to ignore
// the report.
import fs from 'node:fs';
import path from 'node:path';

const KIT = 'd:/JKANNEL/design/JKANNEL design system/ui_kits/console';
const SRC = 'd:/JKANNEL/frontend/src';

/**
 * Which Vue view implements which designed screen.
 *
 * `files` is a list because the console splits some designed screens across a
 * view and its components, and because several registers are rendered by the
 * generic ModuleWorkspace rather than a view of their own — for those the
 * workspace's column definition is where the columns actually live.
 */
const MAP = [
  ['DashboardScreen', ['views/OperationsOverview.vue']],
  ['AlertsScreen', ['views/AlertLifecycleView.vue', 'views/AlertResponseView.vue']],
  ['CarriersScreen', ['views/CarriersView.vue']],
  ['CarrierDetailScreen', ['views/CarrierDetailView.vue']],
  ['SmscsScreen', ['views/ModuleWorkspace.vue']],
  ['SmscDetailScreen', ['views/SmscDetailView.vue']],
  ['SessionsScreen', ['views/SmppSessionsView.vue']],
  ['TrafficScreen', ['views/LiveTrafficView.vue']],
  ['QueuesScreen', ['views/LiveQueueView.vue']],
  ['DlrScreen', ['views/DlrPerformanceView.vue']],
  ['RoutesScreen', ['views/RoutingDepthView.vue', 'views/ModuleWorkspace.vue']],
  ['FailoverScreen', ['views/FailoverView.vue']],
  ['SimulatorScreen', ['views/RouteSimulatorView.vue']],
  ['TraceScreen', ['views/MessageTraceView.vue']],
  ['SmppErrorsScreen', ['views/SmppErrorsView.vue']],
  ['EventsScreen', ['views/EventsView.vue']],
  ['LogsScreen', ['views/LogExplorerView.vue']],
  ['ToolsScreen', ['views/TestToolsView.vue']],
  ['EngineConfigScreen', ['views/ModuleWorkspace.vue']],
  ['ServicesScreen', ['views/ServicesView.vue']],
  ['ServiceDetailScreen', ['views/ServicesView.vue']],
  ['NodesScreen', ['views/NodesView.vue']],
  ['PerformanceScreen', ['views/AnalyticsView.vue']],
  ['AuditScreen', ['views/ModuleWorkspace.vue']],
  ['UsersScreen', ['views/ModuleWorkspace.vue', 'views/RolesView.vue']],
  ['LoginScreen', ['views/LoginView.vue']],
];

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Panel titles the design names, from <Panel title="…"> and bare <h2>/<h3>. */
function panels(jsx) {
  const out = new Set();
  for (const m of jsx.matchAll(/\btitle=(?:"([^"]{3,60})"|\{'([^']{3,60})'\})/g))
    out.add(m[1] ?? m[2]);
  for (const m of jsx.matchAll(/<h[23]>([^<{]{3,60})<\/h[23]>/g)) out.add(m[1]);
  return [...out];
}

/** Column headers, from <th>…</th>. Ignores the empty action column. */
function columns(jsx) {
  const out = new Set();
  for (const m of jsx.matchAll(/<th[^>]*>([^<{]{1,40})<\/th>/g)) {
    const label = m[1].trim();
    if (label) out.add(label);
  }
  return [...out];
}

/** Design-system primitives the screen relies on. */
const PRIMITIVES = [
  ['Drawer', /<Drawer\b/],
  ['PageAction', /<PageAction\b/],
  ['MiniChart', /<MiniChart\b/],
  ['BarChart', /<BarChart\b/],
  ['Timeline', /<Timeline\b/],
  ['ConfirmAction', /<ConfirmAction\b/],
  ['Tabs', /<Tabs\b/],
  ['DataTable', /<DataTable\b/],
  ['chip-scope', /className="chip/],
  ['stale-banner', /stale-banner/],
  ['breakdown-track', /breakdown-track/],
  ['health-list', /health-list/],
];
const VUE_PRIMITIVES = {
  Drawer: /drawer-sheet|DetailDrawer|drawer-scrim/,
  PageAction: /page-actions|PageAction|Teleport to="#page-actions"/,
  MiniChart: /MiniChart|mini-chart/,
  BarChart: /class="chart"|BarChart/,
  Timeline: /timeline|Timeline/,
  ConfirmAction: /ConfirmAction/,
  Tabs: /role="tablist"|class="tabs"|Tabs/,
  DataTable: /<table/,
  'chip-scope': /class="chip|'chip'/,
  'stale-banner': /stale-banner/,
  'breakdown-track': /breakdown-track/,
  'health-list': /health-list/,
};

let totalMissingCols = 0;
let totalMissingPanels = 0;
let totalMissingPrims = 0;
const rows = [];

for (const [screen, files] of MAP) {
  const jsx = read(path.join(KIT, `${screen}.jsx`));
  if (!jsx) {
    rows.push({ screen, note: 'NO SUCH SCREEN IN KIT' });
    continue;
  }
  const vue = files.map((f) => read(path.join(SRC, f))).join('\n');
  const haystack = norm(vue);
  const has = (label) => haystack.includes(norm(label));

  const missingCols = columns(jsx).filter((c) => !has(c));
  const missingPanels = panels(jsx).filter((p) => !has(p));
  const missingPrims = PRIMITIVES.filter(([name, re]) => re.test(jsx)).filter(
    ([name]) => !VUE_PRIMITIVES[name].test(vue),
  );

  totalMissingCols += missingCols.length;
  totalMissingPanels += missingPanels.length;
  totalMissingPrims += missingPrims.length;
  rows.push({
    screen,
    files,
    exists: Boolean(vue.trim()),
    cols: columns(jsx).length,
    missingCols,
    panels: panels(jsx).length,
    missingPanels,
    missingPrims: missingPrims.map(([n]) => n),
  });
}

for (const r of rows) {
  if (r.note) {
    console.log(`\n### ${r.screen} — ${r.note}`);
    continue;
  }
  const clean = !r.missingCols.length && !r.missingPanels.length && !r.missingPrims.length;
  console.log(`\n### ${r.screen}  ->  ${r.files.join(', ')}${clean ? '   [MATCHES]' : ''}`);
  if (!r.exists) {
    console.log('    !! NO IMPLEMENTING VIEW FOUND');
    continue;
  }
  if (r.missingPanels.length)
    console.log(
      `    panels  missing ${r.missingPanels.length}/${r.panels}: ${r.missingPanels.join(' | ')}`,
    );
  if (r.missingCols.length)
    console.log(
      `    columns missing ${r.missingCols.length}/${r.cols}: ${r.missingCols.join(' | ')}`,
    );
  if (r.missingPrims.length) console.log(`    primitives missing: ${r.missingPrims.join(', ')}`);
}

console.log(
  `\n${'='.repeat(78)}\nTOTAL  ${totalMissingPanels} panels | ${totalMissingCols} columns | ${totalMissingPrims} primitives absent`,
);
