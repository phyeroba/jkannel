import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { TRACE_MESSAGES, TRACE_STAGES, healthTone } from './estate.jsx';

/* Section 10 and UC-MSG-01. The lifecycle is a chronological trace, not a log
   dump: each stage carries its timestamp and the latency since the previous one,
   and the first abnormal or missing stage is called out. */
const GENERIC_STAGES = [
  { at: '—', stage: 'ingress', detail: 'accepted from submit API', latency: '—', state: 'ok' },
  { at: '—', stage: 'route decision', detail: 'route matched', latency: '—', state: 'ok' },
  { at: '—', stage: 'queue', detail: 'awaiting egress', latency: '—', state: 'warn' },
  { at: '—', stage: 'submit_sm', detail: 'not yet sent — destination SMSC is disconnected', latency: '—', state: 'missing' },
  { at: '—', stage: 'DLR', detail: 'not expected until the message is submitted', latency: '—', state: 'missing' },
];

export function TraceScreen({ onNavigate }) {
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState('any');
  const [selected, setSelected] = React.useState(null);
  const [notFound, setNotFound] = React.useState(false);
  const [summary, setSummary] = React.useState(false);

  const rows = TRACE_MESSAGES.filter((m) =>
    (status === 'any' || m.status === status) &&
    (!query.trim() || m.id.includes(query.trim()) || m.msisdn.includes(query.replace(/[^0-9+]/g, '')) || m.carrierId.includes(query.trim()))
  );

  const stages = selected
    ? (TRACE_STAGES[selected.id] || GENERIC_STAGES).map((s) => ({ at: s.at, label: s.stage, detail: s.detail, latency: s.latency === '—' ? null : s.latency, state: s.state }))
    : [];
  const firstBad = stages.find((s) => s.state === 'error' || s.state === 'missing');

  return (
    <>
      <Panel
        title="Message trace"
        subtitle="Search by Kamex message ID, carrier message ID or MSISDN"
        action={
          <FilterSelect label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {['any', 'delivered', 'failed', 'pending', 'queued'].map((s) => <option key={s}>{s}</option>)}
          </FilterSelect>
        }
        style={{ marginBottom: 16 }}
      >
        <div className="grid-toolbar" style={{ marginTop: 14 }}>
          <label className="filter-search" style={{ flex: '1 1 260px' }}>
            <input value={query} onChange={(e) => { setQuery(e.target.value); setNotFound(false); }} placeholder="kmx_01HXQ4K2R9, 448210-mtn or +256772000118" />
          </label>
          <button className="primary-button" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setNotFound(rows.length === 0)}>Search</button>
        </div>

        {notFound && !rows.length ? (
          <p className="notice" style={{ margin: '0 0 14px', color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 32%, var(--border))', background: 'color-mix(in srgb, var(--warn) 10%, var(--surface))' }}>
            No message matches that identifier in the retained window. This is “not found”, which is different
            from retention-expired — messages older than 90 days are pruned and would report differently.
          </p>
        ) : null}

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Message ID</th><th>Carrier ID</th><th>Destination</th><th>Sender</th><th>Carrier</th><th>SMSC</th><th>Route</th><th>Status</th><th style={{ textAlign: 'right' }}>Submitted</th><th style={{ textAlign: 'right' }}>Final</th></tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((m) => (
                <tr key={m.id} className="selectable" onClick={() => setSelected(m)}>
                  <td className="mono">{m.id}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{m.carrierId}</td>
                  <td className="mono">{m.msisdn}</td>
                  <td>{m.sender}</td>
                  <td>{m.carrier}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{m.smsc}</td>
                  <td>{m.route}</td>
                  <td><StatusBadge tone={m.status === 'delivered' ? 'good' : m.status === 'failed' ? 'bad' : 'warn'}>{m.status}</StatusBadge></td>
                  <td className="mono" style={{ textAlign: 'right' }}>{m.submitted}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{m.final}</td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={10}>Search an identifier, or narrow by status. An MSISDN with many matches must be narrowed rather than guessed.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Dialog
        open={Boolean(selected)}
        title={selected ? selected.id : ''}
        onClose={() => setSelected(null)}
        footer={selected ? (
          <>
            <button className="secondary-button" onClick={() => setSummary(true)}>Diagnostic summary</button>
            <button className="secondary-button" onClick={() => { onNavigate('/smpp-errors'); setSelected(null); }}>Correlated errors</button>
            <button className="secondary-button" onClick={() => { onNavigate('/logs'); setSelected(null); }}>Open logs at this time</button>
          </>
        ) : null}
      >
        {selected ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0, padding: 12, borderRadius: 10, background: 'var(--surface-2)', color: 'var(--text-strong)', lineHeight: 1.5 }}>{selected.body}</p>

            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 }}>
              {[['Destination', selected.msisdn], ['Sender', selected.sender], ['Carrier', selected.carrier], ['SMSC', selected.smsc], ['Route', selected.route], ['Carrier message ID', selected.carrierId], ['Status', selected.status]].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</dt>
                  <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                </React.Fragment>
              ))}
            </dl>

            {firstBad ? (
              <p style={{ margin: 0, padding: '10px 13px', borderRadius: 8, fontSize: 13.5, color: 'var(--bad)', background: 'color-mix(in srgb, var(--bad) 10%, transparent)' }}>
                First abnormal stage: <strong>{firstBad.label}</strong> — {firstBad.detail}
              </p>
            ) : null}

            <div>
              <div className="t-caps" style={{ marginBottom: 8 }}>Lifecycle</div>
              <Timeline items={stages} />
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={summary}
        title="Diagnostic summary"
        onClose={() => setSummary(false)}
        footer={<button className="secondary-button" onClick={() => setSummary(false)}>Copy</button>}
      >
        {selected ? (
          <pre className="mono" style={{ margin: 0, padding: 14, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12.5, lineHeight: 1.7, overflow: 'auto', color: 'var(--text-strong)', whiteSpace: 'pre-wrap' }}>
{'Message ' + selected.id + '\n' +
 'Carrier message ID: ' + selected.carrierId + '\n' +
 'Destination: ' + selected.msisdn + ' (' + selected.carrier + ')\n' +
 'Route: ' + selected.route + ' → ' + selected.smsc + '\n' +
 'Submitted: ' + selected.submitted + ' EAT · final: ' + selected.final + '\n' +
 'Outcome: ' + selected.status + '\n' +
 (firstBad ? 'First abnormal stage: ' + firstBad.label + ' — ' + firstBad.detail : 'All stages completed normally.')}
          </pre>
        ) : null}
      </Dialog>
    </>
  );
}
