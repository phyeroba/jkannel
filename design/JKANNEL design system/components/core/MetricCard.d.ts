import * as React from 'react';

/**
 * Dashboard stat tile.
 * @startingPoint section="Core" subtitle="Metric tile with tinted icon chip" viewport="700x170"
 */
export interface MetricCardProps extends React.HTMLAttributes<HTMLElement> {
  label: string;
  /** Figure, or an honest placeholder: "…", "—", "unavailable". */
  value: string | number;
  /** Longer explanation; shown as the tile's tooltip, not printed on it. */
  detail?: string;
  icon?: string;
  /** Tints the icon chip. */
  tone?: 'primary' | 'good' | 'warn' | 'bad';
}
export declare function MetricCard(props: MetricCardProps): JSX.Element;
