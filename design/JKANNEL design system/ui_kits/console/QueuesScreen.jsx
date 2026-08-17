import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { QUEUES, SMSCS, healthTone } from './estate.jsx';

/* Section 7 and UC-QUE-01. Drain estimate is only shown when egress is stable;
   with zero egress it reads "unavailable", never infinity. The cause line names
   which of the four possibilities applies. */
export function QueuesScreen({ onNavigate }) {
  const [selectedId, setSelectedId] = React.useState('q-mtn-trx1');
  const queue = QUEUES.find((q) => q.id === selectedId);
  const smsc = SMSCS.find((s) => s.id === queue.destination);

  const cause = smsc.state === 'disconnected'
    ? { label: 'Carrier outage', detail: 'The destination SMSC is disconnected, so nothing is leaving. This is not capacity restriction or an operator decision.', tone: 'bad' }
    : smsc.suspended
      ? { label: 'Intentional suspension', detail: 'An operator suspended this connection. The queue is growing by design until traffic resumes.', tone: 'warn' }
      : queue.growth > 0
        ? { label: 'Capacity restriction', detail: 'Egress is below ingress while the carrier is throttling. The bind is up and delivering, just not fast enough.', tone: 'warn' }
        : { label: 'Draining normally', detail: 'Egress meets or exceeds ingress. No action needed.', tone: 'good' };

  const recovery = [
    { at: '01:41:44', label: 'reconnect issued', detail: 'operator cycled the bind, reason recorded', state: 'info' },
    { at: '01:42:02', label: 'egress resumed', detail: '188 → 212 msg/s', state: 'ok' },
    { at: '01:42:30', label: 'growth stopped', detail: 'net rate crossed below zero', state: 'ok' },
    { at: '01:51:00', label: 'projected empty', detail: 'if egress holds at 212 msg/s', state: 'info' },
  ];

  return (
    <>
      <Panel title="Queues" subtitle="Depth, age and growth per destination — select one to see cause and recovery" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Queue</th><th>Destination</th><th>Route</th>
                <th style={{ textAlign: 'right' }}>Depth</th><th style={{ textAlign: 'right' }}>Oldest</th>
                <th style={{ textAlign: 'right' }}>Ingress</th><th style={{ textAlign: 'right' }}>Egress</th>
                <th style={{ textAlign: 'right' }}>Growth</th><th style={{ textAlign: 'right' }}>Retries</th>
                <th style={{ textAlign: 'right' }}>Expired</th><th style={{ textAlign: 'right' }}>Drain</th>
              </tr>
            </thead>
            <tbody>
              {QUEUES.map((q) => (
                <tr key={q.id} className={q.id === selectedId ? 'selectable selected' : 'selectable'} onClick={() => setSelectedId(q.id)}>
                  <td className="mono">{q.id}</td>
                  <td className="mono">{q.destination}<span className="row-id">{q.carrier}</span></td>
                  <td>{q.route}</td>
                  <td className="figures" style={{ textAlign: 'right', color: q.depth > 500 ? 'var(--warn)' : undefined }}>{q.depth.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{q.oldest}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.ingress}/s</td>
                  <td className="figures" style={{ textAlign: 'right', color: q.egress === 0 ? 'var(--bad)' : undefined }}>{q.egress}/s</td>
                  <td className="figures" style={{ textAlign: 'right', color: q.growth > 0 ? 'var(--bad)' : q.growth < 0 ? 'var(--good)' : undefined }}>
                    {q.growth > 0 ? '+' : ''}{q.growth}/s
                  </td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.retries.toLocaleString()}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{q.expired}</td>
                  <td className="mono" style={{ textAlign: 'right', color: q.drainReliable ? undefined : 'var(--muted)' }}>{q.drainReliable ? q.drain : 'unavailable'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="split-grid">
        <Panel
          title={queue.id}
          subtitle={'Destination ' + queue.destination + ' · route ' + queue.route}
          action={
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/smscs')}>Open SMSC</button>
              <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/routes')}>Open route</button>
            </span>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <StatusBadge tone={cause.tone}>{cause.label}</StatusBadge>
            <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{cause.detail}</span>
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
            {[
              ['Depth', queue.depth.toLocaleString() + ' messages'],
              ['Oldest age', queue.oldest],
              ['Ingress / egress', queue.ingress + ' / ' + queue.egress + ' msg/s'],
              ['Net growth', (queue.growth > 0 ? '+' : '') + queue.growth + ' msg/s'],
              ['Awaiting retry', queue.retries.toLocaleString()],
              ['Expired recently', String(queue.expired)],
              ['Drain estimate', queue.drainReliable ? queue.drain : 'unavailable — egress is zero, so no honest estimate exists'],
              ['Destination state', smsc.state],
            ].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 14 }}>
            Messages already inside the engine cannot be rerouted individually — recover the destination, or
            suspend it and resend from the message log.
          </p>
        </Panel>

        <Panel title="Recovery progress" subtitle={queue.growth > 0 ? 'Projected once egress recovers' : 'Observed after the last operator action'}>
          <div style={{ marginTop: 16 }}>
            <Timeline items={recovery} />
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
            The projection assumes egress holds. It is recalculated from the last stable minute, not from a
            single sample.
          </p>
        </Panel>
      </section>
    </>
  );
}
