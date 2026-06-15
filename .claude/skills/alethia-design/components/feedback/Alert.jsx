import * as React from "react";

/** Inline alert / callout. `variant="critical"` for destructive context. */
export function Alert({ variant = "default", title, icon, className = "", children, ...props }) {
  return (
    <div className={["vx-alert", variant === "critical" ? "vx-alert--critical" : "", className].filter(Boolean).join(" ")} role="note" {...props}>
      {icon && <span className="vx-alert__icon">{icon}</span>}
      <div>
        {title && <div className="vx-alert__title">{title}</div>}
        {children && <div className="vx-alert__body">{children}</div>}
      </div>
    </div>
  );
}

/** Indeterminate loading spinner. */
export function Spinner({ size = 16, className = "", style, ...props }) {
  return (
    <span
      className={["vx-spinner", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size, ...style }}
      role="status"
      aria-label="Loading"
      {...props}
    />
  );
}
