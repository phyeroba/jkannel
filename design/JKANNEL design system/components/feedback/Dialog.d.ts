import * as React from 'react';

/**
 * Modal dialog on a dim scrim.
 * @startingPoint section="Feedback" subtitle="Dialog and Ctrl-K command palette" viewport="700x300"
 */
export interface DialogProps {
  open: boolean;
  title: string;
  onClose?: () => void;
  /** Right-aligned action row. */
  footer?: React.ReactNode;
  children?: React.ReactNode;
}
export declare function Dialog(props: DialogProps): JSX.Element | null;

export interface CommandPaletteItem {
  label: string;
  /** Route the item navigates to. */
  to: string;
  /** Nav group shown right-aligned: Operations, Messaging, Insights, Platform. */
  group: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose?: () => void;
  items: CommandPaletteItem[];
  onPick?: (to: string) => void;
}
export declare function CommandPalette(props: CommandPaletteProps): JSX.Element;
