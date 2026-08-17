import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { SERVICES, healthTone } from './estate.jsx';

/* Section 14: the service register. A gateway grows instances (several smsboxes,
   collectors, workers per node), so this stays a filterable list and each service
   opens its own page rather than expanding detail underneath. */
const STATE_ORDER = { critical: 0, degraded: 1, unknown: 2, healthy: 3 };

export function ServicesScreen({ onNavigate }) {
  const [query, setQuery] = React.useState('');
  const [state, setState] = React.useState('any');
  const [sort, setSort] = React.useState('state');

  const rows = SERVICES
    .filter((s) =>
      (state === 'any' || s.state === state) &&
      (!query.trim() || (s.name + ' ' + s.role).toLowerCase().includes(query.trim().toLowerCase()))
    )
    .sort((a, b) =>
      sort === 'state' ? (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9)
      : sort === 'cpu' ? b.cpu - a.cpu
      : sort === 'memory' ? b.ram - a.ram
      : a.name.localeCompare(b.name)
    );

  const unhealthy = SERVICES.filter((s) => s.state !== 'healthy').length;

  return (
    <>
      <p className="stale-banner">
        The metrics collector restarted 1h 12m ago and its last scrape of smile_ug_tx failed. Anything it
        watches is reported unknown until a scrape succeeds — not healthy.
      </p>

      <Panel
        title="Services"
        subtitle={unhealthy + ' of ' + SERVICES.length + ' components need attention. Select one to open its page.'}
        action={
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FilterSelect label="State" value={state} onChange={(e) => setState(e.target.value)}>
              {['any', 'critical', 'degraded', 'unknown', 'healthy'].map((s) => <option key={s}>{s}</option>)}
            </FilterSelect>
            <FilterSelect label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              {['state', 'cpu', 'memory', 'name'].map((s) => <option key={s}>{s}</option>)}
            </FilterSelect>
            <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }}>Export CSV</button>
          </span>
        }
      >
        <div className="grid-toolbar" style={{ marginTop: 14 }}>
          <label className="filter-search" style={{ flex: '1 1 260px' }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search service or responsibility" />
          </label>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th><th>Responsibility</th><th>State</th>
                <th style={{ textAlign: 'right' }}>Uptime</th><th style={{ textAlign: 'right' }}>CPU</th>
                <th style={{ textAlign: 'right' }}>Memory</th><th style={{ textAlign: 'right' }}>Rate</th>
                <th>Detail</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((s) => (
                <tr key={s.name} className="selectable" onClick={() => onNavigate('/services/' + s.name)}>
                  <td className="mono">{s.name}</td>
                  <td style={{ color: 'var(--muted)' }}>{s.role}</td>
                  <td><StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge></td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.uptime}</td>
                  <td className="figures" style={{ textAlign: 'right', color: s.cpu > 70 ? 'var(--warn)' : undefined }}>{s.cpu}%</td>
                  <td className="figures" style={{ textAlign: 'right', color: s.ram > 70 ? 'var(--warn)' : undefined }}>{s.ram}%</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.rate}</td>
                  <td style={{ color: 'var(--muted)' }}>{s.detail}</td>
                  <td className="row-actions">
                    <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={(e) => { e.stopPropagation(); onNavigate('/services/' + s.name); }}>
                      Open
                    </button>
                  </td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={9}>No service matches this filter.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <span>Showing {rows.length} of {SERVICES.length} services</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="secondary-button" disabled>Previous</button>
            <button className="secondary-button" disabled>Next</button>
          </span>
        </div>
      </Panel>
    </>
  );
}
