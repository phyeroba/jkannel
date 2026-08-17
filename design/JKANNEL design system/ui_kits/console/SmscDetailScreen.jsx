import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { MetricCard } from '../../components/core/MetricCard.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { ConfirmAction } from '../../components/feedback/ConfirmAction.jsx';
import { PageAction } from './AppShell.jsx';
import { SMSCS, SESSIONS, EVENTS, QUEUES, ROUTES, healthTone, BIND_LABELS } from './estate.jsx';

/* Section 4.2, UC-SMSC-01 and UC-SMSC-02 as their own route at /smscs/<id>. The
   register stays a plain list however many connections the estate grows to, and
   the controlled actions live with the connection they affect. Actions are
   state-aware: reconnect on a failed or degraded connection, suspend on a live
   one, resume on a suspended one — each states its impact and captures a reason. */
export function SmscDetailScreen({ smscId, onNavigate }) {
  const smsc = SMSCS.find((s) => s.id === smscId);
  const [action, setAction] = React.useState(null);
  const [result, setResult] = React.useState('');
  const [state, setState] = React.useState(null);

  if (!smsc) {
    return (
      <Panel title="SMSC not found" subtitle="This connection is not in the register">
        <p style={{ marginTop: 14, color: 'var(--muted)' }}>It may have been removed, or the link is stale.</p>
        <button className="primary-button" style={{ marginTop: 14 }} onClick={() => onNavigate('/smscs')}>Back to SMSCs</button>
      </Panel>
    );
  }

  const live = state || smsc.state;
  const sessions = SESSIONS.filter((s) => s.smsc === smsc.id);
  const events = EVENTS.filter((e) => e.object === smsc.id);
  const queue = QUEUES.find((q) => q.destination === smsc.id);
  const routes = ROUTES.filter((r) => r.primary === smsc.id || r.secondary === smsc.id || r.emergency === smsc.id);
  const utilisation = Math.round((smsc.tpsOut / smsc.capacity) * 100);

  const run = () => {
    const verb = action.kind;
    setState(verb === 'suspend' ? 'suspended' : verb === 'resume' ? 'connected' : live);
    setResult(
      verb === 'reconnect'
        ? (smsc.state === 'disconnected'
            ? 'Reconnect on ' + smsc.id + ' failed — connection refused by the carrier. Recorded with your reason; open the correlated events for the socket detail.'
            : 'Reconnect on ' + smsc.id + ' reported bind_cycled — the drop was observed and both sessions came back.')
        : verb === 'suspend'
          ? smsc.id + ' suspended. New submissions stop; existing sessions stay bound and the queue remains visible.'
          : smsc.id + ' resumed. Watching queue drain and error rate.'
    );
    setAction(null);
  };

  const impactFor = (kind) => {
    if (kind === 'reconnect') return [
      ['Current state', live],
      ['Sessions affected', smsc.sessionsUp + ' of ' + smsc.sessionsTotal],
      ['Queued messages', smsc.queue.toLocaleString() + ' (oldest ' + smsc.queueAge + ')'],
      ['Current throughput', smsc.tpsOut + ' msg/s out'],
      ['Expected impact', 'submissions pause while the bind cycles, typically 5-15s'],
    ];
    if (kind === 'suspend') return [
      ['Current state', live],
      ['Scope', 'stops new submissions only; sessions stay bound'],
      ['Queue now', smsc.queue.toLocaleString() + ' messages'],
      ['Ingress continues at', smsc.tpsOut + ' msg/s, so the queue will grow'],
      ['Alerting', 'a queue-growth alert will escalate if depth becomes critical'],
    ];
    return [
      ['Current state', live],
      ['Queue to drain', smsc.queue.toLocaleString() + ' messages'],
      ['Capacity', smsc.capacity + ' TPS ceiling'],
      ['After resuming', 'queue drain and error rate are monitored for 5 minutes'],
    ];
  };

  return (
    <>
      <PageAction>
        {live !== 'suspended' ? (
          <button className="primary-button" onClick={() => setAction({ kind: 'reconnect' })}>Reconnect</button>
        ) : null}
        {live === 'suspended'
          ? <button className="secondary-button" onClick={() => setAction({ kind: 'resume' })}>Resume traffic</button>
          : <button className="secondary-button danger-button" onClick={() => setAction({ kind: 'suspend' })}>Suspend traffic</button>}
      </PageAction>

      {result ? <p className="notice" style={{ marginBottom: 14 }}>{result}</p> : null}

      {live === 'suspended' ? (
        <p className="stale-banner">
          Suspended by an operator — this is not a carrier fault. Traffic stops here until somebody resumes it.
        </p>
      ) : null}

      <section className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <MetricCard label="State" value={live} detail={smsc.carrier + ' · ' + smsc.country} icon="alert" tone={healthTone(live) === 'good' ? 'good' : healthTone(live) === 'warn' ? 'warn' : 'bad'} />
        <MetricCard label="Sessions healthy" value={smsc.sessionsUp + ' / ' + smsc.sessionsTotal} detail={smsc.protocol} icon="api" tone={smsc.sessionsUp < smsc.sessionsTotal ? 'warn' : 'primary'} />
        <MetricCard label="Utilisation" value={utilisation + '%'} detail={smsc.tpsOut + ' of ' + smsc.capacity + ' TPS'} icon="chart" tone={utilisation > 80 ? 'warn' : 'primary'} />
        <MetricCard label="Queued" value={smsc.queue.toLocaleString()} detail={'oldest ' + smsc.queueAge} icon="queue" tone={smsc.queue ? 'warn' : 'primary'} />
        <MetricCard label="Delivery" value={smsc.delivery === null ? 'unknown' : smsc.delivery + '%'} detail={smsc.delivery === null ? 'no recent receipts' : 'P95 ' + smsc.dlrLatency} icon="check" tone={smsc.delivery === null ? 'warn' : smsc.delivery < 95 ? 'bad' : 'good'} />
      </section>

      <section className="split-grid wide-right">
        <Panel
          title="Connection"
          subtitle="Credentials are held by the engine and never sent to the browser"
        >
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
            {[
              ['State', live],
              ['Carrier', smsc.carrier],
              ['Country', smsc.country + ' (' + smsc.cc + ')'],
              ['Protocol', smsc.protocol],
              ['Sessions', smsc.sessionsUp + ' healthy of ' + smsc.sessionsTotal],
              ['Throughput', smsc.tpsOut + ' out / ' + smsc.tpsIn + ' in msg/s'],
              ['Capacity', smsc.capacity + ' TPS ceiling · ' + utilisation + '% used'],
              ['Queue', smsc.queue.toLocaleString() + ' waiting, oldest ' + smsc.queueAge],
              ['Delivery', smsc.delivery === null ? 'unknown — no recent receipts' : smsc.delivery + '% at ' + smsc.dlrLatency + ' P95'],
              ['Last event', smsc.lastEvent],
            ].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 16 }}>
            <button className="text-button" onClick={() => onNavigate('/carriers/' + smsc.carrierId)}>Open {smsc.carrier}</button>
            <button className="text-button" onClick={() => onNavigate('/queues')}>Open Queues</button>
          </div>
        </Panel>

        <Panel
          title="Sessions on this SMSC"
          subtitle="Compare siblings to tell a session fault from a carrier-wide one"
          action={<button className="text-button" onClick={() => onNavigate('/sessions')}>Open SMPP Sessions</button>}
        >
          <div className="table-wrap">
            <table>
              <thead><tr><th>Session</th><th>Bind</th><th style={{ textAlign: 'right' }}>Uptime</th><th style={{ textAlign: 'right' }}>Reconnects</th><th style={{ textAlign: 'right' }}>Timeouts</th><th>Top error</th><th>Health</th></tr></thead>
              <tbody>
                {sessions.length ? sessions.map((s) => (
                  <tr key={s.id} className="selectable" onClick={() => onNavigate('/sessions')}>
                    <td className="mono">{s.id}</td>
                    <td>
                      <span style={{ color: 'var(--text-strong)' }}>{BIND_LABELS[s.bind] || s.bind}</span>
                      <span className="row-id">{s.bind}</span>
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{s.uptime}</td>
                    <td className="figures" style={{ textAlign: 'right', color: s.reconnects > 3 ? 'var(--bad)' : undefined }}>{s.reconnects}</td>
                    <td className="figures" style={{ textAlign: 'right' }}>{s.timeouts}</td>
                    <td className="mono" style={{ fontSize: 13.5 }}>{s.topError}</td>
                    <td><StatusBadge tone={healthTone(s.health)}>{s.health}</StatusBadge></td>
                  </tr>
                )) : <tr><td className="empty-cell" colSpan={7}>No sessions configured on this connection.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      <section className="split-grid" style={{ marginTop: 16 }}>
        <Panel
          title="Recent events"
          subtitle="Structured events recorded against this connection"
          action={<button className="text-button" onClick={() => onNavigate('/events')}>All events</button>}
        >
          {events.length ? (
            <div style={{ marginTop: 16 }}>
              <Timeline dense items={events.map((e) => ({ at: e.at.slice(11), label: e.type, detail: e.detail, state: e.severity === 'critical' ? 'error' : e.severity === 'warning' ? 'warn' : 'info' }))} />
            </div>
          ) : <p className="chart-empty">No events for this connection in the selected window.</p>}
        </Panel>

        <Panel
          title="Queue and routing"
          subtitle="What depends on this connection staying up"
          action={<button className="text-button" onClick={() => onNavigate('/routes')}>Open Carrier Routes</button>}
        >
          {queue ? (
            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
              {[
                ['Depth', queue.depth.toLocaleString() + ' messages'],
                ['Oldest', queue.oldest],
                ['Ingress / egress', queue.ingress + ' / ' + queue.egress + ' msg/s'],
                ['Growth', (queue.growth > 0 ? '+' : '') + queue.growth + ' msg/s'],
                ['Drain estimate', queue.drainReliable ? queue.drain : 'unavailable — no egress'],
              ].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                  <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : <p style={{ color: 'var(--muted)', marginTop: 16 }}>No queue is currently held for this connection.</p>}

          <div style={{ marginTop: 20 }}>
            <div className="t-caps" style={{ marginBottom: 8 }}>Routes using this connection</div>
            {routes.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {routes.map((r) => (
                  <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span>{r.name}</span>
                    <span className="mono" style={{ color: 'var(--muted)' }}>
                      {r.primary === smsc.id ? 'primary' : r.secondary === smsc.id ? 'secondary' : 'emergency'}
                      {r.active === smsc.id ? ' · active' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p style={{ color: 'var(--muted)', margin: 0 }}>No route targets this connection.</p>}
          </div>
        </Panel>
      </section>

      <ConfirmAction
        open={Boolean(action)}
        title={action ? (action.kind === 'reconnect' ? 'Reconnect ' + smsc.id : action.kind === 'suspend' ? 'Suspend traffic on ' + smsc.id : 'Resume traffic on ' + smsc.id) : ''}
        verb={action ? (action.kind === 'reconnect' ? 'Reconnect' : action.kind === 'suspend' ? 'Suspend' : 'Resume') : ''}
        danger={action ? action.kind === 'suspend' : false}
        warning={action && action.kind === 'suspend' ? 'Traffic keeps arriving while this connection is suspended, so its queue will grow. Suspension is recorded as an operator decision, not a carrier fault.' : null}
        impact={action ? impactFor(action.kind) : []}
        onClose={() => setAction(null)}
        onConfirm={run}
      />
    </>
  );
}
