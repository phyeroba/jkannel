import React from 'react';

export function Tabs({ tabs, value, onChange, style }) {
  return (
    <div className="range-select" role="tablist" style={style}>
      {tabs.map((tab) => {
        const id = typeof tab === 'string' ? tab : tab.id;
        const label = typeof tab === 'string' ? tab : tab.label;
        const count = typeof tab === 'string' ? null : tab.count;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={value === id}
            className={value === id ? 'range-button active' : 'range-button'}
            onClick={() => onChange(id)}
          >
            {label}
            {count != null ? <span className="figures" style={{ marginLeft: 6, opacity: 0.65 }}>{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
