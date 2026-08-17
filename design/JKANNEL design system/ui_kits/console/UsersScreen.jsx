import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { Tabs } from '../../components/navigation/Tabs.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { PageAction } from './AppShell.jsx';

/* Section 1.2: the five operational personas, and the privilege each carries.
   Operators still need access administration, so this stays — but it is scoped to
   operational privileges, not customer or commercial ones. */
const USERS = [
  { username: 'operator', persona: 'NOC Operator', status: 'active', privileges: 'read; reconnect/resume; acknowledge alerts', lastSeen: '01:41:12' },
  { username: 'eng.nakato', persona: 'Messaging Engineer', status: 'active', privileges: 'deep diagnostics; tests; route/failover controls', lastSeen: '01:20:44' },
  { username: 'eng.okello', persona: 'Messaging Engineer', status: 'active', privileges: 'deep diagnostics; tests; route/failover controls', lastSeen: '2026-08-14 22:41' },
  { username: 'admin.mugisha', persona: 'Gateway Administrator', status: 'active', privileges: 'SMSC metadata; service actions; thresholds', lastSeen: '00:52:07' },
  { username: 'support.aine', persona: 'Support Engineer', status: 'active', privileges: 'message trace; DLR and error lookup', lastSeen: '2026-08-14 18:04' },
  { username: 'audit.ext', persona: 'Auditor / Read-only', status: 'active', privileges: 'read-only dashboards, events and audit trail', lastSeen: '2026-08-13 09:12' },
  { username: 'contractor.tmp', persona: 'Support Engineer', status: 'disabled', privileges: 'access revoked', lastSeen: '2026-08-10 14:38' },
];

const PERSONAS = [
  { name: 'NOC Operator', goals: 'Detect outages, monitor queues and TPS, acknowledge alerts, perform approved recovery actions', privileges: 'Read operational data; reconnect and resume; acknowledge alerts' },
  { name: 'Messaging Engineer', goals: 'Troubleshoot SMPP, routing, DLR and carrier behaviour', privileges: 'Deep diagnostics; tests; route and failover controls' },
  { name: 'Gateway Administrator', goals: 'Manage operational connectivity objects and service controls', privileges: 'Create and update SMSC metadata; service actions; thresholds' },
  { name: 'Support Engineer', goals: 'Trace individual messages and explain failures', privileges: 'Message trace; DLR and error lookup; logs' },
  { name: 'Auditor / Read-only', goals: 'Review availability, incidents and actions', privileges: 'Read-only dashboards, events and audit trail' },
];

const CAPABILITIES = [
  { capability: 'View dashboards and traffic', roles: ['NOC Operator', 'Messaging Engineer', 'Gateway Administrator', 'Support Engineer', 'Auditor / Read-only'] },
  { capability: 'Acknowledge alerts', roles: ['NOC Operator', 'Messaging Engineer', 'Gateway Administrator'] },
  { capability: 'Reconnect an SMSC', roles: ['NOC Operator', 'Messaging Engineer', 'Gateway Administrator'] },
  { capability: 'Suspend or resume traffic', roles: ['Messaging Engineer', 'Gateway Administrator'] },
  { capability: 'Fail a route over manually', roles: ['Messaging Engineer', 'Gateway Administrator'] },
  { capability: 'Restart a service', roles: ['Gateway Administrator'] },
  { capability: 'Send a test SMS', roles: ['Messaging Engineer'] },
  { capability: 'Trace a message', roles: ['Messaging Engineer', 'Support Engineer'] },
  { capability: 'Read the audit trail', roles: ['Gateway Administrator', 'Auditor / Read-only'] },
];

const ROLE_COLUMNS = ['NOC Operator', 'Messaging Engineer', 'Gateway Administrator', 'Support Engineer', 'Auditor / Read-only'];

const USER_TABS = [
  { id: 'users', label: 'Users', count: USERS.length },
  { id: 'personas', label: 'Roles', count: PERSONAS.length },
  { id: 'matrix', label: 'Capability matrix' },
];

export function UsersScreen() {
  const [tab, setTab] = React.useState('users');
  const [selected, setSelected] = React.useState(null);

  return (
    <>
      {tab === 'users' ? (
        <PageAction>
          <button className="primary-button">Add user</button>
        </PageAction>
      ) : null}

      <Tabs tabs={USER_TABS} value={tab} onChange={setTab} style={{ marginBottom: 16 }} />

      {tab === 'users' ? (
        <Panel
          title="Users"
          subtitle="Operational access only — customer accounts and commercial credentials live in the CPaaS console"
        >
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Privileges</th><th style={{ textAlign: 'right' }}>Last seen</th></tr></thead>
              <tbody>
                {USERS.map((u) => (
                  <tr key={u.username} className="selectable" onClick={() => setSelected(u)}>
                    <td className="mono">{u.username}</td>
                    <td>{u.persona}</td>
                    <td><StatusBadge tone={u.status === 'active' ? 'good' : 'muted'}>{u.status}</StatusBadge></td>
                    <td style={{ color: 'var(--muted)' }}>{u.privileges}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{u.lastSeen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {tab === 'personas' ? (
        <Panel title="Roles" subtitle="The five operational personas this console is designed around">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Role</th><th>Primary goals</th><th>Typical privileges</th></tr></thead>
              <tbody>
                {PERSONAS.map((p) => (
                  <tr key={p.name}>
                    <td><strong style={{ color: 'var(--text-strong)' }}>{p.name}</strong></td>
                    <td style={{ color: 'var(--muted)' }}>{p.goals}</td>
                    <td style={{ color: 'var(--muted)' }}>{p.privileges}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {tab === 'matrix' ? (
        <Panel title="Capability matrix" subtitle="Which role may perform each operational action">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  {ROLE_COLUMNS.map((r) => <th key={r} style={{ textAlign: 'center' }}>{r}</th>)}
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map((c) => (
                  <tr key={c.capability}>
                    <td>{c.capability}</td>
                    {ROLE_COLUMNS.map((r) => (
                      <td key={r} style={{ textAlign: 'center', color: c.roles.includes(r) ? 'var(--good)' : 'var(--muted)' }}>
                        {c.roles.includes(r) ? 'allowed' : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
            A screen an operator cannot act on is still readable — the action is disabled with its required
            privilege named, rather than the whole workspace being hidden.
          </p>
        </Panel>
      ) : null}

      <Dialog open={Boolean(selected)} title={selected ? selected.username : ''} onClose={() => setSelected(null)}>
        {selected ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 }}>
            {[['Username', selected.username], ['Role', selected.persona], ['Status', selected.status], ['Privileges', selected.privileges], ['Last seen', selected.lastSeen]].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : null}
      </Dialog>
    </>
  );
}
