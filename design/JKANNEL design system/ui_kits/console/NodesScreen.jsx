import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { NODES, healthTone } from './estate.jsx';

/* Section 14: hosts and their resource pressure, with the pressure that actually
   explains a degraded state called out rather than left in a wall of gauges. */
const Gauge = ({ label, value, unit = '%' }) => {
  const tone = value > 85 ? 'var(--bad)' : value > 70 ? 'var(--warn)' : 'var(--brand)';
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <strong className="figures" style={{ color: 'var(--text-strong)' }}>{value}{unit}</strong>
      </div>
      <span className="breakdown-track" style={{ height: 7 }}>
        <span className="breakdown-fill" style={{ width: value + '%', background: tone }} />
      </span>
    </div>
  );
};

export function NodesScreen() {
  const [selectedName, setSelectedName] = React.useState('kmx-db-01');
  const node = NODES.find((n) => n.name === selectedName);
  const pressure = node.disk > 70 ? 'Disk at ' + node.disk + '% is the pressure worth acting on here.'
    : node.ram > 70 ? 'Memory at ' + node.ram + '% is the pressure worth acting on here.'
    : 'No resource is under material pressure on this node.';

  return (
    <>
      <Panel title="Nodes" subtitle="Hosts running gateway components" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Node</th><th>Role</th><th>State</th><th style={{ textAlign: 'right' }}>CPU</th><th style={{ textAlign: 'right' }}>Memory</th><th style={{ textAlign: 'right' }}>Disk</th><th style={{ textAlign: 'right' }}>Network</th><th style={{ textAlign: 'right' }}>Load</th><th>Version</th></tr>
            </thead>
            <tbody>
              {NODES.map((n) => (
                <tr key={n.name} className={n.name === selectedName ? 'selectable selected' : 'selectable'} onClick={() => setSelectedName(n.name)}>
                  <td className="mono">{n.name}</td>
                  <td style={{ color: 'var(--muted)' }}>{n.role}</td>
                  <td><StatusBadge tone={healthTone(n.state)}>{n.state}</StatusBadge></td>
                  <td className="figures" style={{ textAlign: 'right' }}>{n.cpu}%</td>
                  <td className="figures" style={{ textAlign: 'right', color: n.ram > 70 ? 'var(--warn)' : undefined }}>{n.ram}%</td>
                  <td className="figures" style={{ textAlign: 'right', color: n.disk > 70 ? 'var(--warn)' : undefined }}>{n.disk}%</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{n.net}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{n.load}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{n.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="split-grid">
        <Panel title={node.name} subtitle={node.role}>
          <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
            <Gauge label="CPU" value={node.cpu} />
            <Gauge label="Memory" value={node.ram} />
            <Gauge label="Disk" value={node.disk} />
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '18px 0 0' }}>
            {[['Load average', node.load], ['Network I/O', node.net], ['Software', node.version], ['State', node.state]].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </Panel>

        <Panel title="Read as" subtitle="What the numbers above mean for the gateway">
          <p style={{ margin: '16px 0 0', fontSize: 14, color: 'var(--text)', lineHeight: 1.6 }}>{pressure}</p>
          <p style={{ margin: '12px 0 0', fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {node.name === 'kmx-db-01'
              ? 'Disk growth here is dominated by DLR retention. It has not affected submit latency yet, but it will if it reaches 90%.'
              : 'No action indicated. Watch it rather than acting on it.'}
          </p>
        </Panel>
      </section>
    </>
  );
}
