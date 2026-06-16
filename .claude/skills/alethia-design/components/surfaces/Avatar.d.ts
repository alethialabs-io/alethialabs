import * as React from "react";

declare namespace JSX { interface Element {} }

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string;
  alt?: string;
  /** Fallback initials when no `src`. */
  initials?: string;
  size?: "xs" | "sm" | "md" | "lg" | number;
  /** Rounded square instead of circle. */
  square?: boolean;
}
export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

/** Avatar with initials fallback. */
export function Avatar(props: AvatarProps): JSX.Element;
/** Hairline divider. */
export function Separator(props: SeparatorProps): JSX.Element;
