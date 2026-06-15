import * as React from "react";

declare namespace JSX { interface Element {} }

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** `solid` (ink), `muted` (fill), `outline` (hairline). */
  variant?: "solid" | "muted" | "outline";
  /** Uppercase Geist Mono micro-label — for codes, versions, regions. */
  mono?: boolean;
  children?: React.ReactNode;
}

/** Compact metadata label. */
export function Badge(props: BadgeProps): JSX.Element;
