import * as React from 'react';

/**
 * Console action button.
 * @startingPoint section="Core" subtitle="Primary, secondary and danger actions" viewport="700x150"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  /** Optional leading glyph name from the JKANNEL icon set. */
  icon?: string;
}
export declare function Button(props: ButtonProps): JSX.Element;

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  /** Required accessible label — icon buttons carry no text. */
  label: string;
  size?: number;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
