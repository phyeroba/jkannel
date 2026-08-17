import React from 'react';

/* One status language for the whole console: soft-tinted pill, capitalized. */
const TONES = {
  healthy: 'good', available: 'good', running: 'good', connected: 'good', active: 'good', ok: 'good', up: 'good',
  delivered: 'info', distributed: 'info',
  checking: 'warn', unknown: 'warn', degraded: 'warn', pending: 'warn', processing: 'warn',
  failed: 'bad', offline: 'bad', critical: 'bad', disabled: 'bad', expired: 'bad',
};

export function statusTone(status) {
  return TONES[String(status).toLowerCase()] || 'bad';
}

export function StatusBadge({ children, tone, status }) {
  const resolved = tone || statusTone(status ?? children);
  return <span className={'status-badge ' + resolved}>{status ?? children}</span>;
}

export function StatusDot({ tone = 'good', status }) {
  return <span className={'status-dot ' + (status ? statusTone(status) : tone)} />;
}
