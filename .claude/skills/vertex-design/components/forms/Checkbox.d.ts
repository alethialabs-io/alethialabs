import * as React from "react";

declare namespace JSX { interface Element {} }

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  children?: React.ReactNode;
}
export interface RadioProps extends React.InputHTMLAttributes<HTMLInputElement> {
  children?: React.ReactNode;
}

/** Checkbox with inline label. */
export function Checkbox(props: CheckboxProps): JSX.Element;
/** Radio with inline label; group by shared `name`. */
export function Radio(props: RadioProps): JSX.Element;
