import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';
import { PageAction } from './AppShell.jsx';
import { Dialog } from '../../components/feedback/Dialog.jsx';
import { Field } from '../../components/forms/Field.jsx';
import { SMSCS, CARRIERS, healthTone } from './estate.jsx';

/* Section 4.2. The register is a plain list — filterable by country/territory,
   carrier and state so it stays navigable as the estate grows past one market.
   Everything about one connection, including its controlled actions, lives on
   its own page at /smscs/<id>. */
const SMSC_STATE_ORDER = { disconnected: 0, degraded: 1, suspended: 2, connected: 3 };

export function SmscsScreen({ onNavigate }) {
  const [query, setQuery] = React.useState('');
  const [country, setCountry] = React.useState('any');
  const [carrier, setCarrier] = React.useState('any');
  const [state, setState] = React.useState('any');
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState({ id: '', carrierId: CARRIERS[0].id, protocol: 'SMPP 3.4', host: '', port: '2775', bind: 'transceiver', systemId: '', capacity: '100', windowSize: '10' });
  const [created, setCreated] = React.useState('');

  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  const carrierOf = CARRIERS.find((c) => c.id === draft.carrierId);
  const complete = draft.id.trim() && draft.host.trim() && draft.systemId.trim();

  const create = () => {
    SMSCS.push({
      id: draft.id.trim(), country: carrierOf.country, cc: carrierOf.cc,
      carrier: carrierOf.name, carrierId: carrierOf.id, protocol: draft.protocol,
      state: 'suspended', sessionsUp: 0, sessionsTotal: 0, tpsOut: 0, tpsIn: 0,
      capacity: Number(draft.capacity) || 0, queue: 0, queueAge: '—',
      delivery: null, dlrLatency: '—', lastEvent: 'created by operator', suspended: true,
    });
    setCreated(draft.id.trim() + ' created for ' + carrierOf.name + ' (' + carrierOf.country + '), suspended and unbound. Open it to bind once the carrier has whitelisted this gateway.');
    setAdding(false);
  };

  const countries = ['any', ...new Set(SMSCS.map((s) => s.country))];
  const carriers = ['any', ...new Set(SMSCS.filter((s) => country === 'any' || s.country === country).map((s) => s.carrier))];

  const rows = SMSCS
    .filter((s) =>
      (country === 'any' || s.country === country) &&
      (carrier === 'any' || s.carrier === carrier) &&
      (state === 'any' || s.state === state) &&
      (query === '' || (s.id + ' ' + s.carrier + ' ' + s.country).toLowerCase().includes(query.toLowerCase()))
    )
    .slice()
    .sort((a, b) => SMSC_STATE_ORDER[a.state] - SMSC_STATE_ORDER[b.state] || b.tpsOut - a.tpsOut);

  const byCountry = countries.slice(1).map((c) => {
    const list = SMSCS.filter((s) => s.country === c);
    return {
      country: c,
      cc: list[0].cc,
      total: list.length,
      down: list.filter((s) => s.state !== 'connected').length,
      queue: list.reduce((n, s) => n + s.queue, 0),
    };
  });

  return (
    <>
      <PageAction>
        <button className="primary-button" onClick={() => setAdding(true)}>Add SMSC</button>
      </PageAction>

      {created ? <p className="notice" style={{ marginBottom: 14 }}>{created}</p> : null}

      <section className="grid-toolbar" style={{ marginBottom: 14 }}>
        {byCountry.map((c) => (
          <button
            key={c.country}
            className={'chip' + (country === c.country ? ' chip-active' : '')}
            onClick={() => { setCountry(country === c.country ? 'any' : c.country); setCarrier('any'); }}
          >
            <strong>{c.cc}</strong> {c.country}
            <span style={{ color: c.down ? 'var(--warn)' : 'var(--muted)' }}>
              {c.total} SMSC{c.total === 1 ? '' : 's'}{c.down ? ' · ' + c.down + ' not connected' : ''}
            </span>
          </button>
        ))}
      </section>

      <Panel
        title="SMSCs"
        subtitle="Carrier-facing connections. Operator-suspended and carrier-disconnected are distinct states."
        action={
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="filter-search" style={{ width: 230 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search SMSC, carrier or country"
                style={{ padding: '8px 12px' }}
              />
            </span>
            <FilterSelect label="Country" value={country} onChange={(e) => { setCountry(e.target.value); setCarrier('any'); }}>
              {countries.map((c) => <option key={c}>{c}</option>)}
            </FilterSelect>
            <FilterSelect label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
              {carriers.map((c) => <option key={c}>{c}</option>)}
            </FilterSelect>
            <FilterSelect label="State" value={state} onChange={(e) => setState(e.target.value)}>
              {['any', 'connected', 'degraded', 'disconnected', 'suspended'].map((s) => <option key={s}>{s}</option>)}
            </FilterSelect>
          </span>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SMSC</th><th>Country</th><th>Carrier</th><th>Protocol</th><th>State</th><th>Sessions</th>
                <th style={{ textAlign: 'right' }}>TPS out</th><th style={{ textAlign: 'right' }}>TPS in</th>
                <th style={{ textAlign: 'right' }}>Capacity</th><th style={{ textAlign: 'right' }}>Queue</th>
                <th style={{ textAlign: 'right' }}>Oldest</th><th style={{ textAlign: 'right' }}>DLR</th><th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((s) => (
                <tr key={s.id} className="selectable" onClick={() => onNavigate('/smscs/' + s.id)}>
                  <td className="mono">{s.id}</td>
                  <td>
                    {s.country}
                    <span className="row-id">{s.cc}</span>
                  </td>
                  <td>
                    <button className="text-button" onClick={(e) => { e.stopPropagation(); onNavigate('/carriers/' + s.carrierId); }}>{s.carrier}</button>
                  </td>
                  <td className="mono" style={{ fontSize: 13.5 }}>{s.protocol}</td>
                  <td><StatusBadge tone={healthTone(s.state)}>{s.state}</StatusBadge></td>
                  <td className="figures">{s.sessionsUp} / {s.sessionsTotal}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.tpsOut}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.tpsIn}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{Math.round((s.tpsOut / s.capacity) * 100)}% of {s.capacity}</td>
                  <td className="figures" style={{ textAlign: 'right' }}>{s.queue.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.queueAge}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.delivery === null ? 'unknown' : s.delivery + '% / ' + s.dlrLatency}</td>
                  <td className="mono" style={{ fontSize: 13.5 }}>{s.lastEvent}</td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={13}>No SMSC matches this filter.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span>{rows.length} of {SMSCS.length} connections{country === 'any' ? ' across ' + byCountry.length + ' countries' : ' in ' + country}</span>
          <span>Ordered by state, then traffic. Open a connection for its sessions, queue and controls.</span>
        </div>
      </Panel>

      <Dialog
        open={adding}
        title="Add SMSC"
        onClose={() => setAdding(false)}
        footer={
          <>
            <button className="secondary-button" onClick={() => setAdding(false)}>Cancel</button>
            <button className="primary-button" disabled={!complete} onClick={create}>Create suspended</button>
          </>
        }
      >
        <p style={{ color: 'var(--muted)', margin: '0 0 16px' }}>
          A new connection is created suspended and unbound, so nothing is submitted to the carrier
          until an operator binds it. The password is written straight to the engine keystore and is
          never displayed again.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
          <Field label="SMSC identifier" hint="lowercase, carrier and bind, e.g. mtn_ug_trx3">
            <input value={draft.id} onChange={set('id')} placeholder="mtn_ug_trx3" />
          </Field>
          <Field label="Carrier">
            <select value={draft.carrierId} onChange={set('carrierId')}>
              {CARRIERS.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.country}</option>)}
            </select>
          </Field>
          <Field label="Host">
            <input value={draft.host} onChange={set('host')} placeholder="smpp.carrier.co.ug" />
          </Field>
          <Field label="Port">
            <input value={draft.port} onChange={set('port')} />
          </Field>
          <Field label="Bind type">
            <select value={draft.bind} onChange={set('bind')}>
              {['transceiver', 'transmitter', 'receiver'].map((b) => <option key={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Protocol">
            <select value={draft.protocol} onChange={set('protocol')}>
              {['SMPP 3.4', 'SMPP 5.0'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="system_id">
            <input value={draft.systemId} onChange={set('systemId')} placeholder="issued by the carrier" />
          </Field>
          <Field label="Password">
            <input type="password" placeholder="stored in the engine keystore" />
          </Field>
          <Field label="TPS ceiling" hint="the rate the carrier has agreed to accept">
            <input value={draft.capacity} onChange={set('capacity')} />
          </Field>
          <Field label="Window size">
            <input value={draft.windowSize} onChange={set('windowSize')} />
          </Field>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>
          Creating this connection is recorded in the audit trail against your account.
          Routing to it must be added separately on Carrier Routes.
        </p>
      </Dialog>
    </>
  );
}
