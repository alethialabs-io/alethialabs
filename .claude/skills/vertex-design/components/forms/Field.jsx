import * as React from "react";

/** Vertical field wrapper: label + control + hint, gap-spaced. */
export function Field({ className = "", children, ...props }) {
  return (
    <div className={["vx-field", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </div>
  );
}

/** Form label. */
export function Label({ className = "", children, ...props }) {
  return (
    <label className={["vx-label", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </label>
  );
}

/** Secondary helper text under a control. */
export function Hint({ className = "", children, ...props }) {
  return (
    <p className={["vx-hint", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </p>
  );
}
