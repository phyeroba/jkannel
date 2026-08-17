import * as React from 'react';

/**
 * Titled card that every console section sits in.
 * @startingPoint section="Core" subtitle="Card surface with header and action slot" viewport="700x220"
 */
export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  title?: string;
  /** One line saying what the panel shows. */
  subtitle?: string;
  /** Right-aligned header control (link, button, range select). */
  action?: React.ReactNode;
  /** Spans the wide column of .dashboard-grid. */
  wide?: boolean;
}
export declare function Panel(props: PanelProps): JSX.Element;
