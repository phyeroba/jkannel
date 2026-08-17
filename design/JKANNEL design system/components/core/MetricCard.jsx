import React from 'react';
import { Icon } from './Icon.jsx';

/* Ported from frontend/src/components/MetricCard.vue: label + soft-tint icon
   chip, 24/700 figure, muted detail line. */
export function MetricCard({ label, value, detail, icon = 'chart', tone = 'primary', ...rest }) {
  return (
    <article className="metric-card" title={detail || undefined} {...rest}>
      <span className={tone === 'primary' ? 'metric-icon' : 'metric-icon ' + tone}>
        <Icon name={icon} size={17} />
      </span>
      <span className="metric-body">
        <strong className={typeof value === "string" && /[a-z]{4,}/i.test(value) ? "metric-word" : undefined}>{value}</strong>
        <small>{label}</small>
      </span>
    </article>
  );
}
