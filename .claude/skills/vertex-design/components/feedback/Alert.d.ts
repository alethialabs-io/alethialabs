import * as React from "react";

declare namespace JSX { interface Element {} }

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "critical";
  title?: React.ReactNode;
  /** Leading icon node (e.g. a Lucide icon). */
  icon?: React.ReactNode;
  children?: React.ReactNode;
}
export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
}

/** Inline callout / banner. */
export function Alert(props: AlertProps): JSX.Element;
/** Indeterminate loading spinner. */
export function Spinner(props: SpinnerProps): JSX.Element;
