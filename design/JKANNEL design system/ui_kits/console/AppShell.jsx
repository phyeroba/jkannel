import React from 'react';
import ReactDOM from 'react-dom';
import { Icon } from '../../components/core/Icon.jsx';
import { ALERTS, SMSCS } from './estate.jsx';

/* Information architecture from section 2 of the specification: six sections,
   built on the operational hierarchy Carrier → SMSC → SMPP Session → Route →
   Queue → Message → Delivery Receipt. Customer provisioning, billing, plans and
   customer API credentials are out of scope and absent by design. */
const SECTIONS = [
  { name: 'Overview', icon: 'home', items: [
    { label: 'Dashboard', icon: 'home', to: '/dashboard' },
    { label: 'Alerts', icon: 'alert', to: '/alerts' },
  ]},
  { name: 'Connectivity', icon: 'server', items: [
    { label: 'Carriers', icon: 'route', to: '/carriers' },
    { label: 'SMSCs', icon: 'server', to: '/smscs' },
    { label: 'SMPP Sessions', icon: 'api', to: '/sessions' },
  ]},
  { name: 'Traffic', icon: 'chart', items: [
    { label: 'Live Traffic', icon: 'chart', to: '/traffic' },
    { label: 'Queues', icon: 'queue', to: '/queues' },
    { label: 'DLR Performance', icon: 'check', to: '/dlr' },
  ]},
  { name: 'Routing', icon: 'route', items: [
    { label: 'Carrier Routes', icon: 'route', to: '/routes' },
    { label: 'Failover', icon: 'shield', to: '/failover' },
    { label: 'Route Simulator', icon: 'spark', to: '/simulator' },
  ]},
  { name: 'Diagnostics', icon: 'terminal', items: [
    { label: 'Message Trace', icon: 'sms', to: '/trace' },
    { label: 'SMPP Errors', icon: 'alert', to: '/smpp-errors' },
    { label: 'Events', icon: 'bell', to: '/events' },
    { label: 'Logs', icon: 'terminal', to: '/logs' },
    { label: 'Test Tools', icon: 'plugin', to: '/tools' },
    { label: 'Engine Configuration', icon: 'cog', to: '/engine-config' },
  ]},
  { name: 'System', icon: 'docker', items: [
    { label: 'Services', icon: 'docker', to: '/services' },
    { label: 'Nodes', icon: 'db', to: '/nodes' },
    { label: 'Performance', icon: 'chart', to: '/performance' },
    { label: 'Audit Trail', icon: 'shield', to: '/audit' },
    { label: 'Users & Roles', icon: 'users', to: '/users' },
  ]},
];

export const NAV_SECTIONS = SECTIONS;
export const RANGES = ['15m', '1h', '6h', '24h', '7d'];

/* Telemetry freshness is a first-class control, not decoration: the operator has
   to know whether what they are reading is current (spec §2.1, §17). */
const FRESHNESS = {
  live: { label: 'Live', tone: 'good', detail: 'telemetry current' },
  delayed: { label: 'Delayed', tone: 'warn', detail: 'last update 94s ago' },
  disconnected: { label: 'Disconnected', tone: 'bad', detail: 'no telemetry since 01:28:14' },
};

export function AppShell({ route, onNavigate, range, onRange, theme, onToggleTheme, onLogout, children, breadcrumbs, title, subtitle, freshness = 'live', showRange }) {
  const matches = (itemTo, current) => current === itemTo || current.startsWith(itemTo + '/');
  const sectionOf = (to) => (SECTIONS.find((s) => s.items.some((i) => matches(i.to, to))) || {}).name;
  const [openSection, setOpenSection] = React.useState(sectionOf(route) || 'Overview');
  React.useEffect(() => { const s = sectionOf(route); if (s) setOpenSection(s); }, [route]);
  const [drawer, setDrawer] = React.useState(false);
  const [palette, setPalette] = React.useState(false);
  React.useEffect(() => {
    if (!palette) return;
    const onKey = (e) => { if (e.key === 'Escape') setPalette(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [palette]);

  const [query, setQuery] = React.useState('');
  const go = (to) => { onNavigate(to); setDrawer(false); setPalette(false); };

  const critical = ALERTS.filter((a) => a.severity === 'critical' && a.state === 'active').length;
  const warning = ALERTS.filter((a) => a.severity === 'warning' && a.state === 'active').length;
  const fresh = FRESHNESS[freshness];

  const targets = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, group: s.name })));
  const hits = targets.filter((t) => t.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="app-frame">
      {drawer ? <div className="sidebar-scrim" onClick={() => setDrawer(false)} /> : null}
      <aside className={drawer ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <span className="brand-mark"><Icon name="sms" size={20} /></span>
          <span><strong>KAMEX</strong><small>Gateway operations</small></span>
        </div>
        <nav>
          {SECTIONS.map((section) => (
            <div className="nav-group" key={section.name}>
              <button
                className={openSection === section.name ? 'nav-label' : 'nav-label collapsed'}
                aria-expanded={openSection === section.name}
                onClick={() => setOpenSection(openSection === section.name ? null : section.name)}
              >
                <Icon name={section.icon} />
                <span>{section.name}</span>
                <Icon name="chevron" size={14} className="nav-chevron" />
              </button>
              {openSection !== section.name ? null : (
                <div className="nav-items">
                  {section.items.map((item) => (
                    <a
                      key={item.to}
                      href="#"
                      className={matches(item.to, route) ? 'active' : undefined}
                      onClick={(e) => { e.preventDefault(); go(item.to); }}
                    >
                      <Icon name={item.icon} size={17} />
                      <span>{item.label}</span>
                      {item.to === '/alerts' && critical ? <span className="nav-badge">{critical + warning}</span> : null}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={'status-dot ' + (fresh.tone === 'good' ? 'good' : fresh.tone === 'warn' ? 'warn' : 'bad')} />
          <span><strong style={{ color: '#fff' }}>kamex 1.8.3</strong><small>2 nodes · {SMSCS.length} SMSCs</small></span>
        </div>
      </aside>

      <div className="shell">
        <header className="topbar">
          <button className="icon-button nav-toggle" aria-label="Open navigation" onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>

          {/* Environment is called out strongly: a control action on Production
              must never be mistaken for one on Staging (spec §2.1). */}
          <span className="env-chip env-production" title="You are operating on the production gateway">
            <span className="env-dot" />Production
          </span>

          <button className="search-trigger" onClick={() => setPalette(true)}>
            <Icon name="search" size={18} />
            <span>Search carrier, SMSC, session, message ID or MSISDN</span>
            <kbd>Ctrl K</kbd>
          </button>

          <div className="top-actions">
            {showRange ? (
              <label className="filter-select topbar-range">
                <span>Range</span>
                <select value={range} onChange={(e) => onRange(e.target.value)}>
                  {RANGES.map((r) => <option key={r}>{r}</option>)}
                </select>
              </label>
            ) : null}

            <span className={'freshness freshness-' + fresh.tone} title={fresh.detail}>
              <span className="status-dot" style={{ background: fresh.tone === 'good' ? 'var(--good)' : fresh.tone === 'warn' ? 'var(--warn)' : 'var(--bad)' }} />
              {fresh.label}
            </span>

            <button className="icon-button" aria-label="Toggle theme" onClick={onToggleTheme}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>

            <button className="icon-button" aria-label={'Alerts: ' + critical + ' critical, ' + warning + ' warning'} style={{ position: 'relative' }} onClick={() => go('/alerts')}>
              <Icon name="bell" />
              {critical ? <span className="nav-badge" style={{ position: 'absolute', top: -2, right: -4 }}>{critical}</span> : null}
            </button>

            <div className="profile">
              <span className="avatar">O</span>
              <span className="profile-text"><strong>operator</strong><small>NOC Operator</small></span>
            </div>
            <button className="icon-button" aria-label="Sign out" onClick={onLogout}><Icon name="logout" /></button>
          </div>
        </header>

        <main className="workspace">
          <nav className="breadcrumbs">
            {(breadcrumbs || []).map((crumb, i) => {
              const label = typeof crumb === 'string' ? crumb : crumb.label;
              const to = typeof crumb === 'string' ? null : crumb.to;
              const last = i === breadcrumbs.length - 1;
              return (
                <React.Fragment key={label + i}>
                  {i ? <span>/</span> : null}
                  {last
                    ? <span>{label}</span>
                    : <a href="#" onClick={(e) => { e.preventDefault(); if (to) go(to); }}>{label}</a>}
                </React.Fragment>
              );
            })}
          </nav>
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            {/* Screens portal their create/primary action here, so an "Add …"
                button sits with the page title rather than inside a table panel. */}
            <div className="page-actions" id="page-actions" />
          </div>
          {children}
        </main>

        <footer className="statusbar">
          <span><span className={'status-dot ' + (fresh.tone === 'good' ? 'good' : fresh.tone === 'warn' ? 'warn' : 'bad')} />{fresh.label} · {fresh.detail}</span>
          <span>Gateway time EAT (UTC+3)</span>
          <span className="mono">kamex 1.8.3 · build 7b4dea0</span>
        </footer>
      </div>

      {palette ? (
        <div className="dialog-backdrop" onClick={() => setPalette(false)}>
          <div className="command-dialog" onClick={(e) => e.stopPropagation()}>
            <header><h2>Search</h2><kbd>Esc</kbd></header>
            <input autoFocus placeholder="Carrier, SMSC, session, message ID or MSISDN" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginTop: 12 }} />
            <div className="search-results">
              {hits.length ? hits.slice(0, 8).map((item) => (
                <a key={item.to} href="#" onClick={(e) => { e.preventDefault(); go(item.to); }}>
                  {item.label}<span>{item.group}</span>
                </a>
              )) : <p className="empty-cell">No screen matches “{query}”. Message IDs and MSISDNs resolve on Message Trace.</p>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* A screen's primary create action belongs beside the page title, not fused with
   the register it adds to. Screens render it through this portal. */
export function PageAction({ children }) {
  const [host, setHost] = React.useState(null);
  React.useEffect(() => { setHost(document.getElementById('page-actions')); }, []);
  return host ? ReactDOM.createPortal(children, host) : null;
}
