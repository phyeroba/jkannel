import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { Drawer } from '../../components/feedback/Drawer.jsx';
import { SESSIONS, SMPP_ERRORS, healthTone, BIND_LABELS } from './estate.jsx';

/* Section 5 and UC-SMPP-01. The register is the whole screen; opening a session
   slides its detail in from the right at half the viewport so the operator keeps
   their place in the table. Bind state is mapped to human-readable status, the
   endpoint never shows credentials, and a flapping session is diagnosed from a
   bind timeline rather than by inferring sequence from separate tables. */
const BIND_HISTORY = {
  'TRX-02': [
    { at: '01:11:40', label: 'bind failed', detail: 'ESME_RALYBND — previous bind not yet released', state: 'error' },
    { at: '01:12:04', label: 'enquire_link timeout', detail: 'no response within 5s, 1 missed', state: 'warn' },
    { at: '01:12:18', label: 'socket closed', detail: 'remote peer reset the connection', state: 'error' },
    { at: '01:12:40', label: 'bound', detail: 'BOUND_TRX re-established, RTT 388 ms', state: 'ok' },
    { at: '01:33:02', label: 'bind failed', detail: 'ESME_RALYBND on retry 6', state: 'error' },
    { at: '01:37:02', label: 'bound', detail: 'BOUND_TRX re-established', state: 'ok' },
    { at: '01:41:11', label: 'throttled', detail: 'ESME_RTHROTTLED at 4.1/s while bound', state: 'warn' },
  ],
  'TRX-06': [
    { at: '01:18:44', label: 'enquire_link timeout', detail: 'first missed response', state: 'warn' },
    { at: '01:19:31', label: 'enquire_link timeout', detail: '6 consecutive missed responses', state: 'error' },
    { at: '01:19:58', label: 'unbound', detail: 'session dropped by the gateway after missed keepalives', state: 'error' },
    { at: '01:20:44', label: 'bind failed', detail: 'connection refused (errno 111) — carrier not accepting', state: 'error' },
    { at: '—', label: 'bound', detail: 'never re-established', state: 'missing' },
  ],
};

function DetailList({ rows }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: 0 }}>
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
          <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function SectionHead({ title, note }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="t-caps">{title}</div>
      {note ? <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13.5 }}>{note}</p> : null}
    </div>
  );
}

export function SessionsScreen({ onNavigate, range }) {
  const [openId, setOpenId] = React.useState(null);
  const [smsc, setSmsc] = React.useState('any');
  const [compare, setCompare] = React.useState(false);
  const [summary, setSummary] = React.useState(false);

  const rows = SESSIONS.filter((s) => smsc === 'any' || s.smsc === smsc);
  const session = openId ? SESSIONS.find((s) => s.id === openId) : null;
  const siblings = session ? SESSIONS.filter((s) => s.smsc === session.smsc) : [];
  const history = session ? BIND_HISTORY[session.id] : null;
  const errors = session ? SMPP_ERRORS.filter((e) => e.session === session.id) : [];

  const close = () => { setOpenId(null); setCompare(false); setSummary(false); };

  return (
    <>
      <Panel
        title="SMPP Sessions"
        subtitle="Bind state, keepalive health and protocol counters for every session. Open a session for its bind history."
        action={
          <FilterSelect label="SMSC" value={smsc} onChange={(e) => setSmsc(e.target.value)}>
            {['any', ...new Set(SESSIONS.map((s) => s.smsc))].map((s) => <option key={s}>{s}</option>)}
          </FilterSelect>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th><th>SMSC</th><th>Bind state</th><th>Endpoint</th>
                <th style={{ textAlign: 'right' }}>Uptime</th><th style={{ textAlign: 'right' }}>Enquire RTT</th>
                <th style={{ textAlign: 'right' }}>Missed</th><th style={{ textAlign: 'right' }}>Reconnects</th>
                <th style={{ textAlign: 'right' }}>Timeouts</th><th style={{ textAlign: 'right' }}>P95 latency</th>
                <th>Top error</th><th>Health</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.id === openId ? 'selectable selected' : 'selectable'} onClick={() => setOpenId(s.id)}>
                  <td className="mono">{s.id}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{s.smsc}</td>
                  <td>
                    <span style={{ color: 'var(--text-strong)' }}>{BIND_LABELS[s.bind] || s.bind}</span>
                    <span className="row-id">{s.bind}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{s.endpoint}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.uptime}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.enquireRtt}</td>
                  <td className="figures" style={{ textAlign: 'right', color: s.enquireMissed > 2 ? 'var(--bad)' : undefined }}>{s.enquireMissed}</td>
                  <td className="figures" style={{ textAlign: 'right', color: s.reconnects > 3 ? 'var(--bad)' : undefined }}>{s.reconnects}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.timeouts}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.latencyP95}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{s.topError}</td>
                  <td><StatusBadge tone={healthTone(s.health)}>{s.health}</StatusBadge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Drawer
        open={!!session}
        eyebrow={session ? session.smsc : ''}
        title={session ? session.id : ''}
        subtitle={session ? BIND_LABELS[session.bind] + ' · ' + session.carrier : ''}
        onClose={close}
        actions={
          session ? (
            <>
              <button className="secondary-button" onClick={() => setCompare(true)}>Compare sessions</button>
              <button className="secondary-button" onClick={() => setSummary(true)}>Diagnostic summary</button>
            </>
          ) : null
        }
      >
        {session ? (
          <>
            <div>
              <SectionHead title="Session" />
              <DetailList rows={[
                ['Bind state', BIND_LABELS[session.bind] + ' (' + session.bind + ')'],
                ['Endpoint', session.endpoint],
                ['Uptime', session.uptime],
                ['Last activity', session.lastActivity],
                ['Enquire link', session.enquireRtt + ' RTT · ' + session.enquireMissed + ' missed'],
                ['submit_sm', session.submit.toLocaleString() + ' / ' + session.submitResp.toLocaleString() + ' resp'],
                ['deliver_sm', session.deliver.toLocaleString() + ' / ' + session.deliverResp.toLocaleString() + ' resp'],
                ['generic_nack', String(session.nack)],
                ['Response latency P95', session.latencyP95],
                ['Reconnects (' + range + ')', String(session.reconnects)],
                ['Timeouts', String(session.timeouts)],
              ]} />
            </div>

            {errors.length ? (
              <div>
                <SectionHead title="Top command statuses" />
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {errors.map((e) => (
                    <li key={e.code} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13.5 }}>
                      <span className="mono">{e.name}</span>
                      <span className="figures" style={{ color: 'var(--muted)' }}>{e.count.toLocaleString()} · {e.rate}</span>
                    </li>
                  ))}
                </ul>
                <button className="text-button" style={{ marginTop: 10 }} onClick={() => onNavigate('/smpp-errors')}>Open SMPP Errors</button>
              </div>
            ) : null}

            <div>
              <SectionHead
                title="Bind timeline"
                note={history
                  ? 'Disconnects aligned with keepalive timeouts, socket errors and protocol responses'
                  : 'No bind transitions recorded in this window'}
              />
              {history ? (
                <>
                  <Timeline items={history} />
                  <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
                    {session.reconnects > 3
                      ? 'This session reconnected ' + session.reconnects + ' times while its siblings on the same SMSC stayed bound, which points at the session rather than the carrier.'
                      : 'Compare against sibling sessions before escalating to the carrier.'}
                  </p>
                </>
              ) : (
                <p className="chart-empty">This session has been stable for the selected window. Widen the range to see older transitions.</p>
              )}
            </div>
          </>
        ) : null}
      </Drawer>

      {session ? (
        <>
          <Dialog open={compare} title={'Sessions on ' + session.smsc} onClose={() => setCompare(false)}>
            <div className="table-wrap" style={{ margin: 0 }}>
              <table>
                <thead><tr><th>Session</th><th>Bind</th><th style={{ textAlign: 'right' }}>Uptime</th><th style={{ textAlign: 'right' }}>Reconnects</th><th style={{ textAlign: 'right' }}>Timeouts</th><th style={{ textAlign: 'right' }}>Missed</th><th>Health</th></tr></thead>
                <tbody>
                  {siblings.map((s) => (
                    <tr key={s.id} style={s.id === session.id ? { background: 'var(--brand-soft)' } : undefined}>
                      <td className="mono">{s.id}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{s.bind}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{s.uptime}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{s.reconnects}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{s.timeouts}</td>
                      <td className="figures" style={{ textAlign: 'right' }}>{s.enquireMissed}</td>
                      <td><StatusBadge tone={healthTone(s.health)}>{s.health}</StatusBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
              If every session on the SMSC shows the same pattern, treat it as carrier-wide. If only one does,
              the fault is session-specific.
            </p>
          </Dialog>

          <Dialog
            open={summary}
            title="Diagnostic summary"
            onClose={() => setSummary(false)}
            footer={<button className="secondary-button" onClick={() => setSummary(false)}>Copy</button>}
          >
            <pre className="mono" style={{ margin: 0, padding: 14, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12.5, lineHeight: 1.7, overflow: 'auto', color: 'var(--text-strong)', whiteSpace: 'pre-wrap' }}>
{'Session ' + session.id + ' (' + session.smsc + ', ' + session.carrier + ')\n' +
 'Endpoint: ' + session.endpoint + '\n' +
 'Window: last ' + range + ' (gateway time EAT)\n' +
 'Bind state: ' + session.bind + ' · uptime ' + session.uptime + '\n' +
 'Reconnects: ' + session.reconnects + ' · enquire_link timeouts: ' + session.timeouts + ' · missed: ' + session.enquireMissed + '\n' +
 'submit_sm ' + session.submit.toLocaleString() + ' / resp ' + session.submitResp.toLocaleString() + ' · generic_nack ' + session.nack + '\n' +
 'Response latency P95: ' + session.latencyP95 + '\n' +
 'Dominant command status: ' + session.topError + '\n' +
 'Sibling sessions on the same SMSC: ' + siblings.filter((s) => s.id !== session.id).map((s) => s.id + ' (' + s.health + ', ' + s.reconnects + ' reconnects)').join(', ')}
            </pre>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 12 }}>
              Contains no credentials. Safe to send to a carrier NOC.
            </p>
          </Dialog>
        </>
      ) : null}
    </>
  );
}
