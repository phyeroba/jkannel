import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { Tabs } from '../../components/navigation/Tabs.jsx';
import { Timeline } from '../../components/data/Timeline.jsx';
import { ConfirmAction } from '../../components/feedback/ConfirmAction.jsx';
import { SMSCS, PREFIX_MAP } from './estate.jsx';

/* Section 15 and UC-TST-01. Six tools; only Test SMS transmits, and it is tagged
   as operational test traffic so it can be told from production in traces and
   events. The connectivity test reports how far it actually got. */
const TOOL_TABS = [
  { id: 'connectivity', label: 'SMPP connectivity' },
  { id: 'test-sms', label: 'Test SMS' },
  { id: 'dlr', label: 'DLR lookup' },
  { id: 'encoding', label: 'Encoding analyser' },
  { id: 'number', label: 'Number lookup' },
];

export function ToolsScreen({ onNavigate }) {
  const [tab, setTab] = React.useState('connectivity');
  const [smsc, setSmsc] = React.useState('mtn_ug_trx1');
  const [probe, setProbe] = React.useState(null);
  const [dest, setDest] = React.useState('+256772000118');
  const [text, setText] = React.useState('Kamex operational test — please ignore.');
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(null);
  const [lookup, setLookup] = React.useState('');
  const [dlrResult, setDlrResult] = React.useState(null);
  const [numberResult, setNumberResult] = React.useState(null);

  const unicode = /[^\u0000-\u007F]/.test(text);
  const limit = unicode ? 70 : 160;
  const multi = text.length > limit;
  const perPart = unicode ? 67 : 153;
  const segments = multi ? Math.ceil(text.length / perPart) : 1;

  const runProbe = () => {
    const target = SMSCS.find((s) => s.id === smsc);
    setProbe(
      target.state === 'disconnected'
        ? { level: 'tcp_failed', tone: 'bad', detail: 'TCP connect to ' + target.endpoint + ' refused (errno 111). The carrier is not accepting connections from this host.' }
        : { level: 'smpp_bind', tone: 'good', detail: 'A real bind_transceiver was accepted (ESME_ROK) and released cleanly. Credentials are proven — the password was never sent to the browser.' }
    );
  };

  const send = (reason) => {
    setSent({
      id: 'kmx_test_01HXQ5T2',
      reason,
      stages: [
        { at: '01:44:02.114', label: 'accepted', detail: 'tagged as operational test traffic', state: 'ok' },
        { at: '01:44:02.140', label: 'route decision', detail: smsc + ' selected (pinned by operator)', latency: '26 ms', state: 'ok' },
        { at: '01:44:02.402', label: 'submit_sm', detail: 'sent on session TRX-01', latency: '262 ms', state: 'ok' },
        { at: '01:44:02.518', label: 'submit_sm_resp', detail: 'ESME_ROK, carrier message ID 448902-mtn', latency: '116 ms', state: 'ok' },
        { at: '01:44:06.204', label: 'DLR', detail: 'DELIVRD, err:000', latency: '3.69 s', state: 'ok' },
      ],
    });
    setPending(false);
  };

  return (
    <>
      <Tabs tabs={TOOL_TABS} value={tab} onChange={(id) => { setTab(id); setProbe(null); setSent(null); }} style={{ marginBottom: 16 }} />

      {tab === 'connectivity' ? (
        <section className="split-grid">
          <Panel title="SMPP connectivity test" subtitle="Validates reachability and, where safe, a controlled bind">
            <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
              <label className="field" style={{ margin: 0 }}>
                <span>SMSC</span>
                <select value={smsc} onChange={(e) => { setSmsc(e.target.value); setProbe(null); }}>
                  {SMSCS.map((s) => <option key={s.id}>{s.id}</option>)}
                </select>
              </label>
              <div><button className="primary-button" onClick={runProbe}>Run test</button></div>
            </div>
          </Panel>
          <Panel title="Result" subtitle="Read how far the attempt got, not just whether it passed">
            {probe ? (
              <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <StatusBadge tone={probe.tone}>{probe.level}</StatusBadge>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>{smsc}</span>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--text)', lineHeight: 1.6 }}>{probe.detail}</p>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)' }}>
                  A verification level of <span className="mono">tcp_socket</span> proves only that a socket opened.
                  Only <span className="mono">smpp_bind</span> proves the credentials.
                </p>
              </div>
            ) : <p className="chart-empty">Run the test to see its verification level.</p>}
          </Panel>
        </section>
      ) : null}

      {tab === 'test-sms' ? (
        <section className="split-grid">
          <Panel title="Test SMS" subtitle="Transmits a real message. It is tagged as test traffic and recorded in the audit trail.">
            <p className="notice" style={{ margin: '14px 0 0', color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 32%, var(--border))', background: 'color-mix(in srgb, var(--warn) 10%, var(--surface))' }}>
              This tool transmits. Everything else on this screen is non-transmitting.
            </p>
            <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
              <label className="field" style={{ margin: 0 }}>
                <span>SMSC or route</span>
                <select value={smsc} onChange={(e) => setSmsc(e.target.value)}>
                  <option value="">Let routing resolve it</option>
                  {SMSCS.map((s) => <option key={s.id}>{s.id}</option>)}
                </select>
              </label>
              <label className="field" style={{ margin: 0 }}><span>Approved test destination</span><input value={dest} onChange={(e) => setDest(e.target.value)} /></label>
              <label className="field" style={{ margin: 0 }}><span>Message</span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
              <div><button className="primary-button" onClick={() => setPending(true)}>Send test</button></div>
            </div>
          </Panel>

          <Panel title={sent ? 'Trace — ' + sent.id : 'What will be sent'} subtitle={sent ? 'Followed from submit response to final DLR' : 'Confirmed before transmission'}>
            {sent ? (
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                  <StatusBadge tone="info">test traffic</StatusBadge>
                  <StatusBadge tone="good">delivered</StatusBadge>
                </div>
                <Timeline items={sent.stages} />
                <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
                  Reason recorded: {sent.reason}. Test traffic is excluded from carrier quality figures.
                </p>
                <button className="text-button" style={{ marginTop: 8 }} onClick={() => onNavigate('/trace')}>Open in Message Trace</button>
              </div>
            ) : (
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
                {[
                  ['Destination', dest],
                  ['Route', smsc || 'resolved by routing'],
                  ['Encoding', unicode ? 'UCS-2 (70 per part)' : 'GSM-7 (160 per part)'],
                  ['Characters', String(text.length)],
                  ['Segments', String(segments)],
                  ['Tagging', 'operational test'],
                ].map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                    <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </Panel>
        </section>
      ) : null}

      {tab === 'dlr' ? (
        <section className="split-grid">
          <Panel title="DLR lookup" subtitle="Find a receipt by carrier message ID or Kamex ID">
            <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
              <label className="field" style={{ margin: 0 }}><span>Message ID</span><input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="448210-mtn or kmx_01HXQ4K2R9" /></label>
              <div><button className="primary-button" onClick={() => setDlrResult(lookup.trim() ? 'found' : 'empty')}>Look up</button></div>
            </div>
          </Panel>
          <Panel title="Receipt lifecycle" subtitle="Every receipt state the carrier reported for this message">
            {dlrResult === 'found' ? (
              <div style={{ marginTop: 16 }}>
                <Timeline items={[
                  { at: '01:41:10.884', label: 'submit_sm', detail: 'accepted for delivery', state: 'ok' },
                  { at: '01:41:11.002', label: 'submit_sm_resp', detail: 'ESME_RINVDSTADR — rejected at submission', state: 'error' },
                  { at: '—', label: 'intermediate DLR', detail: 'none: nothing was accepted for delivery', state: 'missing' },
                  { at: '—', label: 'final DLR', detail: 'none expected — the message never entered the carrier network', state: 'missing' },
                ]} />
              </div>
            ) : dlrResult === 'empty' ? (
              <p className="chart-empty">Enter an identifier to look up.</p>
            ) : <p className="chart-empty">Look up a message to see the receipts recorded against it.</p>}
          </Panel>
        </section>
      ) : null}

      {tab === 'encoding' ? (
        <section className="split-grid">
          <Panel title="Encoding and segment analyser" subtitle="What the payload will actually cost on the wire">
            <label className="field" style={{ margin: '16px 0 0' }}><span>Message</span><textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} /></label>
          </Panel>
          <Panel title="Analysis" subtitle="Recomputed as you type">
            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
              {[
                ['Alphabet', unicode ? 'UCS-2' : 'GSM-7'],
                ['Characters', String(text.length)],
                ['Single-part limit', String(limit)],
                ['Per part when split', String(perPart)],
                ['Segments', String(segments)],
                ['UDH', multi ? 'concatenation header added (6 bytes per part)' : 'none'],
              ].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                  <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
              One non-GSM character switches the whole message to UCS-2 and drops the limit to 70, which is the
              usual cause of an unexpected segment count.
            </p>
          </Panel>
        </section>
      ) : null}

      {tab === 'number' ? (
        <section className="split-grid">
          <Panel title="Number and prefix lookup" subtitle="Normalise a number and identify its network">
            <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
              <label className="field" style={{ margin: 0 }}><span>Number</span><input value={dest} onChange={(e) => setDest(e.target.value)} /></label>
              <div>
                <button className="primary-button" onClick={() => {
                  const digits = dest.replace(/[^0-9]/g, '');
                  const e164 = digits.startsWith('256') ? digits : digits.startsWith('0') ? '256' + digits.slice(1) : digits;
                  const match = PREFIX_MAP.find((p) => e164.startsWith(p.prefix));
                  setNumberResult({ e164: '+' + e164, match });
                }}>Look up</button>
              </div>
            </div>
          </Panel>
          <Panel title="Result" subtitle="Normalisation and configured network mapping">
            {numberResult ? (
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, auto) minmax(0, 1fr)', gap: '8px 16px', margin: '16px 0 0' }}>
                {[
                  ['E.164', numberResult.e164],
                  ['Country', 'Uganda (+256)'],
                  ['Prefix', numberResult.match ? numberResult.match.prefix : 'no configured prefix'],
                  ['Network', numberResult.match ? numberResult.match.carrier : 'unknown'],
                  ['Route', numberResult.match ? numberResult.match.route : 'none — would fail closed'],
                ].map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt style={{ color: 'var(--muted)', fontSize: 13.5 }}>{label}</dt>
                    <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            ) : <p className="chart-empty">Look up a number to see how the gateway would classify it.</p>}
          </Panel>
        </section>
      ) : null}

      <ConfirmAction
        open={pending}
        title="Send operational test SMS"
        verb="Send test"
        impact={[
          ['Destination', dest],
          ['Route', smsc || 'resolved by routing'],
          ['Encoding', (unicode ? 'UCS-2' : 'GSM-7') + ', ' + segments + ' segment(s)'],
          ['Charged as', 'operational test traffic, excluded from carrier quality'],
          ['Audit', 'actor, reason, target and result are recorded'],
        ]}
        onClose={() => setPending(false)}
        onConfirm={send}
      />
    </>
  );
}
