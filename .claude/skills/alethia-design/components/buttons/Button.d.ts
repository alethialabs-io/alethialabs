import * as React from "react";

declare namespace JSX { interface Element {} }

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual treatment. `primary` is solid ink; the rest are quieter. */
  variant?: "primary" | "secondary" | "outline" | "ghost" | "link" | "destructive";
  /** Control height / padding. */
  size?: "xs" | "sm" | "md" | "lg";
  /** Square icon-only button (pass a single icon as children). */
  icon?: boolean;
  /** Render as a different element (e.g. "a"). */
  as?: any;
  children?: React.ReactNode;
}

/**
 * Primary action primitive for Alethia. Monochrome variants only.
 * @startingPoint section="Core" subtitle="Action button — 6 variants, 4 sizes" viewport="700x150"
 */
export function Button(props: ButtonProps): JSX.Element;
