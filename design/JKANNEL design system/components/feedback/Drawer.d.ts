import * as React from 'react';

/**
 * Half-width right-hand sheet for record detail opened from a register row.
 * @startingPoint section="Feedback" subtitle="Half-width detail sheet opened from a table row" viewport="900x520"
 */
export interface DrawerProps {
  open: boolean;
  title: string;
  /** Small caps label above the title — usually the parent object. */
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Buttons rendered in the header, left of Close. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
}
export declare function Drawer(props: DrawerProps): JSX.Element;
