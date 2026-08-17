import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { MiniChart } from '../../components/data/MiniChart.jsx';
import { DLR_FUNNEL, DLR_STATUSES, CARRIER_QUALITY, DLR_SERIES, MT_SERIES, CLOCK_LABELS } from './estate.jsx';

/* Section 8 and UC-DLR-01. The maturity warning is prominent: a short window has
   not had time to collect final receipts, and reading it as a delivery failure is
   the classic false incident. Vendor codes are shown with their meaning. */
export function DlrScreen({ range }) {
  const [compare, setCompare] = React.useState('previous period');
  const immature = ['15m', '1h'].includes(range);
  const submitted = DLR_FUNNEL[0].value;

  return (
    <>
      {immature ? (
        <p className="stale-banner">
          The last {range} is too recent for final receipts. {DLR_STATUSES.find((s) => s.status === 'pending').count.toLocaleString()} messages
          are still awaiting a DLR, so the delivery rate below will read low. Widen the range before
          concluding that delivery has degraded.
        </p>
      ) : null}

      <Panel
        title="Delivery funnel"
        subtitle={'Submitted → accepted by SMSC → DLR received → delivered, last ' + range}
        action={
          <FilterSelect label="Compare against" value={compare} onChange={(e) => setCompare(e.target.value)}>
            {['previous period', 'same day last week', 'no comparison'].map((c) => <option key={c}>{c}</option>)}
          </FilterSelect>
        }
        style={{ marginBottom: 16 }}
      >
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          {DLR_FUNNEL.map((stage, i) => {
            const share = (stage.value / submitted) * 100;
            const lost = i ? DLR_FUNNEL[i - 1].value - stage.value : 0;
            return (
              <div key={stage.stage} style={{ display: 'grid', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontSize: 14 }}>
                  <span style={{ color: 'var(--text-strong)' }}>{stage.stage}</span>
                  <span>
                    <strong className="figures" style={{ color: 'var(--text-strong)' }}>{stage.value.toLocaleString()}</strong>
                    <span className="figures" style={{ color: 'var(--muted)', marginLeft: 8 }}>{share.toFixed(1)}%</span>
                    {lost ? <span className="figures" style={{ color: 'var(--bad)', marginLeft: 8 }}>−{lost.toLocaleString()}</span> : null}
                  </span>
                </div>
                <span className="breakdown-track"><span className="breakdown-fill" style={{ width: share + '%' }} /></span>
              </div>
            );
          })}
        </div>
      </Panel>

      <section className="split-grid wide-left">
        <Panel title="Delivery rate against volume" subtitle="Quality is trended separately from raw traffic, so a busy hour is not read as a better hour">
          <div style={{ marginTop: 16 }}>
            <MiniChart
              series={[{ name: 'MT submitted', values: MT_SERIES }, { name: 'DLR received', values: DLR_SERIES }]}
              labels={CLOCK_LABELS}
              height={170}
            />
          </div>
        </Panel>

        <Panel title="Status breakdown" subtitle="Normalised status with its raw carrier value retained">
          <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
            {DLR_STATUSES.map((s) => (
              <div key={s.status} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5 }}>
                    <span className="mono">{s.status}</span>
                    <span className="figures" style={{ color: 'var(--muted)' }}>{s.count.toLocaleString()}</span>
                  </div>
                  <span className="breakdown-track" style={{ height: 6 }}>
                    <span className="breakdown-fill" style={{ width: Math.max(1, s.share) + '%', background: s.tone === 'good' ? 'var(--good)' : s.tone === 'bad' ? 'var(--bad)' : s.tone === 'warn' ? 'var(--warn)' : 'var(--muted)' }} />
                  </span>
                </div>
                <span className="figures" style={{ fontSize: 13.5, color: 'var(--text-strong)', minWidth: 44, textAlign: 'right' }}>{s.share}%</span>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <Panel
        title="Carrier comparison"
        subtitle={'Identical window for every carrier, last ' + range + ' — worst delivery first'}
        style={{ marginTop: 16 }}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Carrier</th><th style={{ textAlign: 'right' }}>Delivery</th>
                <th style={{ textAlign: 'right' }}>P50</th><th style={{ textAlign: 'right' }}>P95</th><th style={{ textAlign: 'right' }}>P99</th>
                <th style={{ textAlign: 'right' }}>No-DLR</th><th style={{ textAlign: 'right' }}>Reject</th><th style={{ textAlign: 'right' }}>Throttle</th><th>Read as</th>
              </tr>
            </thead>
            <tbody>
              {[...CARRIER_QUALITY].sort((a, b) => (a.delivery ?? -1) - (b.delivery ?? -1)).map((q) => (
                <tr key={q.carrier}>
                  <td><strong style={{ color: 'var(--text-strong)' }}>{q.carrier}</strong></td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.delivery === null ? 'unknown' : q.delivery + '%'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{q.p50}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{q.p95}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{q.p99}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.noDlr === null ? '—' : q.noDlr + '%'}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.reject === null ? '—' : q.reject + '%'}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.throttle === null ? '—' : q.throttle + '%'}</td>
                  <td>
                    {q.delivery === null
                      ? <StatusBadge tone="muted">no data</StatusBadge>
                      : q.noDlr > 3
                        ? <StatusBadge tone="warn">receipts delayed or lost</StatusBadge>
                        : q.delivery < 95
                          ? <StatusBadge tone="bad">true delivery failure</StatusBadge>
                          : <StatusBadge tone="good">healthy</StatusBadge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
          A high no-DLR rate with a normal reject rate means receipts are missing, not that handsets failed to
          receive the message. The two get different escalations.
        </p>
      </Panel>
    </>
  );
}
