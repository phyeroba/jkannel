import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { MetricCard } from '../../components/core/MetricCard.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { MiniChart } from '../../components/data/MiniChart.jsx';
import { CARRIERS, SMSCS, QUEUES, CARRIER_QUALITY, ALERTS, SERVICES, MT_SERIES, MO_SERIES, DLR_SERIES, CLOCK_LABELS, healthTone } from './estate.jsx';

/* Section 3: a ten-second assessment. Health strip, carrier connectivity, traffic
   trend, queue pressure, carrier quality, active incidents, system health — each
   zone clicking through to its filtered detail. */
export function DashboardScreen({ onNavigate, range }) {
  const smscsUp = SMSCS.filter((s) => s.state === 'connected').length, smscsTotal = SMSCS.length;
  const critical = ALERTS.filter((a) => a.severity === 'critical' && a.state === 'active').length;
  const unknown = CARRIERS.filter((c) => c.health === 'unknown').length;
  const totalQueue = QUEUES.reduce((sum, q) => sum + q.depth, 0);

  return (
    <>
      {unknown ? (
        <p className="stale-banner">
          Telemetry for {unknown} carrier is stale, so its health is reported unknown rather than healthy.
          Last successful scrape 00:12:31.
        </p>
      ) : null}

      <section className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <MetricCard label="Gateway health" value="Degraded" detail="1 carrier critical, 2 degraded" icon="alert" tone="warn" onClick={() => onNavigate('/services')} />
        <MetricCard label="SMSCs up" value={smscsUp + ' / ' + smscsTotal} detail="1 disconnected, 1 suspended" icon="server" tone="warn" onClick={() => onNavigate('/smscs')} />
        <MetricCard label="MT throughput" value="530/s" detail="of 850/s known capacity" icon="chart" onClick={() => onNavigate('/traffic')} />
        <MetricCard label="MO throughput" value="49/s" detail="inbound, all carriers" icon="sms" onClick={() => onNavigate('/traffic')} />
        <MetricCard label="Queued" value={totalQueue.toLocaleString()} detail="oldest 00:21:03" icon="queue" tone="warn" onClick={() => onNavigate('/queues')} />
        <MetricCard label="DLR success" value="96.8%" detail={'delivered, last ' + range} icon="check" tone="good" onClick={() => onNavigate('/dlr')} />
        <MetricCard label="Critical alerts" value={String(critical)} detail="active and unacknowledged" icon="bell" tone="bad" onClick={() => onNavigate('/alerts')} />
      </section>

      <section className="split-grid wide-left" style={{ marginTop: 16 }}>
        <Panel
          title="Traffic"
          subtitle={'MT, MO and DLR rates over the last ' + range}
          action={<button className="text-button" onClick={() => onNavigate('/traffic')}>Open Live Traffic</button>}
        >
          <div style={{ marginTop: 16 }}>
            <MiniChart
              series={[{ name: 'MT', values: MT_SERIES }, { name: 'DLR', values: DLR_SERIES }, { name: 'MO', values: MO_SERIES }]}
              labels={CLOCK_LABELS}
              height={170}
            />
          </div>
        </Panel>

        <Panel
          title="Queue pressure"
          subtitle="Ranked by depth and growth"
          action={<button className="text-button" onClick={() => onNavigate('/queues')}>Open Queues</button>}
        >
          <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
            {QUEUES.slice(0, 4).map((q) => (
              <div key={q.id} style={{ display: 'grid', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontSize: 14 }}>
                  <span className="mono">{q.destination}</span>
                  <strong className="figures" style={{ color: 'var(--text-strong)' }}>{q.depth.toLocaleString()}</strong>
                </div>
                <span className="breakdown-track">
                  <span className="breakdown-fill" style={{ width: Math.min(100, (q.depth / 1400) * 100) + '%', background: q.growth > 0 ? 'var(--warn)' : 'var(--brand)' }} />
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  oldest {q.oldest} · {q.growth > 0 ? '+' : ''}{q.growth}/s · drain {q.drainReliable ? q.drain : 'unavailable'}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <Panel
        title="Carrier connectivity"
        subtitle="Every network this gateway binds to, worst first"
        action={<button className="text-button" onClick={() => onNavigate('/carriers')}>Open Carriers</button>}
        style={{ marginTop: 16 }}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Carrier</th><th>Health</th><th>SMSCs</th><th>Sessions</th>
                <th style={{ textAlign: 'right' }}>MT TPS</th><th style={{ textAlign: 'right' }}>Utilisation</th>
                <th style={{ textAlign: 'right' }}>Queue</th><th style={{ textAlign: 'right' }}>Delivery</th><th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {CARRIERS.map((c) => (
                <tr key={c.id} className="selectable" onClick={() => onNavigate('/carriers/' + c.id)}>
                  <td><strong style={{ color: 'var(--text-strong)' }}>{c.name}</strong><span className="row-id">{c.prefixes}</span></td>
                  <td><StatusBadge tone={healthTone(c.health)}>{c.health}</StatusBadge></td>
                  <td className="figures">{c.smscs}</td>
                  <td className="figures">{c.sessionsUp} / {c.sessionsTotal}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{c.tps === null ? 'unknown' : c.tps}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{c.tps === null ? '—' : Math.round((c.tps / c.capacity) * 100) + '%'}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{c.queue === null ? 'unknown' : c.queue.toLocaleString()}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{c.delivery === null ? 'unknown' : c.delivery + '%'}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{c.lastEvent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="split-grid" style={{ marginTop: 16 }}>
        <Panel
          title="Active incidents"
          subtitle="Longest running first"
          action={<button className="text-button" onClick={() => onNavigate('/alerts')}>Open Alerts</button>}
        >
          <div className="table-wrap">
            <table>
              <thead><tr><th>Severity</th><th>Condition</th><th>Object</th><th style={{ textAlign: 'right' }}>Duration</th><th>State</th></tr></thead>
              <tbody>
                {ALERTS.filter((a) => a.state !== 'recovered').map((a) => (
                  <tr key={a.id} className="selectable" onClick={() => onNavigate('/alerts')}>
                    <td><StatusBadge tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'}>{a.severity}</StatusBadge></td>
                    <td>{a.summary}<span className="row-id">{a.impact}</span></td>
                    <td className="mono">{a.object}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{a.duration}</td>
                    <td>{a.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Carrier quality"
          subtitle="Worst performers first"
          action={<button className="text-button" onClick={() => onNavigate('/dlr')}>Open DLR Performance</button>}
        >
          <div className="table-wrap">
            <table>
              <thead><tr><th>Carrier</th><th style={{ textAlign: 'right' }}>Delivery</th><th style={{ textAlign: 'right' }}>P95 DLR</th><th style={{ textAlign: 'right' }}>Reject</th></tr></thead>
              <tbody>
                {[...CARRIER_QUALITY].sort((a, b) => (a.delivery ?? -1) - (b.delivery ?? -1)).map((q) => (
                  <tr key={q.carrier}>
                    <td>{q.carrier}</td>
                    <td className="figures" style={{ textAlign: 'right', color: q.delivery === null ? 'var(--muted)' : q.delivery < 95 ? 'var(--bad)' : 'var(--text-strong)' }}>
                      {q.delivery === null ? 'unknown' : q.delivery + '%'}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{q.p95}</td>
                    <td className="figures" style={{ textAlign: 'right' }}>{q.reject === null ? '—' : q.reject + '%'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="System health"
          subtitle="Core services and telemetry freshness"
          action={<button className="text-button" onClick={() => onNavigate('/services')}>Open Services</button>}
        >
          <ul className="health-list">
            {SERVICES.slice(0, 5).map((s) => (
              <li key={s.name} className="selectable" onClick={() => onNavigate('/services/' + s.name)}>
                <span className={'status-dot ' + (healthTone(s.state) === 'good' ? 'good' : healthTone(s.state) === 'warn' ? 'warn' : 'bad')} />
                <span><strong>{s.name}</strong><small>{s.detail}</small></span>
                <StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge>
              </li>
            ))}
          </ul>
        </Panel>
      </section>
    </>
  );
}
