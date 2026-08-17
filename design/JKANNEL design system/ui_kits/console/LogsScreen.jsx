import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { StatusBadge } from '../../components/core/StatusBadge.jsx';
import { FilterSelect } from '../../components/forms/Field.jsx';

/* Section 12.2: live tail with pause, component and severity filters, a context
   window around a selected event, and an explicit retention boundary. */
const LINES = [
  { at: '01:41:12.884', level: 'warn', component: 'bearerbox', object: 'mtn_ug_trx1', correlation: 'c-8f14e45f', message: 'SMPP[mtn_ug_trx1]: throttled, backing off 200ms' },
  { at: '01:41:11.002', level: 'error', component: 'bearerbox', object: 'TRX-01', correlation: 'c-8f14e45f', message: 'SMPP[mtn_ug_trx1]: submit_sm_resp status 0x0000000B for message kmx_01HXQ4K2R9' },
  { at: '01:41:10.884', level: 'info', component: 'bearerbox', object: 'TRX-01', correlation: 'c-8f14e45f', message: 'SMPP[mtn_ug_trx1]: submit_sm sent, sequence 884102' },
  { at: '01:40:02.114', level: 'warn', component: 'sqlbox', object: 'q-mtn-trx1', correlation: 'c-8f14e45f', message: 'queue depth 1004 crossed threshold 1000, growth +24/s' },
  { at: '01:33:02.640', level: 'error', component: 'bearerbox', object: 'TRX-02', correlation: 'c-2b6b8d0c', message: 'SMPP[mtn_ug_trx1]: bind failed, status 0x00000005 (ESME_RALYBND)' },
  { at: '01:19:58.221', level: 'error', component: 'bearerbox', object: 'utl_ug_trx', correlation: 'c-ea1e4d54', message: 'SMPP[utl_ug_trx]: 6 missed enquire_link responses, closing session' },
  { at: '01:19:31.008', level: 'warn', component: 'bearerbox', object: 'utl_ug_trx', correlation: 'c-ea1e4d54', message: 'SMPP[utl_ug_trx]: enquire_link timeout after 5000ms' },
  { at: '00:12:31.442', level: 'warn', component: 'metrics-collector', object: 'smile_ug_tx', correlation: 'c-45fea1e4', message: 'scrape failed: context deadline exceeded — marking health unknown' },
];

export function LogsScreen() {
  const [paused, setPaused] = React.useState(false);
  const [level, setLevel] = React.useState('any');
  const [component, setComponent] = React.useState('any');
  const [query, setQuery] = React.useState('');
  const [context, setContext] = React.useState(null);

  const rows = LINES.filter((l) =>
    (level === 'any' || l.level === level) &&
    (component === 'any' || l.component === component) &&
    (!query.trim() || (l.message + l.object + l.correlation).toLowerCase().includes(query.trim().toLowerCase()))
  );
  const shown = context
    ? LINES.filter((l) => l.correlation === context)
    : rows;

  return (
    <Panel
      title="Logs"
      subtitle={paused ? 'Tail paused — nothing is scrolling while you read' : 'Live tail, newest first'}
      action={
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FilterSelect label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
            {['any', 'error', 'warn', 'info', 'debug'].map((l) => <option key={l}>{l}</option>)}
          </FilterSelect>
          <FilterSelect label="Component" value={component} onChange={(e) => setComponent(e.target.value)}>
            {['any', 'bearerbox', 'smsbox', 'sqlbox', 'metrics-collector'].map((c) => <option key={c}>{c}</option>)}
          </FilterSelect>
          <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => setPaused(!paused)}>
            {paused ? 'Resume tail' : 'Pause tail'}
          </button>
        </span>
      }
    >
      <div className="grid-toolbar" style={{ marginTop: 14 }}>
        <label className="filter-search" style={{ flex: '1 1 260px' }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search message, object, correlation ID, message ID or MSISDN" />
        </label>
        {context ? (
          <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => setContext(null)}>Leave context window</button>
        ) : null}
      </div>

      {context ? (
        <p className="notice" style={{ margin: '0 0 14px' }}>
          Context window around correlation <span className="mono">{context}</span> — every line sharing that ID,
          in order, rather than you hunting timestamps.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Level</th><th>Component</th><th>Object</th><th>Line</th><th>Context</th></tr></thead>
          <tbody>
            {shown.length ? shown.map((l) => (
              <tr key={l.at}>
                <td className="mono">{l.at}</td>
                <td><StatusBadge tone={l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : 'info'}>{l.level}</StatusBadge></td>
                <td className="mono" style={{ fontSize: 12.5 }}>{l.component}</td>
                <td className="mono" style={{ fontSize: 12.5 }}>{l.object}</td>
                <td className="mono" style={{ fontSize: 12.5, color: 'var(--text-strong)' }}>{l.message}</td>
                <td className="row-actions">
                  <button className="secondary-button" style={{ padding: '6px 10px', fontSize: 13 }} onClick={() => setContext(l.correlation)}>Around this</button>
                </td>
              </tr>
            )) : <tr><td className="empty-cell" colSpan={6}>No lines match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 14 }}>
        Retention: 7 days searchable here, 30 days in the centralised store. Older lines are not available from
        this screen and are not silently omitted — a search outside the window says so.
      </p>
    </Panel>
  );
}
