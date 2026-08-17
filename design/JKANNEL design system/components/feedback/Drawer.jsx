import React from 'react';

/* Right-hand sheet at half the viewport width, used for record detail opened
   from a register row: the list stays in place behind the scrim so the operator
   keeps their position in the table. Esc and backdrop close it. */
export function Drawer({ open, title, subtitle, eyebrow, actions, footer, onClose, children }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div style={{ minWidth: 0 }}>
            {eyebrow ? <div className="t-caps" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className="drawer-head-actions">
            {actions}
            <button className="secondary-button" onClick={onClose} aria-label="Close">Close</button>
          </div>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>
  );
}
