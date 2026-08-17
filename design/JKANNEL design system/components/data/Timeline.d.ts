import * as React from 'react';

export interface TimelineItem {
  /** Absolute time, or "—" when the stage never happened. */
  at: string;
  label: string;
  detail: string;
  /** Latency since the previous stage, rendered as "+1.30 s". */
  latency?: string;
  /** missing draws a dashed hollow dot — the stage that should have happened and did not. */
  state?: 'ok' | 'warn' | 'error' | 'missing' | 'info';
}

/**
 * Chronological evidence rail.
 * @startingPoint section="Data" subtitle="Message lifecycle and bind history timeline" viewport="700x320"
 */
export interface TimelineProps {
  items: TimelineItem[];
  dense?: boolean;
}
export declare function Timeline(props: TimelineProps): JSX.Element;
