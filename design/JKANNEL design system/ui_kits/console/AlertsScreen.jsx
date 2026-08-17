import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { ALERTS, EVENTS } from './estate.jsx';

/* Section 13 and UC-ALT-01: severity, duration, affected objects, impact and
   correlated evidence in one view; acknowledge with a note; recovery is detected
   automatically; repeated events group under one incident. */
const ALERT_CATEGORIES = ['any', 'Availability', 'Connectivity quality', 'Capacity', 'Delivery quality', 'Traffic anomaly', 'Infrastructure', 'Telemetry'];

const severityTone = (s) => (s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'info');

export function AlertsScreen({ onNavigate }) {
  const [category, setCategory] = React.useState('any');
  const [state, setState] = React.useState('active');
  const [selected, setSelected] = React.useState(null);
  const [acked, setAcked] = React.useState({});
  const [ackFor, setAckFor] = React.useState(null);
  const [note, setNote] = React.useState('');

  const rows = ALERTS.filter((a) =>
    (category === 'any' || a.category === category) &&
    (state === 'any' || (state === 'active' ? a.state !== 'recovered' : a.state === state))
  );

  const ack = () => {
    setAcked({ ...acked, [ackFor.id]: 'operator ' + new Date().toLocaleTimeString() + (note ? ' — ' + note : '') });
    setAckFor(null);
    setNote('');
  };

  const evidence = (alert) => EVENTS
    .filter((e) => e.object === alert.object || e.correlation === 'c-8f14e45f')
    .slice(0, 4)
    .map((e) => ({ at: e.at.slice(11), label: e.type, detail: e.detail, state: e.severity === 'critical' ? 'error' : e.severity === 'warning' ? 'warn' : 'info' }));

  return (
    <>
      <Panel
        title="Alerts"
        subtitle="Grouped into incidents — a repeating condition raises its occurrence count rather than a new row"
        action={
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FilterSelect label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {ALERT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </FilterSelect>
            <FilterSelect label="State" value={state} onChange={(e) => setState(e.target.value)}>
              {['active', 'acknowledged', 'recovered', 'any'].map((s) => <option key={s}>{s}</option>)}
            </FilterSelect>
          </span>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th><th>Condition</th><th>Category</th><th>Object</th>
                <th>Started</th><th style={{ textAlign: 'right' }}>Duration</th>
                <th style={{ textAlign: 'right' }}>Occurrences</th><th>Acknowledgement</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((a) => (
                <tr key={a.id} className="selectable" onClick={() => setSelected(a)}>
                  <td><StatusBadge tone={severityTone(a.severity)}>{a.severity}</StatusBadge></td>
                  <td><strong style={{ color: 'var(--text-strong)' }}>{a.summary}</strong><span className="row-id">{a.impact}</span></td>
                  <td>{a.category}</td>
                  <td className="mono">{a.object}</td>
                  <td className="mono">{a.started}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{a.duration}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{a.occurrences}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{acked[a.id] || a.ack || 'unacknowledged'}</td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={8}>No alerts match this filter. That is a real result, not a loading state.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Dialog
        open={Boolean(selected)}
        title={selected ? selected.id + ' — ' + selected.severity : ''}
        onClose={() => setSelected(null)}
        footer={selected ? (
          <>
            <button className="secondary-button" onClick={() => { onNavigate(selected.object.startsWith('q-') ? '/queues' : selected.object.startsWith('TRX') || selected.object.startsWith('TX') ? '/sessions' : '/smscs'); setSelected(null); }}>
              Open affected object
            </button>
            <button className="secondary-button" onClick={() => { onNavigate('/events'); setSelected(null); }}>Correlated events</button>
            {acked[selected.id] || selected.ack ? null : (
              <button className="primary-button" onClick={() => { setAckFor(selected); setSelected(null); }}>Acknowledge</button>
            )}
          </>
        ) : null}
      >
        {selected ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0, color: 'var(--text-strong)', fontSize: 14 }}>{selected.summary}</p>
            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 }}>
              {[['Category', selected.category], ['Affected object', selected.object], ['Started', selected.started], ['Active for', selected.duration], ['Traffic impact', selected.impact], ['Occurrences', String(selected.occurrences)], ['State', selected.state], ['Acknowledgement', acked[selected.id] || selected.ack || 'unacknowledged']].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</dt>
                  <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
            <div>
              <div className="t-caps" style={{ marginBottom: 8 }}>Correlated evidence</div>
              <Timeline dense items={evidence(selected)} />
            </div>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
              The alert clears itself when the recovery condition is met. If the condition recurs it reopens
              on this incident and keeps this history.
            </p>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(ackFor)}
        title={ackFor ? 'Acknowledge ' + ackFor.id : ''}
        onClose={() => setAckFor(null)}
        footer={<button className="primary-button" onClick={ack}>Acknowledge</button>}
      >
        {ackFor ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0, color: 'var(--text-strong)' }}>{ackFor.summary}</p>
            <label className="field" style={{ margin: 0 }}>
              <span>Note (optional, recorded on the incident timeline)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Carrier NOC engaged, ref INC-4471" />
            </label>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13.5 }}>
              Acknowledging records who is working the incident. It does not resolve it or silence recovery
              detection.
            </p>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
