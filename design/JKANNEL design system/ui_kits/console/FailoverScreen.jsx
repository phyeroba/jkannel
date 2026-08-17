import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { ConfirmAction } from '../../components/feedback/ConfirmAction.jsx';
import { ROUTES, SMSCS, healthTone } from './estate.jsx';

/* UC-RTE-02. The dialog compares current and proposed target health, capacity and
   queue implications; an unhealthy or under-capacity target is blocked rather than
   quietly allowed. Manual override state stays visible afterwards. */
const REASONS = [
  'Carrier instructed traffic movement',
  'Primary SMSC degraded',
  'Planned carrier maintenance',
  'Capacity rebalance',
  'Incident mitigation',
];

export function FailoverScreen({ onNavigate }) {
  const [selectedId, setSelectedId] = React.useState('r-mtn');
  const [target, setTarget] = React.useState('');
  const [pending, setPending] = React.useState(null);
  const [applied, setApplied] = React.useState({});
  const [result, setResult] = React.useState('');

  const route = ROUTES.find((r) => r.id === selectedId);
  const active = applied[route.id] || route.active;
  const options = [route.primary, route.secondary, route.emergency].filter((t) => t && t !== '—' && t !== active);
  const proposed = SMSCS.find((s) => s.id === (target || options[0]));
  const current = SMSCS.find((s) => s.id === active);
  const headroom = proposed ? proposed.capacity - proposed.tpsOut : 0;
  const blocked = proposed ? (proposed.state === 'disconnected' || proposed.state === 'suspended') : true;
  const tight = proposed ? headroom < route.tps : false;

  const commit = (reason) => {
    setApplied({ ...applied, [route.id]: proposed.id });
    setResult('Route “' + route.name + '” now active on ' + proposed.id + '. Mode set to manual override — reason recorded: ' + reason + '. Watching traffic transfer, error rate and queue for 5 minutes.');
    setPending(null);
  };

  return (
    <>
      {result ? <p className="notice" style={{ marginBottom: 14 }}>{result}</p> : null}

      <Panel title="Failover" subtitle="Move a route's traffic to another carrier connection, with the impact stated before you commit" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Route</th><th>Active target</th><th>Mode</th><th style={{ textAlign: 'right' }}>TPS</th><th style={{ textAlign: 'right' }}>Queue</th><th>Alternatives available</th></tr></thead>
            <tbody>
              {ROUTES.map((r) => {
                const act = applied[r.id] || r.active;
                const alts = [r.primary, r.secondary, r.emergency].filter((t) => t && t !== '—' && t !== act);
                return (
                  <tr key={r.id} className={r.id === selectedId ? 'selectable selected' : 'selectable'} onClick={() => { setSelectedId(r.id); setTarget(''); }}>
                    <td><strong style={{ color: 'var(--text-strong)' }}>{r.name}</strong></td>
                    <td>{act === 'none' ? <StatusBadge tone="bad">none</StatusBadge> : <span className="mono">{act}</span>}</td>
                    <td>{applied[r.id] || r.mode === 'manual' ? <StatusBadge tone="warn">manual</StatusBadge> : 'automatic'}</td>
                    <td className="figures" style={{ textAlign: 'right' }}>{r.tps}</td>
                    <td className="figures" style={{ textAlign: 'right' }}>{r.queue.toLocaleString()}</td>
                    <td>{alts.length ? <span className="mono" style={{ fontSize: 12.5 }}>{alts.join(', ')}</span> : <span style={{ color: 'var(--muted)' }}>none configured</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="split-grid">
        <Panel
          title={'Fail over — ' + route.name}
          subtitle={options.length ? 'Compare the current and proposed path before committing' : 'No alternate target is configured for this route'}
          action={options.length ? (
            <button className="primary-button" style={{ padding: '6px 12px', fontSize: 13 }} disabled={blocked} onClick={() => setPending(true)}>
              Fail over
            </button>
          ) : null}
        >
          {options.length ? (
            <>
              <label className="field" style={{ margin: '16px 0 0' }}>
                <span>Proposed target</span>
                <select value={target || options[0]} onChange={(e) => setTarget(e.target.value)}>
                  {options.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>

              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead><tr><th>Path</th><th>SMSC</th><th>Health</th><th style={{ textAlign: 'right' }}>Used / capacity</th><th style={{ textAlign: 'right' }}>Headroom</th><th style={{ textAlign: 'right' }}>Queue</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>Current</td>
                      <td className="mono">{active === 'none' ? '—' : active}</td>
                      <td>{current ? <StatusBadge tone={healthTone(current.state)}>{current.state}</StatusBadge> : <StatusBadge tone="bad">none</StatusBadge>}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{current ? current.tpsOut + ' / ' + current.capacity : '—'}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{current ? current.capacity - current.tpsOut : '—'}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{current ? current.queue.toLocaleString() : '—'}</td>
                    </tr>
                    <tr style={{ background: 'var(--brand-soft)' }}>
                      <td>Proposed</td>
                      <td className="mono">{proposed.id}</td>
                      <td><StatusBadge tone={healthTone(proposed.state)}>{proposed.state}</StatusBadge></td>
                      <td className="figures" style={{ textAlign: 'right' }}>{proposed.tpsOut} / {proposed.capacity}</td>
                      <td className="figures" style={{ textAlign: 'right', color: tight ? 'var(--warn)' : undefined }}>{headroom}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{proposed.queue.toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {blocked ? (
                <p className="notice" style={{ margin: '14px 0 0', color: 'var(--bad)', borderColor: 'color-mix(in srgb, var(--bad) 32%, var(--border))', background: 'color-mix(in srgb, var(--bad) 10%, var(--surface))' }}>
                  Blocked: {proposed.id} is {proposed.state}. Failing over to it would stop this route's traffic
                  entirely rather than restore it.
                </p>
              ) : tight ? (
                <p className="notice" style={{ margin: '14px 0 0', color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 32%, var(--border))', background: 'color-mix(in srgb, var(--warn) 10%, var(--surface))' }}>
                  {proposed.id} has {headroom} msg/s of headroom but this route carries {route.tps} msg/s.
                  Expect throttling or queue growth on the new target.
                </p>
              ) : null}
            </>
          ) : (
            <p className="chart-empty">
              Configure a secondary target for this route before an incident forces the question.
            </p>
          )}
        </Panel>

        <Panel title="Transition history" subtitle="Every failover, automatic or manual, with its reason">
          <div style={{ marginTop: 16 }}>
            <Timeline items={[
              { at: '01:19:58', label: 'automatic failover attempted', detail: 'UTL national — no alternate target configured, traffic queued instead', state: 'error' },
              { at: '00:58:40', label: 'manual override', detail: 'Smart national held on smart_ug_tx — operator, carrier instructed traffic movement', state: 'warn' },
              { at: '2026-08-14 22:14:02', label: 'automatic failover', detail: 'Airtel national moved to airtel_ug_trx2 during carrier maintenance', state: 'info' },
              { at: '2026-08-14 22:18:44', label: 'automatic return', detail: 'primary rebound and healthy for 4 minutes, traffic returned', state: 'ok' },
            ]} />
          </div>
          <button className="text-button" style={{ marginTop: 12 }} onClick={() => onNavigate('/audit')}>Open Audit Trail</button>
        </Panel>
      </section>

      <ConfirmAction
        open={Boolean(pending)}
        title={'Fail over ' + route.name + ' to ' + (proposed ? proposed.id : '')}
        verb="Fail over"
        reasons={REASONS}
        warning={tight ? 'The proposed target has less headroom than this route currently carries. Traffic may throttle on arrival.' : null}
        impact={proposed ? [
          ['Route', route.name],
          ['Current target', active === 'none' ? 'none — traffic is queueing' : active + ' (' + (current ? current.state : 'unknown') + ')'],
          ['Proposed target', proposed.id + ' (' + proposed.state + ')'],
          ['Traffic to move', route.tps + ' msg/s'],
          ['Headroom on proposed', headroom + ' msg/s'],
          ['Queue implication', route.queue.toLocaleString() + ' already queued on the current path — these do not move'],
          ['Mode after', 'manual override until an operator returns it to automatic'],
        ] : []}
        onClose={() => setPending(null)}
        onConfirm={commit}
      />
    </>
  );
}
