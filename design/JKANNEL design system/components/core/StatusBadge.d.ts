import * as React from 'react';

/**
 * Status pill — the console's single status language.
 * @startingPoint section="Core" subtitle="Status pills and dots across tones" viewport="700x150"
 */
export interface StatusBadgeProps {
  /** Raw state string; the tone is derived from it. */
  status?: string;
  /** Override the derived tone. */
  tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted';
  children?: React.ReactNode;
}
export declare function StatusBadge(props: StatusBadgeProps): JSX.Element;

export interface StatusDotProps {
  tone?: 'good' | 'warn' | 'bad';
  status?: string;
}
export declare function StatusDot(props: StatusDotProps): JSX.Element;

/** Maps a state string to a tone, as OperationsOverview.vue does. */
export declare function statusTone(status: string): 'good' | 'warn' | 'bad';
