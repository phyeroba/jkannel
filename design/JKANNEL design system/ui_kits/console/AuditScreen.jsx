import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { AUDIT } from './estate.jsx';

/* Section 16: every privileged action with actor, role, timestamp, target,
   previous state, reason, result and correlation ID. Read-only in the UI. */
const ACTIONS = ['any', 'smsc.reconnect', 'smsc.suspend', 'smsc.resume', 'route.failover.manual', 'service.restart', 'test.send', 'alert.acknowledge'];

export function AuditScreen({ onNavigate, range }) {
  const [action, setAction] = React.useState('any');
  const [actor, setActor] = React.useState('any');
  const [selected, setSelected] = React.useState(null);

  const rows = AUDIT.filter((a) =>
    (action === 'any' || a.action === action) && (actor === 'any' || a.actor === actor)
  );

  return (
    <>
      <Panel
        title="Audit trail"
        subtitle={'Privileged actions, last ' + range + ' — read-only, and every entry carries the reason its operator gave'}
        action={
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FilterSelect label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
              {ACTIONS.map((a) => <option key={a}>{a}</option>)}
            </FilterSelect>
            <FilterSelect label="Actor" value={actor} onChange={(e) => setActor(e.target.value)}>
              {['any', ...new Set(AUDIT.map((a) => a.actor))].map((a) => <option key={a}>{a}</option>)}
            </FilterSelect>
          </span>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>Actor</th><th>Role</th><th>Action</th><th>Target</th><th>Previous state</th><th>Reason</th><th>Result</th><th>Correlation</th></tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((a) => (
                <tr key={a.at} className="selectable" onClick={() => setSelected(a)}>
                  <td className="mono">{a.at}</td>
                  <td className="mono">{a.actor}</td>
                  <td style={{ color: 'var(--muted)' }}>{a.role}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{a.action}</td>
                  <td className="mono">{a.target}</td>
                  <td className="mono">{a.previous}</td>
                  <td style={{ color: 'var(--muted)', maxWidth: 260 }}>{a.reason}</td>
                  <td>
                    <StatusBadge tone={a.result.startsWith('failed') ? 'bad' : 'good'}>
                      {a.result.startsWith('failed') ? 'failed' : 'succeeded'}
                    </StatusBadge>
                  </td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{a.correlation}</td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={9}>No privileged actions match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
          Reconnect, suspend, resume, failover, service restart, test send and alert acknowledgement are all
          recorded. Entries cannot be edited or removed from this screen.
        </p>
      </Panel>

      <Dialog
        open={Boolean(selected)}
        title={selected ? selected.action : ''}
        onClose={() => setSelected(null)}
        footer={selected ? (
          <button className="secondary-button" onClick={() => { onNavigate('/events'); setSelected(null); }}>Correlated events</button>
        ) : null}
      >
        {selected ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 }}>
            {[['When', selected.at], ['Actor', selected.actor], ['Role', selected.role], ['Action', selected.action], ['Target', selected.target], ['Previous state', selected.previous], ['Reason given', selected.reason], ['Result', selected.result], ['Correlation ID', selected.correlation]].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : null}
      </Dialog>
    </>
  );
}
