import React from 'react';

/* Sequence is read, not inferred. Used for bind history, message lifecycle and
   alert lifecycle: a rail of dots with a time, a label and its evidence. */
const TIMELINE_TONES = { ok: 'var(--good)', warn: 'var(--warn)', error: 'var(--bad)', missing: 'var(--muted)', info: 'var(--info)' };

export function Timeline({ items, dense }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: dense ? 10 : 14 }}>
      {items.map((item, i) => (
        <li key={item.at + item.label + i} style={{ display: 'grid', gridTemplateColumns: '84px 14px minmax(0, 1fr)', gap: 10, alignItems: 'start' }}>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', paddingTop: 1 }}>{item.at}</span>
          <span style={{ display: 'grid', justifyItems: 'center', gap: 2, paddingTop: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: TIMELINE_TONES[item.state] || 'var(--brand)', outline: item.state === 'missing' ? '1px dashed var(--muted)' : 'none', outlineOffset: 2 }} />
            {i < items.length - 1 ? <span style={{ width: 1, height: dense ? 18 : 26, background: 'var(--border)' }} /> : null}
          </span>
          <span>
            <strong style={{ display: 'block', fontSize: 13, color: 'var(--text-strong)' }}>{item.label}</strong>
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{item.detail}</span>
            {item.latency ? <span className="mono" style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>+{item.latency}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
