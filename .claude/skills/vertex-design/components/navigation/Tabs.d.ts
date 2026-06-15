import * as React from "react";

declare namespace JSX { interface Element {} }

export interface TabItem { id: string; label: React.ReactNode; }
export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Tab list — strings or `{id,label}`. */
  tabs?: (string | TabItem)[];
  /** Currently selected tab id (controlled). */
  value?: string;
  /** Called with the next tab id. */
  onValueChange?: (id: string) => void;
  /** `underline` rail (default) or inset `pill` group. */
  variant?: "underline" | "pill";
}

/**
 * Controlled tab navigation.
 * @startingPoint section="Navigation" subtitle="Underline rail + pill group" viewport="700x150"
 */
export function Tabs(props: TabsProps): JSX.Element;
