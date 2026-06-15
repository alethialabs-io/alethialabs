import * as React from "react";

/**
 * Alethia Badge — compact metadata label.
 * `mono` renders an uppercase Geist Mono micro-label, the system's
 * signature device for tags like region codes and versions.
 */
export function Badge({ variant = "muted", mono = false, className = "", children, ...props }) {
  const cls = [
    "vx-badge",
    `vx-badge--${variant}`,
    mono ? "vx-badge--mono" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...props}>
      {children}
    </span>
  );
}
