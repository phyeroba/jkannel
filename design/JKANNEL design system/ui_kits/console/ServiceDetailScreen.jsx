import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { MetricCard } from '../../components/core/MetricCard.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { ConfirmAction } from '../../components/feedback/ConfirmAction.jsx';
import { SERVICES, healthTone } from './estate.jsx';

/* UC-SYS-01 as its own route. The dependency view distinguishes a root failure
   from a downstream symptom, and restart is impact-first with a reason captured. */
export const DEPENDENCIES = {
  bearerbox: ['postgres', 'sqlbox'],
  'smsbox-01': ['bearerbox'],
  'smsbox-02': ['bearerbox'],
  sqlbox: ['postgres'],
  postgres: [],
  redis: [],
  'metrics-collector': ['bearerbox', 'postgres'],
};

const SERVICE_HISTORY = {
  bearerbox: [
    { at: '01:41:12', label: 'carrier bind degraded', detail: 'mtn_ug_trx1 throttled — reported by the transport, not a fault in this service', state: 'warn' },
    { at: '01:19:58', label: 'session dropped', detail: 'utl_ug_trx unbound after missed keepalives', state: 'error' },
    { at: '2026-08-09 21:04', label: 'started', detail: 'process start after planned upgrade to kamex 1.8.3', state: 'ok' },
  ],
  'metrics-collector': [
    { at: '01:29:44', label: 'scrape failed', detail: 'smile_ug_tx context deadline exceeded — dependent health marked unknown', state: 'error' },
    { at: '00:29:12', label: 'started', detail: 'restarted after OOM kill', state: 'warn' },
    { at: '00:29:02', label: 'stopped', detail: 'OOM killed at 512 MB limit', state: 'error' },
  ],
};

export function ServiceDetailScreen({ serviceName, onNavigate }) {
  const [restart, setRestart] = React.useState(false);
  const [result, setResult] = React.useState('');
  const service = SERVICES.find((s) => s.name === serviceName);

  if (!service) {
    return (
      <Panel title="Service not found" subtitle="This component is not in the register">
        <p style={{ marginTop: 14, color: 'var(--muted)', fontSize: 14 }}>It may have been removed, or the link is stale.</p>
        <button className="primary-button" style={{ marginTop: 14 }} onClick={() => onNavigate('/services')}>Back to Services</button>
      </Panel>
    );
  }

  const deps = DEPENDENCIES[serviceName] || [];
  const dependents = Object.entries(DEPENDENCIES).filter(([, list]) => list.includes(serviceName)).map(([name]) => name);
  const rootCause = deps.find((d) => {
    const dep = SERVICES.find((s) => s.name === d);
    return dep && dep.state !== 'healthy';
  });
  const history = SERVICE_HISTORY[serviceName];

  return (
    <>
      {result ? <p className="notice" style={{ marginBottom: 14 }}>{result}</p> : null}

      <section className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <MetricCard label="State" value={service.state} detail={service.detail} icon="alert" tone={healthTone(service.state) === 'good' ? 'good' : healthTone(service.state) === 'warn' ? 'warn' : 'bad'} />
        <MetricCard label="Uptime" value={service.uptime} detail="since last process start" icon="cog" />
        <MetricCard label="CPU" value={service.cpu + '%'} detail="of its container limit" icon="chart" tone={service.cpu > 70 ? 'warn' : 'primary'} />
        <MetricCard label="Memory" value={service.ram + '%'} detail="of its container limit" icon="db" tone={service.ram > 70 ? 'warn' : 'primary'} />
        <MetricCard label="Throughput" value={service.rate} detail={service.role} icon="server" />
      </section>

      <section className="split-grid">
        <Panel
          title={service.name}
          subtitle={service.role}
          action={
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => onNavigate('/logs')}>Open logs</button>
              <button className="secondary-button danger-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => setRestart(true)}>Restart</button>
            </span>
          }
        >
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
            {[['State', service.state], ['Uptime', service.uptime], ['CPU', service.cpu + '%'], ['Memory', service.ram + '%'], ['Throughput', service.rate], ['Detail', service.detail]].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>

          {history ? (
            <div style={{ marginTop: 20 }}>
              <div className="t-caps" style={{ marginBottom: 8 }}>Recent process and health events</div>
              <Timeline dense items={history} />
            </div>
          ) : null}
        </Panel>

        <Panel title="Dependencies" subtitle={rootCause ? 'A dependency is unhealthy — this service may be a symptom, not the cause' : 'Root failure or downstream symptom'}>
          <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
            <div>
              <div className="t-caps" style={{ marginBottom: 8 }}>Depends on</div>
              {deps.length ? (
                <ul className="health-list" style={{ margin: 0 }}>
                  {deps.map((d) => {
                    const dep = SERVICES.find((s) => s.name === d);
                    return (
                      <li key={d} className="selectable" onClick={() => onNavigate('/services/' + d)}>
                        <span className={'status-dot ' + (healthTone(dep.state) === 'good' ? 'good' : healthTone(dep.state) === 'warn' ? 'warn' : 'bad')} />
                        <span><strong>{d}</strong><small>{dep.detail}</small></span>
                        <StatusBadge tone={healthTone(dep.state)}>{dep.state}</StatusBadge>
                      </li>
                    );
                  })}
                </ul>
              ) : <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>Nothing — this is a root service.</p>}
            </div>

            <div>
              <div className="t-caps" style={{ marginBottom: 8 }}>Affected if this fails</div>
              {dependents.length ? (
                <ul className="health-list" style={{ margin: 0 }}>
                  {dependents.map((d) => {
                    const dep = SERVICES.find((s) => s.name === d);
                    return (
                      <li key={d} className="selectable" onClick={() => onNavigate('/services/' + d)}>
                        <span className={'status-dot ' + (healthTone(dep.state) === 'good' ? 'good' : healthTone(dep.state) === 'warn' ? 'warn' : 'bad')} />
                        <span><strong>{d}</strong><small>{dep.role}</small></span>
                        <StatusBadge tone={healthTone(dep.state)}>{dep.state}</StatusBadge>
                      </li>
                    );
                  })}
                </ul>
              ) : <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>No other service depends on it.</p>}
            </div>

            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6 }}>
              {rootCause
                ? 'Fix ' + rootCause + ' first. Restarting ' + service.name + ' while its dependency is unhealthy usually changes nothing.'
                : service.state === 'healthy'
                  ? 'This service is healthy. If traffic is affected, look upstream at the carrier rather than here.'
                  : 'No unhealthy dependency, so this looks like a root failure in ' + service.name + '.'}
            </p>
          </div>
        </Panel>
      </section>

      <ConfirmAction
        open={restart}
        title={'Restart ' + service.name}
        verb="Restart"
        danger
        warning={dependents.length ? 'Restarting this service interrupts ' + dependents.join(', ') + '. Carrier submissions pause until it is back and healthy.' : null}
        impact={[
          ['Current state', service.state],
          ['Uptime lost', service.uptime],
          ['Dependent services', dependents.length ? dependents.join(', ') : 'none'],
          ['Traffic impact', service.name === 'bearerbox' ? 'all carrier submissions pause, typically 10-30s' : 'submissions handled by the sibling instance'],
          ['Recovery check', 'health and downstream SMSC impact are monitored after restart'],
        ]}
        onClose={() => setRestart(false)}
        onConfirm={(reason) => { setResult('Restart of ' + service.name + ' issued — reason recorded: ' + reason + '. Watching health and downstream SMSC impact.'); setRestart(false); }}
      />
    </>
  );
}
