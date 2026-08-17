import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';

/* Engineering diagnostics only. Section 1.1: configuration files are not the
   primary abstraction, so this screen is read-only, lives behind Diagnostics, and
   points every change back at the operational object that owns it. */
const DOLLAR = String.fromCharCode(36);
const PLACEHOLDER = (name) => DOLLAR + "{" + name + "}";

const GENERATED = [
  'group = smsc',
  'smsc = smpp',
  'smsc-id = mtn_ug_trx1',
  'host = smpp.mtn.co.ug',
  'port = 2775',
  'smsc-username = ' + PLACEHOLDER('MTN_SMPP_USER'),
  'smsc-password = ' + PLACEHOLDER('MTN_SMPP_PASS'),
  'transceiver-mode = true',
  'max-pending-submits = 10',
  'throughput = 250',
].join(String.fromCharCode(10));

const OWNERS = [
  ['smsc-id, host, port, transceiver-mode', 'SMSC record', 'Connectivity → SMSCs'],
  ['throughput, max-pending-submits', 'Capacity ceiling on the SMSC', 'Connectivity → SMSCs'],
  ['smsc-username, smsc-password', 'Secret reference resolved in the engine container', 'never edited here'],
  ['group = smsbox, sendsms-port', 'Service topology', 'System → Services'],
  ['dlr-storage', 'DLR datastore selection', 'System → Services'],
];

export function EngineConfigScreen({ onNavigate }) {
  return (
    <>
      <p className="stale-banner" style={{ color: 'var(--text)', background: 'var(--surface-2)', borderColor: 'var(--border)' }}>
        Engineering diagnostics. This is the configuration the gateway generated from your operational objects —
        read-only on purpose. Change the object, not the file.
      </p>

      <section className="split-grid">
        <Panel
          title="Generated configuration"
          subtitle="What the engine is currently running, rendered from the SMSC and service records"
          action={<StatusBadge tone="good">in sync</StatusBadge>}
        >
          <pre className="mono" style={{ margin: '16px 0 0', padding: 14, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12.5, lineHeight: 1.7, overflow: 'auto', color: 'var(--text-strong)' }}>{GENERATED}</pre>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 12 }}>
            Credentials appear only as placeholders. The values live in the engine container's environment and
            are never rendered into a file or sent to a browser.
          </p>
        </Panel>

        <Panel title="Who owns each directive" subtitle="Where to make the change instead of editing this file">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Directive</th><th>Owned by</th><th>Change it in</th></tr></thead>
              <tbody>
                {OWNERS.map(([directive, owner, where]) => (
                  <tr key={directive}>
                    <td className="mono" style={{ fontSize: 12.5 }}>{directive}</td>
                    <td style={{ color: 'var(--muted)' }}>{owner}</td>
                    <td>
                      {where === 'never edited here'
                        ? <span style={{ color: 'var(--muted)' }}>{where}</span>
                        : <button className="text-button" onClick={() => onNavigate(where.includes('SMSCs') ? '/smscs' : '/services')}>{where}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
    </>
  );
}
