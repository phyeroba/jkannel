import React from 'react';
import { Dialog } from './Dialog.jsx';

/* A disruptive action is never confirmed with "Are you sure?". The dialog states
   what will be affected, captures a reason for the audit trail, and disables
   itself while the action is in flight (spec §1.1, UC-SMSC-01, §16). */
export function ConfirmAction({ open, title, verb = 'Confirm', danger, impact = [], warning, reasons, onClose, onConfirm }) {
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setReason(''); setBusy(false); } }, [open]);
  const submit = () => {
    setBusy(true);
    onConfirm(reason || (reasons && reasons[0]) || 'No reason given');
  };
  return (
    <Dialog
      open={open}
      title={title}
      onClose={busy ? undefined : onClose}
      footer={
        <button
          className={danger ? 'secondary-button danger-button' : 'primary-button'}
          disabled={busy}
          onClick={submit}
        >
          {busy ? 'Working…' : verb}
        </button>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        {warning ? (
          <p style={{ margin: 0, padding: '10px 13px', borderRadius: 8, fontSize: 12.5, color: 'var(--bad)', background: 'color-mix(in srgb, var(--bad) 10%, transparent)' }}>{warning}</p>
        ) : null}

        <div>
          <div className="t-caps" style={{ marginBottom: 8 }}>Impact</div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 }}>
            {impact.map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ color: 'var(--muted)', fontSize: 12.5 }}>{label}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-strong)' }}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>

        <label className="field" style={{ margin: 0 }}>
          <span>Reason (recorded in the audit trail)</span>
          {reasons ? (
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Select a reason…</option>
              {reasons.map((r) => <option key={r}>{r}</option>)}
            </select>
          ) : (
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Carrier throttling, cycling bind per runbook 4.2" />
          )}
        </label>
      </div>
    </Dialog>
  );
}
