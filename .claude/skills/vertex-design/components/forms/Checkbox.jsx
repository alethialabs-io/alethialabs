import * as React from "react";

const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Checkbox with label. Pass `children` as the label text. */
export function Checkbox({ className = "", children, ...props }) {
  return (
    <label className={["vx-check", className].filter(Boolean).join(" ")}>
      <input type="checkbox" {...props} />
      <span className="vx-check__box"><Check /></span>
      {children != null && <span>{children}</span>}
    </label>
  );
}

/** Radio with label. Group by shared `name`. */
export function Radio({ className = "", children, ...props }) {
  return (
    <label className={["vx-check", className].filter(Boolean).join(" ")}>
      <input type="radio" {...props} />
      <span className="vx-check__box vx-check__box--radio" />
      {children != null && <span>{children}</span>}
    </label>
  );
}
