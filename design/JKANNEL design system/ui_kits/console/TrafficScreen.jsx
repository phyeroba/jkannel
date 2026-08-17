import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { MetricCard } from '../../components/core/MetricCard.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { MiniChart } from '../../components/data/MiniChart.jsx';
import { SMSCS, MT_SERIES, MO_SERIES, DLR_SERIES, CLOCK_LABELS, healthTone } from './estate.jsx';

/* Section 6 and UC-TRF-01. The table updates values in place and does not
   reorder rows on refresh unless ranking is switched on — a live table that
   reshuffles under the cursor is unusable in a NOC. */
export function TrafficScreen({ onNavigate, range }) {
  const [carrier, setCarrier] = React.useState('any');
  const [rank, setRank] = React.useState(false);
  const [paused, setPaused] = React.useState(false);

  const rows = SMSCS.filter((s) => carrier === 'any' || s.carrier === carrier);
  const shown = rank ? [...rows].sort((a, b) => b.tpsOut - a.tpsOut) : rows;
  const mt = MT_SERIES[MT_SERIES.length - 1];
  const peak = Math.max(...MT_SERIES);
  const avg = Math.round(MT_SERIES.reduce((a, b) => a + b, 0) / MT_SERIES.length);
  const capacity = 850;

  return (
    <>
      <section className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <MetricCard label="MT now" value={mt + '/s'} detail={'avg ' + avg + ' · peak ' + peak} icon="chart" />
        <MetricCard label="MO now" value={MO_SERIES[MO_SERIES.length - 1] + '/s'} detail="inbound from carriers" icon="sms" />
        <MetricCard label="DLR now" value={DLR_SERIES[DLR_SERIES.length - 1] + '/s'} detail="receipts arriving" icon="check" />
        <MetricCard label="Utilisation" value={Math.round((mt / capacity) * 100) + '%'} detail={'of ' + capacity + '/s known capacity'} icon="server" tone={mt / capacity > 0.8 ? 'warn' : 'primary'} />
      </section>

      <Panel
        title="Throughput"
        subtitle={'MT, MO and DLR over the last ' + range + ' — the shaded expectation is derived from the same weekday last week'}
        action={
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FilterSelect label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
              {['any', ...new Set(SMSCS.map((s) => s.carrier))].map((c) => <option key={c}>{c}</option>)}
            </FilterSelect>
            <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => setPaused(!paused)}>
              {paused ? 'Resume live' : 'Pause live'}
            </button>
          </span>
        }
        style={{ marginBottom: 16 }}
      >
        <div style={{ marginTop: 16 }}>
          <MiniChart
            series={[{ name: 'MT submitted', values: MT_SERIES }, { name: 'DLR received', values: DLR_SERIES }, { name: 'MO received', values: MO_SERIES }]}
            labels={CLOCK_LABELS}
            height={200}
          />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 12 }}>
          {paused
            ? 'Live refresh paused, so you can read and copy values. The chart is frozen at 01:41:12.'
            : 'Values update in place every 5 seconds. Row order is held steady while live.'}
        </p>
      </Panel>

      <Panel
        title="Traffic matrix"
        subtitle="Throughput beside queue and delivery quality, so a healthy rate with a growing queue is visible"
        action={
          <label className="filter-select">
            <span>Rank by TPS</span>
            <select value={rank ? 'on' : 'off'} onChange={(e) => setRank(e.target.value === 'on')}>
              <option value="off">off</option>
              <option value="on">on</option>
            </select>
          </label>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SMSC</th><th>Carrier</th><th>State</th>
                <th style={{ textAlign: 'right' }}>MT out</th><th style={{ textAlign: 'right' }}>MO in</th>
                <th style={{ textAlign: 'right' }}>Utilisation</th><th style={{ textAlign: 'right' }}>Queue</th>
                <th style={{ textAlign: 'right' }}>Oldest</th><th style={{ textAlign: 'right' }}>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} className="selectable" onClick={() => onNavigate('/smscs')}>
                  <td className="mono">{s.id}</td>
                  <td>{s.carrier}</td>
                  <td><StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge></td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.tpsOut}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.tpsIn}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{Math.round((s.tpsOut / s.capacity) * 100)}%</td>
                  <td className="figures" style={{ textAlign: 'right', color: s.queue > 500 ? 'var(--warn)' : undefined }}>{s.queue.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.queueAge}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.delivery === null ? 'unknown' : s.delivery + '%'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
          UTL shows 0 out with 412 queued — throughput alone would have looked like low demand.
        </p>
      </Panel>
    </>
  );
}
