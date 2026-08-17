import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { MetricCard } from '../../components/core/MetricCard.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { MiniChart } from '../../components/data/MiniChart.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { CARRIERS, SMSCS, EVENTS, ALERTS, MT_SERIES, DLR_SERIES, CLOCK_LABELS, healthTone } from './estate.jsx';

/* UC-CON-01 as its own route. The incident context — carrier, health, window —
   is the page itself, so drilling into an SMSC or an event never loses it, and
   the carrier register stays a plain list however long it grows. */
const WHAT_CHANGED = {
  'mtn-ug': [
    'Throttling spike: ESME_RTHROTTLED from 0 to 4.1/s at 01:38',
    'Queue growth: +24 msg/s, depth passed 1,000 at 01:40',
    'Delivery drop: 98.1% to 96.2% over 20 minutes',
    'Sessions: 3 of 4 healthy, TRX-02 flapping',
  ],
  'utl-ug': [
    'Session loss: both sessions unbound at 01:19:58 after 6 missed enquire_link responses',
    'Egress stopped: 0 msg/s with 412 messages queued',
    'Delivery: unknown — no submissions accepted since the drop',
  ],
  'smart-ug': [
    'Delivery drop: below 95% since 00:58',
    'Throttling: 0.8% of submissions refused',
    'Manual route override in force since 00:58:40',
  ],
  'smile-ug': [
    'Telemetry stale since 00:12:31 — health is unknown, not healthy',
    'Target suspended by operator, so no traffic is expected',
  ],
};

export function CarrierDetailScreen({ carrierId, onNavigate, range }) {
  const carrier = CARRIERS.find((c) => c.id === carrierId);

  if (!carrier) {
    return (
      <Panel title="Carrier not found" subtitle="This carrier is not in the register">
        <p style={{ marginTop: 14, color: 'var(--muted)', fontSize: 14 }}>
          It may have been removed, or the link is stale.
        </p>
        <button className="primary-button" style={{ marginTop: 14 }} onClick={() => onNavigate('/carriers')}>Back to Carriers</button>
      </Panel>
    );
  }

  const smscs = SMSCS.filter((s) => s.carrierId === carrierId);
  const events = EVENTS.filter((e) => smscs.some((s) => s.id === e.object) || e.object === carrierId);
  const alerts = ALERTS.filter((a) => a.object === carrierId || smscs.some((s) => s.id === a.object));
  const changed = WHAT_CHANGED[carrierId] || ['No material change in the selected window.'];
  const utilisation = carrier.tps === null ? null : Math.round((carrier.tps / carrier.capacity) * 100);

  return (
    <>
      {carrier.health === 'unknown' ? (
        <p className="stale-banner">
          Telemetry for {carrier.name} is stale — last successful scrape {carrier.lastEvent.replace('telemetry stale ', '')}.
          Everything below is the last known value, and its health is reported unknown rather than healthy.
        </p>
      ) : null}

      <section className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <MetricCard label="Health" value={carrier.health} detail={carrier.name + ' · UG ' + carrier.mcc + '-' + carrier.mnc} icon="alert" tone={healthTone(carrier.health) === 'good' ? 'good' : healthTone(carrier.health) === 'warn' ? 'warn' : 'bad'} />
        <MetricCard label="Sessions healthy" value={carrier.sessionsUp + ' / ' + carrier.sessionsTotal} detail={'across ' + carrier.smscs + ' SMSC(s)'} icon="api" tone={carrier.sessionsUp < carrier.sessionsTotal ? 'warn' : 'primary'} />
        <MetricCard label="Utilisation" value={utilisation === null ? 'unknown' : utilisation + '%'} detail={carrier.tps === null ? 'telemetry stale' : carrier.tps + ' of ' + carrier.capacity + ' TPS'} icon="chart" />
        <MetricCard label="Queued" value={carrier.queue === null ? 'unknown' : carrier.queue.toLocaleString()} detail={'oldest ' + carrier.queueAge} icon="queue" tone={carrier.queue ? 'warn' : 'primary'} />
        <MetricCard label="Delivery" value={carrier.delivery === null ? 'unknown' : carrier.delivery + '%'} detail={'P95 ' + carrier.p95} icon="check" tone={carrier.delivery === null ? 'warn' : carrier.delivery < 95 ? 'bad' : 'good'} />
      </section>

      <section className="split-grid wide-left">
        <Panel
          title="Traffic and quality"
          subtitle={'Synchronised over the last ' + range + ', so a drop reads against the incident time'}
          action={<button className="text-button" onClick={() => onNavigate('/traffic')}>Open Live Traffic</button>}
        >
          <div style={{ marginTop: 16 }}>
            <MiniChart
              series={[{ name: 'MT submitted', values: MT_SERIES }, { name: 'DLR received', values: DLR_SERIES }]}
              labels={CLOCK_LABELS}
              height={160}
            />
          </div>
        </Panel>

        <Panel title="What changed" subtitle="Stated, not inferred">
          <ul style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'grid', gap: 10 }}>
            {changed.map((line) => (
              <li key={line} style={{ display: 'grid', gridTemplateColumns: '8px minmax(0, 1fr)', gap: 10, fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', marginTop: 6 }} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <Panel
        title="SMSCs"
        subtitle="Ranked by traffic impact and queue growth"
        action={<button className="text-button" onClick={() => onNavigate('/smscs')}>Open SMSCs</button>}
        style={{ marginTop: 16 }}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>SMSC</th><th>State</th><th>Sessions</th><th style={{ textAlign: 'right' }}>TPS out</th><th style={{ textAlign: 'right' }}>Capacity</th><th style={{ textAlign: 'right' }}>Queue</th><th style={{ textAlign: 'right' }}>Oldest</th><th style={{ textAlign: 'right' }}>Delivery</th><th>Last event</th></tr>
            </thead>
            <tbody>
              {smscs.map((s) => (
                <tr key={s.id} className="selectable" onClick={() => onNavigate('/smscs')}>
                  <td className="mono">{s.id}</td>
                  <td><StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge></td>
                  <td className="figures">{s.sessionsUp} / {s.sessionsTotal}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.tpsOut}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{Math.round((s.tpsOut / s.capacity) * 100)}% of {s.capacity}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.queue.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.queueAge}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.delivery === null ? 'unknown' : s.delivery + '%'}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{s.lastEvent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="split-grid" style={{ marginTop: 16 }}>
        <Panel
          title="Recent carrier events"
          subtitle="Structured events for this carrier and its SMSCs"
          action={<button className="text-button" onClick={() => onNavigate('/events')}>All events</button>}
        >
          {events.length ? (
            <div style={{ marginTop: 16 }}>
              <Timeline dense items={events.map((e) => ({ at: e.at.slice(11), label: e.type, detail: e.detail, state: e.severity === 'critical' ? 'error' : e.severity === 'warning' ? 'warn' : 'info' }))} />
            </div>
          ) : <p className="chart-empty">No events recorded for this carrier in the selected window.</p>}
        </Panel>

        <Panel
          title="Open alerts"
          subtitle="Incidents touching this carrier"
          action={<button className="text-button" onClick={() => onNavigate('/alerts')}>All alerts</button>}
        >
          {alerts.length ? (
            <ul className="health-list" style={{ marginTop: 8 }}>
              {alerts.map((a) => (
                <li key={a.id}>
                  <span className={'status-dot ' + (a.severity === 'critical' ? 'bad' : 'warn')} />
                  <span><strong>{a.summary}</strong><small>{a.impact} · active {a.duration}</small></span>
                  <StatusBadge tone={a.severity === 'critical' ? 'bad' : 'warn'}>{a.severity}</StatusBadge>
                </li>
              ))}
            </ul>
          ) : <p className="chart-empty">No open alerts for this carrier.</p>}
        </Panel>
      </section>
    </>
  );
}
