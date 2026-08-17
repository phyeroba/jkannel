import * as React from 'react';

/**
 * Labelled form control.
 * @startingPoint section="Forms" subtitle="Text, password and filter controls" viewport="700x260"
 */
export interface FieldProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  label: string;
  hint?: string;
  children?: React.ReactNode;
}
export declare function Field(props: FieldProps): JSX.Element;

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}
export declare function TextInput(props: TextInputProps): JSX.Element;

export interface PasswordInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}
/** Password field with the console's reveal-once eye toggle. */
export declare function PasswordInput(props: PasswordInputProps): JSX.Element;

export interface FilterSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Muted 12px caption sitting left of the control. */
  label: string;
}
export declare function FilterSelect(props: FilterSelectProps): JSX.Element;
