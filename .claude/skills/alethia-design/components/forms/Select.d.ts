import * as React from "react";

declare namespace JSX { interface Element {} }

export interface SelectOption { value: string; label: string; }
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Convenience: pass options instead of <option> children. */
  options?: (string | SelectOption)[];
  children?: React.ReactNode;
}

/** Styled native select with chevron. */
export function Select(props: SelectProps): JSX.Element;
