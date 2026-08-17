import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { ROUTES, SMSCS, PREFIX_MAP, healthTone } from './estate.jsx';

/* UC-RTE-01. Explicitly non-transmitting: it resolves the number, names the
   market and network, evaluates the live rules and explains why the route
   matched — without sending anything. */
export function SimulatorScreen({ onNavigate }) {
  const [input, setInput] = React.useState('0772 000 118');
  const [attrs, setAttrs] = React.useState('none');
  const [result, setResult] = React.useState(null);

  const resolve = () => {
    const digits = input.replace(/[^0-9]/g, '');
    const e164 = digits.startsWith('256') ? digits : digits.startsWith('0') ? '256' + digits.slice(1) : digits;
    const match = PREFIX_MAP.find((p) => e164.startsWith(p.prefix));
    if (!match) {
      setResult({ e164: '+' + e164, none: true });
      return;
    }
    const route = ROUTES.find((r) => r.name === match.route);
    const target = SMSCS.find((s) => s.id === route.active);
    const fallbacks = [route.secondary, route.emergency].filter((t) => t && t !== '—');
    setResult({ e164: '+' + e164, prefix: match.prefix, carrier: match.carrier, route, target, fallbacks });
  };

  return (
    <section className="split-grid wide-right">
      <Panel title="Route simulator" subtitle="Resolves a destination against the live rules. Nothing is transmitted and no counter moves.">
        <p className="notice" style={{ margin: '14px 0 0' }}>
          Non-transmitting. This tool answers “where would this go?” — it never sends a message. To send a
          real test, use Test Tools.
        </p>
        <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Destination MSISDN</span>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0772 000 118 or +256772000118" />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Technical attributes (optional)</span>
            <select value={attrs} onChange={(e) => setAttrs(e.target.value)}>
              {['none', 'UCS-2 payload', 'binary / UDH', 'high priority'].map((a) => <option key={a}>{a}</option>)}
            </select>
          </label>
          <div><button className="primary-button" onClick={resolve}>Resolve route</button></div>
        </div>
      </Panel>

      <Panel title="Decision" subtitle="Which SMSC this destination would take right now, and why">
        {result ? (
          result.none ? (
            <div style={{ marginTop: 16 }}>
              <StatusBadge tone="bad">No route</StatusBadge>
              <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 10 }}>
                {result.e164} normalised successfully but matches no configured prefix, so routing would fail
                closed rather than pick an arbitrary bind. Add a prefix to a carrier route to cover it.
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0, padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
                {[
                  ['Normalised', result.e164],
                  ['Market / network', 'Uganda · ' + result.carrier],
                  ['Matched prefix', result.prefix],
                  ['Route', result.route.name],
                  ['Selected SMSC', result.route.active === 'none' ? 'none available' : result.route.active],
                  ['Mode', result.route.mode],
                ].map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</dt>
                    <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>

              <div>
                <div className="t-caps" style={{ marginBottom: 8 }}>Fallback order</div>
                {result.fallbacks.length ? (
                  <div className="table-wrap" style={{ margin: 0 }}>
                    <table>
                      <thead><tr><th>Order</th><th>SMSC</th><th>Health</th><th style={{ textAlign: 'right' }}>Headroom</th></tr></thead>
                      <tbody>
                        {result.fallbacks.map((id, i) => {
                          const s = SMSCS.find((x) => x.id === id);
                          return (
                            <tr key={id}>
                              <td className="figures">{i + 1}</td>
                              <td className="mono">{id}</td>
                              <td>{s ? <StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge> : <StatusBadge tone="muted">unknown</StatusBadge>}</td>
                              <td className="figures" style={{ textAlign: 'right' }}>{s ? (s.capacity - s.tpsOut) + ' msg/s' : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>
                    None configured — if the selected SMSC is unavailable this traffic queues.
                  </p>
                )}
              </div>

              <div>
                <div className="t-caps" style={{ marginBottom: 6 }}>Why</div>
                <ol style={{ margin: 0, paddingLeft: 20, color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.7 }}>
                  <li>Number normalised to E.164 and resolved to {result.carrier} by prefix {result.prefix}.</li>
                  <li>Route “{result.route.name}” is the only rule matching that prefix.</li>
                  <li>
                    {result.target
                      ? 'Primary target ' + result.target.id + ' is ' + result.target.state + ', so it keeps the traffic.'
                      : 'No target is currently available, so traffic for this route queues.'}
                  </li>
                  {result.route.mode === 'manual' ? <li>A manual override is in force on this route — automatic selection is suspended.</li> : null}
                </ol>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/routes')}>Open route</button>
                <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/tools')}>Send a real test</button>
              </div>
            </div>
          )
        ) : (
          <p className="chart-empty">Enter a destination and resolve it to see the matched route, selected SMSC and fallback order.</p>
        )}
      </Panel>
    </section>
  );
}
