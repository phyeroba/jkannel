import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { EVENTS } from './estate.jsx';

/* Section 12.1: the structured event stream every other screen links into.
   Correlation ID is a first-class column so an incident can be reconstructed. */
const EVENT_TYPES = ['any', 'connection.lost', 'session.bind.failed', 'throttle.detected', 'queue.threshold.crossed', 'dlr.degradation', 'route.failover.manual', 'telemetry.stale', 'operator.action'];

export function EventsScreen({ onNavigate, range }) {
  const [type, setType] = React.useState('any');
  const [severity, setSeverity] = React.useState('any');
  const [correlation, setCorrelation] = React.useState('');

  const rows = EVENTS.filter((e) =>
    (type === 'any' || e.type === type) &&
    (severity === 'any' || e.severity === severity) &&
    (!correlation || e.correlation === correlation)
  );

  return (
    <Panel
      title="Events"
      subtitle={'Structured operational events, last ' + range + ' — filter to one correlation ID to reconstruct an incident'}
      action={
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FilterSelect label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            {EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}
          </FilterSelect>
          <FilterSelect label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {['any', 'critical', 'warning', 'info'].map((s) => <option key={s}>{s}</option>)}
          </FilterSelect>
          <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => setCorrelation('')} disabled={!correlation}>Clear correlation</button>
        </span>
      }
    >
      {correlation ? (
        <p className="notice" style={{ margin: '14px 0 0' }}>
          Showing one incident: correlation <span className="mono">{correlation}</span>. {rows.length} events.
        </p>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Severity</th><th>Object</th><th>Detail</th><th>Correlation</th><th>Evidence</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((e) => (
              <tr key={e.at + e.type}>
                <td className="mono">{e.at}</td>
                <td className="mono" style={{ fontSize: 12.5 }}>{e.type}</td>
                <td><StatusBadge tone={e.severity === 'critical' ? 'bad' : e.severity === 'warning' ? 'warn' : 'info'}>{e.severity}</StatusBadge></td>
                <td className="mono">{e.object}</td>
                <td style={{ color: 'var(--muted)' }}>{e.detail}</td>
                <td>
                  <button className="text-button mono" style={{ fontSize: 12.5 }} onClick={() => setCorrelation(e.correlation)}>{e.correlation}</button>
                </td>
                <td className="row-actions">
                  <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/logs')}>Logs</button>
                </td>
              </tr>
            )) : <tr><td className="empty-cell" colSpan={7}>No events match these filters in the selected window.</td></tr>}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
        Every alert, carrier event, queue threshold and operator action shares this stream, which is what makes
        an incident reconstructable after the fact.
      </p>
    </Panel>
  );
}
