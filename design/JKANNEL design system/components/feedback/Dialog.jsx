import React from 'react';

/* Centered card on a dim scrim: 14px radius, deep shadow, Esc + backdrop close. */
export function Dialog({ open, title, onClose, footer, children }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="command-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="secondary-button" onClick={onClose}>Close</button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* The topbar search trigger + Ctrl-K palette that fronts all 33 workspaces. */
export function CommandPalette({ open, onClose, items, onPick }) {
  const [query, setQuery] = React.useState('');
  const shown = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <Dialog open={open} title="Search JKANNEL" onClose={onClose}>
      <input autoFocus placeholder="Jump to a workspace, message ID or SMSC" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="search-results">
        {shown.length ? shown.map((item) => (
          <a key={item.to} href="#" onClick={(e) => { e.preventDefault(); onPick && onPick(item.to); }}>
            {item.label}<span>{item.group}</span>
          </a>
        )) : <p className="empty-cell">No workspace matches “{query}”.</p>}
      </div>
    </Dialog>
  );
}
