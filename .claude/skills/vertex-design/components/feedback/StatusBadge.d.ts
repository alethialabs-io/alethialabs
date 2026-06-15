import * as React from "react";

declare namespace JSX { interface Element {} }

export type VertexStatus =
  | "active" | "online" | "success"
  | "pending" | "processing" | "queued"
  | "idle" | "failed" | "destroyed" | "disabled" | "live";

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Product status; mapped onto a grayscale visual tier. */
  status?: VertexStatus;
  /** Override the label text. */
  children?: React.ReactNode;
  /** Hide text, show dot only. */
  showLabel?: boolean;
}

/**
 * Grayscale state indicator — color-free by design.
 * @startingPoint section="Feedback" subtitle="Status dots, alerts, spinner" viewport="700x150"
 */
export function StatusBadge(props: StatusBadgeProps): JSX.Element;
