import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { MiniChart } from '../../components/data/MiniChart.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { SMPP_ERRORS, MT_SERIES, CLOCK_LABELS } from './estate.jsx';

/* Section 11 and UC-ERR-01. Every code is decoded to its symbolic name and a
   plain explanation; the guidance column is labelled as guidance, not root cause.
   Detail links straight to the affected queue, session and traffic chart. */
const THROTTLE_ACCEPTED = [318, 402, 388, 441, 462, 508, 486, 470, 412, 388, 360, 330];

export function SmppErrorsScreen({ onNavigate, range }) {
  const [smsc, setSmsc] = React.useState('any');
  const [selected, setSelected] = React.useState(null);
  const rows = SMPP_ERRORS.filter((e) => smsc === 'any' || e.smsc === smsc);

  return (
    <>
      <Panel
        title="SMPP errors"
        subtitle={'Command statuses by SMSC and session, last ' + range}
        action={
          <FilterSelect label="SMSC" value={smsc} onChange={(e) => setSmsc(e.target.value)}>
            {['any', ...new Set(SMPP_ERRORS.map((e) => e.smsc))].map((s) => <option key={s}>{s}</option>)}
          </FilterSelect>
        }
        style={{ marginBottom: 16 }}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Means</th><th>SMSC</th><th>Session</th><th style={{ textAlign: 'right' }}>Count</th><th style={{ textAlign: 'right' }}>Rate</th><th>First seen</th><th>Last seen</th><th>Trend</th></tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.code} className="selectable" onClick={() => setSelected(e)}>
                  <td className="mono" style={{ fontSize: 12.5 }}>{e.code}</td>
                  <td className="mono">{e.name}</td>
                  <td style={{ color: 'var(--muted)', maxWidth: 320 }}>{e.meaning}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{e.smsc}</td>
                  <td className="mono">{e.session}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{e.count.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{e.rate}</td>
                  <td className="mono">{e.first}</td>
                  <td className="mono">{e.last}</td>
                  <td>
                    <StatusBadge tone={e.trend === 'rising' ? 'bad' : e.trend === 'falling' ? 'good' : 'muted'}>{e.trend}</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Throttling in context" subtitle="Submitted against accepted TPS — the gap is what the carrier is refusing">
        <div style={{ marginTop: 16 }}>
          <MiniChart
            series={[{ name: 'Submitted', values: MT_SERIES }, { name: 'Accepted', values: THROTTLE_ACCEPTED }]}
            labels={CLOCK_LABELS}
            height={170}
          />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 12 }}>
          MTN's agreed ceiling is 250 TPS on this connection. Submitted crossed it at 01:38 and the gap opened
          immediately — this is a capacity conversation with the carrier, not a fault in the gateway.
        </p>
      </Panel>

      <Dialog
        open={Boolean(selected)}
        title={selected ? selected.name : ''}
        onClose={() => setSelected(null)}
        footer={selected ? (
          <>
            <button className="secondary-button" onClick={() => { onNavigate('/queues'); setSelected(null); }}>Affected queue</button>
            <button className="secondary-button" onClick={() => { onNavigate('/sessions'); setSelected(null); }}>Affected session</button>
            <button className="secondary-button" onClick={() => { onNavigate('/traffic'); setSelected(null); }}>Traffic chart</button>
          </>
        ) : null}
      >
        {selected ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 }}>
              {[['Raw code', selected.code], ['Symbolic name', selected.name], ['SMSC', selected.smsc], ['Session', selected.session], ['Occurrences', selected.count.toLocaleString() + ' at ' + selected.rate], ['First seen', selected.first], ['Last seen', selected.last], ['Trend', selected.trend]].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</dt>
                  <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
            <div>
              <div className="t-caps" style={{ marginBottom: 6 }}>What it means</div>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--text)', lineHeight: 1.6 }}>{selected.meaning}</p>
            </div>
            <div>
              <div className="t-caps" style={{ marginBottom: 6 }}>Suggested checks (guidance, not a diagnosis)</div>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6 }}>{selected.guidance}</p>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
