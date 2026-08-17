import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { ROUTES, SMSCS, healthTone } from './estate.jsx';

/* Section 9: network-level routes only — customer and commercial routing belongs
   to the CPaaS console and is deliberately absent. The active path is always
   visible, and a manual override is never hidden. */
export function RoutesScreen({ onNavigate }) {
  const [selectedId, setSelectedId] = React.useState('r-mtn');
  const route = ROUTES.find((r) => r.id === selectedId);
  const targetOf = (id) => SMSCS.find((s) => s.id === id);

  const targets = [
    { role: 'Primary', id: route.primary },
    { role: 'Secondary', id: route.secondary },
    { role: 'Emergency', id: route.emergency },
  ].filter((t) => t.id && t.id !== '—');

  return (
    <>
      <Panel title="Carrier routes" subtitle="Network-level routing and continuity. Customer-facing routing products are out of scope here." style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Route</th><th>Match</th><th>Active target</th><th>Alternatives</th><th>Mode</th>
                <th style={{ textAlign: 'right' }}>TPS</th><th style={{ textAlign: 'right' }}>Queue</th><th>Last transition</th>
              </tr>
            </thead>
            <tbody>
              {ROUTES.map((r) => {
                const active = targetOf(r.active);
                return (
                  <tr key={r.id} className={r.id === selectedId ? 'selectable selected' : 'selectable'} onClick={() => setSelectedId(r.id)}>
                    <td><strong style={{ color: 'var(--text-strong)' }}>{r.name}</strong></td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{r.match}</td>
                    <td>
                      {r.active === 'none'
                        ? <StatusBadge tone="bad">no active target</StatusBadge>
                        : <span><span className="mono">{r.active}</span><span className="row-id">{active ? active.state : ''}</span></span>}
                    </td>
                    <td className="figures">{[r.secondary, r.emergency].filter((t) => t && t !== '—').length}</td>
                    <td>{r.mode === 'manual' ? <StatusBadge tone="warn">manual override</StatusBadge> : 'automatic'}</td>
                    <td className="figures" style={{ textAlign: 'right' }}>{r.tps}</td>
                    <td className="figures" style={{ textAlign: 'right' }}>{r.queue.toLocaleString()}</td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{r.lastTransition}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="split-grid">
        <Panel
          title={route.name}
          subtitle={'Matches ' + route.match}
          action={<button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/failover')}>Fail over</button>}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <span className="t-caps">Active path</span>
            {route.active === 'none'
              ? <StatusBadge tone="bad">none — traffic is queueing</StatusBadge>
              : <span className="mono" style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{route.active}</span>}
            {route.mode === 'manual' ? <StatusBadge tone="warn">manual override in force</StatusBadge> : null}
          </div>
          {route.reason !== '—' ? (
            <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 10 }}>
              Last transition {route.lastTransition} — {route.reason}
            </p>
          ) : null}
          <div style={{ marginTop: 18 }}>
            <div className="t-caps" style={{ marginBottom: 8 }}>Targets in order</div>
            <div className="table-wrap" style={{ margin: 0 }}>
              <table>
                <thead><tr><th>Role</th><th>SMSC</th><th>Health</th><th style={{ textAlign: 'right' }}>Used / capacity</th><th style={{ textAlign: 'right' }}>Queue</th></tr></thead>
                <tbody>
                  {targets.map((t) => {
                    const s = targetOf(t.id);
                    return (
                      <tr key={t.role} style={t.id === route.active ? { background: 'var(--brand-soft)' } : undefined}>
                        <td>{t.role}{t.id === route.active ? <span className="row-id">carrying traffic</span> : null}</td>
                        <td className="mono">{t.id}</td>
                        <td>{s ? <StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge> : <StatusBadge tone="muted">unknown</StatusBadge>}</td>
                        <td className="figures" style={{ textAlign: 'right' }}>{s ? s.tpsOut + ' / ' + s.capacity : '—'}</td>
                        <td className="figures" style={{ textAlign: 'right' }}>{s ? s.queue.toLocaleString() : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>

        <Panel title="Continuity" subtitle="What happens to this route if the active target fails">
          {targets.length > 1 ? (
            <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
              {targets.map((t, i) => {
                const s = targetOf(t.id);
                const headroom = s ? s.capacity - s.tpsOut : 0;
                return (
                  <div key={t.role} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 10 }}>
                    <span className="mono" style={{ color: 'var(--muted)', fontSize: 13 }}>{i + 1}</span>
                    <div>
                      <strong style={{ display: 'block', fontSize: 14, color: 'var(--text-strong)' }}>{t.id}</strong>
                      <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>
                        {s ? (s.state === 'connected' || s.state === 'degraded'
                          ? 'Could absorb ' + headroom + ' more msg/s' + (headroom < route.tps ? ' — less than this route currently carries' : '')
                          : 'Unavailable: ' + s.state) : 'Not configured'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="chart-empty">
              No alternate target is configured. If {route.primary} fails, traffic for this route queues until
              it recovers — which is what happened to UTL at 01:19:58.
            </p>
          )}
        </Panel>
      </section>
    </>
  );
}
