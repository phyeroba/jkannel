import * as React from 'react';

/**
 * Impact-first confirmation for a disruptive operational action.
 * @startingPoint section="Feedback" subtitle="Confirmation stating impact and capturing a reason" viewport="700x420"
 */
export interface ConfirmActionProps {
  open: boolean;
  title: string;
  /** Label on the committing button. Defaults to "Confirm". */
  verb?: string;
  /** Renders the committing button in the danger treatment. */
  danger?: boolean;
  /** Facts the operator needs before committing: [label, value] pairs. */
  impact?: Array<[string, string]>;
  /** Red banner for a blocking or high-risk condition. */
  warning?: string;
  /** Offer a fixed reason list instead of free text. */
  reasons?: string[];
  onClose: () => void;
  /** Receives the captured reason string. */
  onConfirm: (reason: string) => void;
}
export declare function ConfirmAction(props: ConfirmActionProps): JSX.Element;
