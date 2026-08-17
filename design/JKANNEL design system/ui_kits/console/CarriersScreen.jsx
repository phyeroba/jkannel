import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { CARRIERS, healthTone } from './estate.jsx';

/* Section 4.1: the carrier register. This list is expected to grow — a gateway
   can hold dozens of networks across several markets — so it stays a pure list
   with server-side style filtering and paging, and each row opens its own page
   rather than expanding detail underneath. */
const HEALTH_ORDER = { critical: 0, degraded: 1, unknown: 2, healthy: 3 };

export function CarriersScreen({ onNavigate }) {
  const [query, setQuery] = React.useState('');
  const [health, setHealth] = React.useState('any');
  const [sort, setSort] = React.useState('health');

  const filtered = CARRIERS
    .filter((c) =>
      (health === 'any' || c.health === health) &&
      (!query.trim() ||
        (c.name + ' ' + c.prefixes + ' ' + c.mcc + c.mnc).toLowerCase().includes(query.trim().toLowerCase()))
    )
    .sort((a, b) =>
      sort === 'health' ? HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health]
      : sort === 'queue' ? (b.queue ?? -1) - (a.queue ?? -1)
      : sort === 'traffic' ? (b.tps ?? -1) - (a.tps ?? -1)
      : a.name.localeCompare(b.name)
    );

  const unhealthy = CARRIERS.filter((c) => c.health !== 'healthy').length;

  return (
    <Panel
      title="Carriers"
      subtitle={unhealthy + ' of ' + CARRIERS.length + ' networks need attention. Select one to open its operational page.'}
      action={
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FilterSelect label="Health" value={health} onChange={(e) => setHealth(e.target.value)}>
            {['any', 'critical', 'degraded', 'unknown', 'healthy'].map((h) => <option key={h}>{h}</option>)}
          </FilterSelect>
          <FilterSelect label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            {['health', 'queue', 'traffic', 'name'].map((s) => <option key={s}>{s}</option>)}
          </FilterSelect>
          <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }}>Export CSV</button>
        </span>
      }
    >
      <div className="grid-toolbar" style={{ marginTop: 14 }}>
        <label className="filter-search" style={{ flex: '1 1 260px' }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search carrier, prefix or network code" />
        </label>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Carrier</th><th>Market</th><th>Health</th><th>SMSCs</th><th>Sessions</th>
              <th style={{ textAlign: 'right' }}>MT TPS</th><th style={{ textAlign: 'right' }}>Utilisation</th>
              <th style={{ textAlign: 'right' }}>Queue</th><th style={{ textAlign: 'right' }}>Delivery</th>
              <th style={{ textAlign: 'right' }}>P95 DLR</th><th>Last connectivity event</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? filtered.map((c) => (
              <tr key={c.id} className="selectable" onClick={() => onNavigate('/carriers/' + c.id)}>
                <td><strong style={{ color: 'var(--text-strong)' }}>{c.name}</strong><span className="row-id">{c.prefixes}</span></td>
                <td className="mono" style={{ fontSize: 12.5 }}>UG · {c.mcc}-{c.mnc}</td>
                <td><StatusBadge tone={healthTone(c.health)}>{c.health}</StatusBadge></td>
                <td className="figures">{c.smscs}</td>
                <td className="figures">{c.sessionsUp} / {c.sessionsTotal}</td>
                <td className="figures" style={{ textAlign: 'right' }}>{c.tps === null ? 'unknown' : c.tps}</td>
                <td className="figures" style={{ textAlign: 'right' }}>{c.tps === null ? '—' : Math.round((c.tps / c.capacity) * 100) + '%'}</td>
                <td className="figures" style={{ textAlign: 'right', color: c.queue ? 'var(--warn)' : undefined }}>{c.queue === null ? 'unknown' : c.queue.toLocaleString()}</td>
                <td className="figures" style={{ textAlign: 'right' }}>{c.delivery === null ? 'unknown' : c.delivery + '%'}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{c.p95}</td>
                <td className="mono" style={{ fontSize: 12.5 }}>{c.lastEvent}</td>
                <td className="row-actions">
                  <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={(e) => { e.stopPropagation(); onNavigate('/carriers/' + c.id); }}>
                    Open
                  </button>
                </td>
              </tr>
            )) : <tr><td className="empty-cell" colSpan={12}>No carrier matches this filter.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span>Showing {filtered.length} of {CARRIERS.length} carriers</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="secondary-button" disabled>Previous</button>
          <button className="secondary-button" disabled>Next</button>
        </span>
      </div>
    </Panel>
  );
}
